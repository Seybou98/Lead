// Couche HTTP de la réattribution : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (reassignHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { ReassignArgs, ReassignOutcome } from './reassign';

export interface ReassignHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface ReassignHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<ReassignArgs, 'nowMs'>) => Promise<ReassignOutcome>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const STATUS_BY_CODE = { not_found: 404, forbidden: 403, lead_closed: 409, invalid: 422 } as const;

/**
 * 200 enregistré (ou déjà enregistré : rejeu) · 400 demande illisible · 401 non connecté · 403 sans droit ·
 * 404 lead introuvable · 405 mauvaise méthode · 409 lead clôturé · 422 saisie refusée (motif, cible) · 500.
 */
export async function handleReassignHttp(req: ReassignHttpInput, deps: ReassignHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('reassign : jeton refusé');
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
  const { leadId, targetUid, requestId, reason } = b;
  if (typeof leadId !== 'string' || !ID.test(leadId) || typeof targetUid !== 'string' || !ID.test(targetUid) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: "Votre compte n'a pas accès au CRM Leads." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` ou un `role` placé dans le corps est ignoré.
    const result = await deps.run({ uid, role, leadId, targetUid, requestId, reason });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('reassign : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
