// Couche HTTP de l'enregistrement de la qualification : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (qualificationFormHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { QualificationArgs, QualificationOutcome } from './qualificationForm';

export interface QualificationHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface QualificationHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<QualificationArgs, 'nowMs'>) => Promise<QualificationOutcome>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUS_BY_CODE = { not_found: 404, forbidden: 403, lead_closed: 409, no_form: 409, invalid: 422 } as const;

/**
 * 200 enregistré · 400 demande illisible · 401 non connecté · 403 sans droit · 404 lead introuvable · 405 mauvaise
 * méthode · 409 lead clôturé ou aucun formulaire publié · 422 réponse refusée (format, champ) · 500.
 */
export async function handleQualificationHttp(req: QualificationHttpInput, deps: QualificationHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('qualification : jeton refusé');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody ?? '');
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  const { leadId, answers, requestId } = b;
  if (typeof leadId !== 'string' || !ID.test(leadId) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: "Votre compte n'a pas accès au CRM Leads." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` ou un `role` placé dans le corps est ignoré.
    const result = await deps.run({ uid, role, leadId, answers, requestId });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('qualification : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
