// Couche HTTP du hub d'intégrations : identité (jeton Firebase), forme de la demande, codes de retour. Réservé à
// l'administrateur (§24.11). Indépendante de l'hébergeur et testable seule (integrationsHubHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { JournalEntry } from '../../src/domain/integrations/hub';
import type { ConnectionTest, JournalResult, ReplayArgs, ReplayOutcome } from './integrationsHub';

export interface HubHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface HubHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  journal: () => Promise<JournalResult>;
  replay: (args: Omit<ReplayArgs, 'nowMs'>) => Promise<ReplayOutcome>;
  /** Erreurs de transmission : tout pour l'administrateur, le périmètre pour un manager. */
  errors?: (uid: string, role: 'admin' | 'manager') => Promise<{ entries: JournalEntry[]; truncated: boolean }>;
  /** Test de lecture du CRM principal (administrateur). */
  test?: () => Promise<ConnectionTest>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUS_BY_CODE = { not_found: 404, invalid: 422, already: 409, busy: 409, still_rejected: 422 } as const;

/** 200 · 400 demande illisible · 401 non connecté · 403 réservé à l'administrateur · 404 · 405 · 409 déjà repris ou en cours · 422 refus · 500. */
export async function handleHubHttp(req: HubHttpInput, deps: HubHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('hub : jeton refusé');
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
  const { action, rawLeadId, overrides } = b;
  if (action !== 'journal' && action !== 'replay' && action !== 'errors' && action !== 'test') return { status: 400, body: { ok: false, error: 'invalid_body' } };
  if (action === 'replay' && (typeof rawLeadId !== 'string' || !ID.test(rawLeadId))) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  if (action === 'replay' && overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) return { status: 400, body: { ok: false, error: 'invalid_body' } };

  try {
    const role = await deps.resolveRole(uid);
    // Le manager voit les erreurs de transmission de son périmètre ; tout le reste est réservé à l'administrateur (§24.11).
    if (action === 'errors' && (role === 'admin' || role === 'manager')) {
      if (!deps.errors) return { status: 500, body: { ok: false, error: 'internal' } };
      return { status: 200, body: { ok: true, ...(await deps.errors(uid, role)) } };
    }
    if (role !== 'admin') return { status: 403, body: { ok: false, error: 'forbidden', message: "Le hub d'intégrations est réservé à l'administrateur ; un manager voit les erreurs de transmission de son équipe." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` placé dans le corps est ignoré.
    if (action === 'test') {
      if (!deps.test) return { status: 500, body: { ok: false, error: 'internal' } };
      const t = await deps.test();
      return { status: 200, body: { ok: true, reachable: t.ok, ms: t.ms, message: t.message } };
    }
    if (action === 'errors') return { status: 403, body: { ok: false, error: 'forbidden' } };
    if (action === 'journal') return { status: 200, body: { ok: true, ...(await deps.journal()) } };
    const o = (overrides ?? {}) as Record<string, unknown>;
    const result = await deps.replay({ uid, rawLeadId: rawLeadId as string, overrides: { phone: typeof o.phone === 'string' ? o.phone : undefined, email: typeof o.email === 'string' ? o.email : undefined } });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('hub : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
