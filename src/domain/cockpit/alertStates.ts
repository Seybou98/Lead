// État des alertes du cockpit manager (§12.6, §12.8). Une alerte est DÉRIVÉE de l'état du lead : elle disparaît quand la
// situation est corrigée. Deux exceptions décidées par un manager, tracées et portées par le lead :
//   - la CLÔTURE avec un motif obligatoire (la situation n'est pas corrigée, le manager la déclare traitée) ;
//   - le REPORT, quand la règle l'autorise : l'alerte revient seule à l'échéance.
// Une consultation ne retire jamais une alerte. Fonctions pures, partagées par l'écran et le serveur.

export const ALERT_KEYS = ['sla', 'callback', 'docs', 'sale'] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];

export const ALERT_LABELS: Record<AlertKey, string> = {
  sla: 'Lead en danger (SLA)',
  callback: 'Rappel en retard',
  docs: 'Documents bloqués',
  sale: 'Vente à sécuriser',
};

/**
 * Un lead neuf dont le SLA est dépassé se traite ou se réattribue : l'alerte ne se reporte pas (P0). Rappels, documents
 * et ventes à sécuriser peuvent attendre un peu.
 */
export const POSTPONABLE: Record<AlertKey, boolean> = { sla: false, callback: true, docs: true, sale: true };

export const POSTPONE_CHOICES = [
  { key: '30m', label: '30 minutes', ms: 30 * 60_000 },
  { key: '2h', label: '2 heures', ms: 2 * 3_600_000 },
  { key: '1d', label: '1 jour', ms: 24 * 3_600_000 },
] as const;
export type PostponeKey = (typeof POSTPONE_CHOICES)[number]['key'];

export interface AlertClosure {
  /** Début de la situation au moment de la clôture : une situation plus récente est une NOUVELLE alerte. */
  sinceMs: number;
  code: string;
  label: string;
  comment: string;
  byId: string;
  atMs: number;
}

export interface AlertPostponement {
  sinceMs: number;
  untilMs: number;
  comment: string;
  byId: string;
  atMs: number;
}

export interface AlertState {
  closed: AlertClosure | null;
  postponed: AlertPostponement | null;
}

export type AlertStates = Partial<Record<AlertKey, AlertState>>;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Lecture tolérante du champ `cockpitAlerts` du lead : ce qui est mal formé est ignoré. */
export function parseAlertStates(raw: unknown): AlertStates {
  const out: AlertStates = {};
  const root = rec(raw);
  for (const key of ALERT_KEYS) {
    const x = rec(root[key]);
    const c = rec(x.closed);
    const p = rec(x.postponed);
    const closedAt = num(c.atMs);
    const closedSince = num(c.sinceMs);
    const postAt = num(p.atMs);
    const postSince = num(p.sinceMs);
    const until = num(p.untilMs);
    const closed: AlertClosure | null = typeof c.code === 'string' && closedAt !== null && closedSince !== null ? { sinceMs: closedSince, code: c.code, label: text(c.label, 120) || c.code, comment: text(c.comment, 400), byId: text(c.byId, 128), atMs: closedAt } : null;
    const postponed: AlertPostponement | null = postAt !== null && postSince !== null && until !== null ? { sinceMs: postSince, untilMs: until, comment: text(p.comment, 400), byId: text(p.byId, 128), atMs: postAt } : null;
    if (closed || postponed) out[key] = { closed, postponed };
  }
  return out;
}

/**
 * L'alerte est-elle retirée de la file active ? Seulement pour la situation qui existait au moment de la décision : une
 * situation qui recommence plus tard (échéance nouvelle) est une nouvelle alerte, visible.
 */
export function isAlertHidden(state: AlertState | undefined, sinceMs: number, nowMs: number): boolean {
  if (!state) return false;
  const c = state.closed;
  if (c && sinceMs <= Math.max(c.sinceMs, c.atMs)) return true;
  const p = state.postponed;
  if (p && nowMs < p.untilMs && sinceMs <= Math.max(p.sinceMs, p.atMs)) return true;
  return false;
}
