// Couche HTTP du changement de statut : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (statusHttp.test.ts).

import type { StatusResult } from './status';

export interface StatusHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface StatusHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  run: (args: { uid: string; requested: unknown }) => Promise<StatusResult>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export interface StatusHttpResponse {
  status: number;
  body: unknown;
}

const STATUS_BY_CODE = { not_found: 404, locked: 409, invalid: 422 } as const;

/**
 * 200 enregistré (ou déjà dans ce statut) · 400 demande illisible · 401 non connecté · 404 sans profil ·
 * 405 mauvaise méthode · 409 statut verrouillé (absence, manager) · 422 statut refusé · 500 erreur interne.
 */
export async function handleStatusHttp(req: StatusHttpInput, deps: StatusHttpDeps): Promise<StatusHttpResponse> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('setStatus : jeton refusé');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody ?? '');
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.status !== 'string') {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }

  try {
    // L'identité vient UNIQUEMENT du jeton : un `uid` placé dans le corps est ignoré.
    const result = await deps.run({ uid, requested: b.status });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('setStatus : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
