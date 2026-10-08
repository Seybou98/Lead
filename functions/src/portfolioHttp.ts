// Couche HTTP des absences et des transferts de portefeuille : identité (jeton Firebase), forme de la demande, codes de
// retour. Indépendante de l'hébergeur et testable seule (portfolioHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { PortfolioResult } from './portfolio';

export type PortfolioRequest =
  | { kind: 'declare_absence'; uid: string; role: Role; requestId: string; userId: string; input: unknown }
  | { kind: 'end_absence'; uid: string; role: Role; absenceId: string }
  | { kind: 'transfer'; uid: string; role: Role; fromUid: string; batchId: string; assignments: unknown; reason: unknown; returnAtMs: number | null };

export interface PortfolioHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface PortfolioHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (req: PortfolioRequest) => Promise<PortfolioResult>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const STATUS_BY_CODE = { forbidden: 403, not_found: 404, invalid: 422, conflict: 409 } as const;

/**
 * 200 enregistré · 400 demande illisible · 401 non connecté · 403 sans droit · 404 introuvable · 405 mauvaise méthode ·
 * 409 conflit (absence qui en chevauche une autre) · 422 saisie refusée · 500 erreur interne.
 */
export async function handlePortfolioHttp(req: PortfolioHttpInput, deps: PortfolioHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('portfolio : jeton refusé');
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
  const bad = { status: 400, body: { ok: false, error: 'invalid_body' } };

  // La forme de la demande est vérifiée AVANT de toucher à la base ; l'identité et le rôle ne viennent que du jeton.
  let build: (role: Role) => PortfolioRequest;
  if (b.kind === 'declare_absence') {
    if (typeof b.userId !== 'string' || !ID.test(b.userId) || typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) return bad;
    const { userId, requestId, input } = b as { userId: string; requestId: string; input: unknown };
    build = (role) => ({ kind: 'declare_absence', uid, role, requestId, userId, input });
  } else if (b.kind === 'end_absence') {
    if (typeof b.absenceId !== 'string' || !ID.test(b.absenceId)) return bad;
    const absenceId = b.absenceId;
    build = (role) => ({ kind: 'end_absence', uid, role, absenceId });
  } else if (b.kind === 'transfer') {
    if (typeof b.fromUid !== 'string' || !ID.test(b.fromUid) || typeof b.batchId !== 'string' || !REQUEST_ID.test(b.batchId) || !Array.isArray(b.assignments)) return bad;
    if (b.returnAtMs !== undefined && b.returnAtMs !== null && (typeof b.returnAtMs !== 'number' || !Number.isFinite(b.returnAtMs))) return bad;
    const { fromUid, batchId, assignments, reason } = b as { fromUid: string; batchId: string; assignments: unknown[]; reason: unknown };
    const returnAtMs = typeof b.returnAtMs === 'number' ? b.returnAtMs : null;
    build = (role) => ({ kind: 'transfer', uid, role, fromUid, batchId, assignments, reason, returnAtMs });
  } else return bad;

  try {
    const role = await deps.resolveRole(uid);
    if (role !== 'admin' && role !== 'manager') {
      return { status: 403, body: { ok: false, error: 'forbidden', message: 'Réservé aux managers et aux administrateurs.' } };
    }
    const result = await deps.run(build(role));
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message, errors: result.errors } };
  } catch (err) {
    deps.log.error('portfolio : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
