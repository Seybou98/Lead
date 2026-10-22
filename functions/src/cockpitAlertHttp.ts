// Couche HTTP des décisions sur les alertes du cockpit : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (cockpitAlertHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import { POSTPONE_CHOICES } from '../../src/domain/cockpit/alertStates';
import { isAlertKey, type AlertAction, type AlertArgs, type AlertOutcome } from './cockpitAlert';

export interface AlertHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface AlertHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<AlertArgs, 'nowMs'>) => Promise<AlertOutcome>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUS_BY_CODE = { not_found: 404, forbidden: 403, invalid: 422 } as const;
const bad = { status: 400, body: { ok: false, error: 'invalid_body' } };

/** 200 enregistré (ou rejeu) · 400 demande illisible · 401 non connecté · 403 sans droit · 404 · 405 · 422 saisie refusée · 500. */
export async function handleAlertHttp(req: AlertHttpInput, deps: AlertHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('cockpit : jeton refusé');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody ?? '');
  } catch {
    return bad;
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad;
  const { leadId, alertKey, sinceMs, requestId, action, reasonCode, choice, comment } = b;
  if (typeof leadId !== 'string' || !ID.test(leadId) || !isAlertKey(alertKey) || typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return bad;
  if (comment !== undefined && typeof comment !== 'string') return bad;
  const note = typeof comment === 'string' ? comment : '';

  let act: AlertAction;
  if (action === 'close') {
    if (typeof reasonCode !== 'string' || !ID.test(reasonCode)) return bad;
    act = { kind: 'close', reasonCode, comment: note };
  } else if (action === 'postpone') {
    if (typeof choice !== 'string' || !POSTPONE_CHOICES.some((c) => c.key === choice)) return bad;
    act = { kind: 'postpone', choice: choice as (typeof POSTPONE_CHOICES)[number]['key'], comment: note };
  } else if (action === 'reopen') {
    act = { kind: 'reopen' };
  } else return bad;

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: "Votre compte n'a pas accès au CRM Leads." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` ou un `role` placé dans le corps est ignoré.
    const result = await deps.run({ uid, role, leadId, alertKey, sinceMs, action: act, requestId });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('cockpit : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
