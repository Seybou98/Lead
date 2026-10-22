// Couche HTTP de l'import et de la saisie manuelle : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (importLeadsHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { ImportArgs, ImportOutcome } from './importLeads';

export interface ImportHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface ImportHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<ImportArgs, 'nowMs'>) => Promise<ImportOutcome>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const BATCH_ID = /^[A-Za-z0-9_-]{8,100}$/;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUS_BY_CODE = { forbidden: 403, invalid: 422 } as const;
export const MAX_BODY_BYTES = 200_000;

/** 200 traité (ou rejoué) · 400 demande illisible · 401 non connecté · 403 sans droit · 405 · 413 trop volumineux · 422 refus · 500. */
export async function handleImportHttp(req: ImportHttpInput, deps: ImportHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('import : jeton refusé');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  if ((req.rawBody ?? '').length > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: 'too_large' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody ?? '');
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  const { channel, sourceId, batchId, startRow, rows } = b;
  if ((channel !== 'import' && channel !== 'manual') || typeof batchId !== 'string' || !BATCH_ID.test(batchId) || !Array.isArray(rows)) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  if (sourceId !== undefined && sourceId !== null && (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId))) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  if (startRow !== undefined && (typeof startRow !== 'number' || !Number.isInteger(startRow) || startRow < 1 || startRow > 1_000_000)) return { status: 400, body: { ok: false, error: 'invalid_body' } };

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: "Votre compte n'a pas accès au CRM Leads." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` ou un `role` placé dans le corps est ignoré.
    const result = await deps.run({ uid, role, channel, sourceId: typeof sourceId === 'string' ? sourceId : null, batchId, startRow: typeof startRow === 'number' ? startRow : 2, rows });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('import : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
