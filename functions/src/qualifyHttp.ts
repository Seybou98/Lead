// Couche HTTP de la qualification de fin d'appel : identité (jeton Firebase), forme de la demande, codes de
// retour. Indépendante de l'hébergeur et testable seule (qualifyHttp.test.ts). La décision métier est dans
// src/domain/call/plan.ts ; l'écriture, dans qualify.ts.

import type { Role } from '../../src/domain/enums';
import type { CallOutcomeInput } from '../../src/domain/call/outcomes';
import type { QualifyArgs, QualifyResult } from './qualify';

export interface QualifyHttpInput {
  method: string;
  /** En-tête Authorization (« Bearer <jeton d'identité Firebase> »). */
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface QualifyHttpDeps {
  /** Vérifie le jeton et rend l'uid ; lève une erreur si le jeton est absent, invalide ou expiré. */
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<QualifyArgs, 'nowMs'>) => Promise<QualifyResult>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export interface QualifyHttpResponse {
  status: number;
  body: unknown;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const LEAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

const STATUS_BY_CODE: Record<Extract<QualifyResult, { ok: false }>['code'], number> = {
  not_found: 404,
  forbidden: 403,
  lead_closed: 409,
  unavailable: 409,
  stale: 409,
  invalid: 422,
};

/**
 * 200 enregistré (ou déjà enregistré : rejeu) · 400 demande illisible · 401 non connecté · 403 sans droit ·
 * 404 lead introuvable · 405 mauvaise méthode · 409 lead clôturé, modifié entre-temps ou indisponible ·
 * 422 saisie incomplète (les champs en cause sont dans `errors`) · 500 erreur interne.
 */
export async function handleQualifyHttp(req: QualifyHttpInput, deps: QualifyHttpDeps): Promise<QualifyHttpResponse> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('qualifyCall : jeton refusé');
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
  const { leadId, requestId, input, expectedStatus, durationSeconds, resumeStatus } = b;
  const inputObj = input as Record<string, unknown> | null;
  if (
    typeof leadId !== 'string' || !LEAD_ID.test(leadId) ||
    typeof requestId !== 'string' || !REQUEST_ID.test(requestId) ||
    !inputObj || typeof inputObj !== 'object' || Array.isArray(inputObj) || typeof inputObj.kind !== 'string'
  ) {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  if (expectedStatus !== undefined && expectedStatus !== null && typeof expectedStatus !== 'string') {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const duration = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0
    ? Math.min(Math.round(durationSeconds), 6 * 3600)
    : null;

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: 'Votre compte n\'a pas accès au CRM Leads.' } };

    const result = await deps.run({
      uid,
      role,
      leadId,
      requestId,
      expectedStatus: typeof expectedStatus === 'string' ? expectedStatus : null,
      input: inputObj as unknown as CallOutcomeInput,
      durationSeconds: duration,
      resumeStatus: typeof resumeStatus === 'string' ? resumeStatus : undefined,
    });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message, errors: result.errors } };
  } catch (err) {
    deps.log.error('qualifyCall : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
