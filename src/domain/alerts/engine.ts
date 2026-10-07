// Alertes du télépro (§5.1 SLA de prise en charge, §8.2 rappels clients, §12.11 sons). Fonctions pures :
// `tickAlerts` dit, à chaque seconde, quelles alertes doivent se déclencher MAINTENANT ; `buildAlertBars`
// décrit ce qui doit rester visible tant que la situation dure. Rien ici ne joue de son ni n'affiche quoi que
// ce soit : l'interface s'en charge (src/components/alerts).
//
// Règle du cahier : seul un changement de statut valide arrête les alertes. Fermer une notification ou ouvrir
// la fiche ne suffit pas : ici, tout est recalculé depuis les DONNÉES du lead, jamais depuis un clic.

import { DEFAULT_SLA_MS, slaAgeMs, slaLevel, type LeadListItem, type SlaLevel } from '../leads/leadList';

const MIN = 60_000;

/** 0 à 5 minutes : une alerte sonore chaque minute (§5.1). */
export const SLA_FIRST_INTERVAL_MS = MIN;
/** Après 5 minutes : une alerte sonore toutes les 10 minutes. */
export const SLA_LATE_INTERVAL_MS = 10 * MIN;

/** Rappel client (§8.2) : H-5 min, heure exacte, +5 min orange, +15 min rouge, +30 min alerte manager. */
export const CALLBACK_SOON_MS = 5 * MIN;
export const CALLBACK_ORANGE_MS = 5 * MIN;
export const CALLBACK_RED_MS = 15 * MIN;
export const CALLBACK_MANAGER_MS = 30 * MIN;

export type AlertSound = 'new_lead' | 'sla' | 'callback' | 'critical';

const SOUND_STRENGTH: readonly AlertSound[] = ['critical', 'new_lead', 'callback', 'sla'];

/** La plus forte de plusieurs sonneries (une seule est jouée à la fois : pas de cacophonie). */
export function strongestSound(sounds: readonly (AlertSound | null | undefined)[]): AlertSound | null {
  return SOUND_STRENGTH.find((s) => sounds.includes(s)) ?? null;
}

export type AlertKind = 'new_lead' | 'sla_reminder' | 'sla_breached' | 'callback_soon' | 'callback_due';

export interface AlertFire {
  /** Unique : sert de clé de notification à l'écran. */
  id: string;
  kind: AlertKind;
  leadId: string;
  title: string;
  description: string;
  /** Sonneries réservées à : nouveau lead, SLA dépassé, rappel dû, alerte critique (§12.11). */
  sound: AlertSound | null;
}

export interface AlertState {
  /** Par lead Nouveau : dernier déclenchement et dépassement déjà signalé. */
  sla: Record<string, { lastAt: number; breached: boolean }>;
  /** Par rappel (`leadId@échéance`) : plus haut palier déjà traité (1 bientôt, 2 dû, 3 orange, 4 rouge). */
  cb: Record<string, number>;
}

export const EMPTY_ALERT_STATE: AlertState = { sla: {}, cb: {} };

const CALLBACK_TYPES = ['client_callback', 'short_callback'];

export type CallbackLevel = 'soon' | 'due' | 'orange' | 'red';

const CALLBACK_RANK: Record<CallbackLevel, number> = { soon: 1, due: 2, orange: 3, red: 4 };

/** Palier d'un rappel : null tant qu'on est à plus de 5 minutes de l'échéance. */
export function callbackLevel(dueAtMs: number, nowMs: number): CallbackLevel | null {
  const late = nowMs - dueAtMs;
  if (late >= CALLBACK_RED_MS) return 'red';
  if (late >= CALLBACK_ORANGE_MS) return 'orange';
  if (late >= 0) return 'due';
  if (-late <= CALLBACK_SOON_MS) return 'soon';
  return null;
}

export const isCallbackAction = (l: Pick<LeadListItem, 'status' | 'nextAction'>): boolean =>
  l.status === 'callback' && l.nextAction !== null && CALLBACK_TYPES.includes(l.nextAction.type);

/** Leads Nouveaux de ce télépro dont le compteur SLA tourne. */
const slaLeads = (items: readonly LeadListItem[], uid: string, now: number) =>
  items.filter((l) => l.ownerId === uid && !l.excluded && slaAgeMs(l, now) !== null);

const callbackLeads = (items: readonly LeadListItem[], uid: string) =>
  items.filter((l) => l.ownerId === uid && !l.excluded && isCallbackAction(l));

const who = (l: LeadListItem) => l.fullName || 'Nouveau contact';
const detail = (l: LeadListItem) => [l.productCode, l.city].filter(Boolean).join(' — ');

function formatMinSec(ms: number): string {
  const t = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Alertes à déclencher à l'instant `now`, et nouvel état. Idempotent : rappelée avec le même état et la même
 * heure, elle ne déclenche rien de plus. L'état n'a besoin d'être conservé (session) que pour ne pas rejouer
 * les alertes après un rechargement de page.
 */
export function tickAlerts(prev: AlertState, items: readonly LeadListItem[], uid: string, now: number): { state: AlertState; fires: AlertFire[] } {
  const fires: AlertFire[] = [];
  const sla: AlertState['sla'] = {};
  const cb: AlertState['cb'] = {};

  // ── SLA de prise en charge (§5.1) ──
  for (const l of slaLeads(items, uid, now)) {
    const age = slaAgeMs(l, now) as number;
    const known = prev.sla[l.id];
    const overdue = age > DEFAULT_SLA_MS;

    if (!known) {
      // Lead jamais vu : arrivée (fort) ; s'il est déjà ancien (page ouverte tardivement), simple rappel.
      sla[l.id] = { lastAt: now, breached: overdue };
      fires.push(
        age <= 60_000
          ? { id: `${l.id}:new`, kind: 'new_lead', leadId: l.id, title: 'Nouveau lead', description: `${who(l)}${detail(l) ? ` — ${detail(l)}` : ''}`, sound: 'new_lead' }
          : { id: `${l.id}:seen:${now}`, kind: overdue ? 'sla_breached' : 'sla_reminder', leadId: l.id, title: overdue ? 'Lead en retard de prise en charge' : 'Lead à prendre en charge', description: `${who(l)} attend depuis ${formatMinSec(age)}`, sound: overdue ? 'critical' : 'sla' }
      );
      continue;
    }

    if (!known.breached && overdue) {
      sla[l.id] = { lastAt: now, breached: true };
      fires.push({ id: `${l.id}:breach`, kind: 'sla_breached', leadId: l.id, title: 'SLA dépassé', description: `${who(l)} — ${formatMinSec(age)} sans prise en charge`, sound: 'critical' });
      continue;
    }

    const interval = age <= DEFAULT_SLA_MS ? SLA_FIRST_INTERVAL_MS : SLA_LATE_INTERVAL_MS;
    if (now - known.lastAt >= interval) {
      sla[l.id] = { lastAt: now, breached: known.breached };
      fires.push({ id: `${l.id}:rem:${now}`, kind: 'sla_reminder', leadId: l.id, title: overdue ? 'Lead toujours en attente' : 'Lead à prendre en charge', description: `${who(l)} — ${formatMinSec(age)}`, sound: 'sla' });
    } else {
      sla[l.id] = known;
    }
  }

  // ── Rappels clients (§8.2) : une alerte par palier, une seule fois ──
  for (const l of callbackLeads(items, uid)) {
    const due = l.nextAction!.dueAtMs;
    const level = callbackLevel(due, now);
    if (level === null) continue;
    const key = `${l.id}@${due}`;
    const rank = CALLBACK_RANK[level];
    const done = prev.cb[key] ?? 0;
    cb[key] = Math.max(done, rank);
    if (rank <= done) continue;

    // Orange et rouge sont des états VISUELS (carte, barre) : pas de nouvelle sonnerie (§12.11).
    if (level === 'soon') {
      fires.push({ id: `${key}:soon`, kind: 'callback_soon', leadId: l.id, title: 'Rappel dans 5 minutes', description: `${who(l)} — ${l.nextAction!.reason}`, sound: null });
    } else if (level === 'due' || done < CALLBACK_RANK.due) {
      // Palier « dû » (ou rappel déjà échu quand on ouvre l'application) : une seule sonnerie.
      fires.push({ id: `${key}:due`, kind: 'callback_due', leadId: l.id, title: 'Rappel client à faire maintenant', description: `${who(l)} — ${l.nextAction!.reason}`, sound: 'callback' });
    }
  }

  return { state: { sla, cb }, fires };
}

// ── Ce qui reste visible tant que la situation dure ──────────────────────────

export interface NewLeadBar {
  count: number;
  /** Le plus ancien : celui qui attend le plus longtemps. */
  oldest: { id: string; name: string; ageMs: number; level: SlaLevel };
}

export interface CallbackBar {
  leadId: string;
  name: string;
  dueAtMs: number;
  level: CallbackLevel;
  reason: string;
}

export interface AlertBars {
  newLeads: NewLeadBar | null;
  /** Rappels à moins de 5 min ou échus, du plus en retard au plus lointain. */
  callbacks: CallbackBar[];
  /** Nombre d'éléments qui réclament une action (pastille de la cloche). */
  total: number;
}

export function buildAlertBars(items: readonly LeadListItem[], uid: string, now: number): AlertBars {
  const news = slaLeads(items, uid, now)
    .map((l) => ({ l, age: slaAgeMs(l, now) as number }))
    .sort((a, b) => b.age - a.age || a.l.id.localeCompare(b.l.id));

  const callbacks: CallbackBar[] = [];
  for (const l of callbackLeads(items, uid)) {
    const level = callbackLevel(l.nextAction!.dueAtMs, now);
    if (level) callbacks.push({ leadId: l.id, name: who(l), dueAtMs: l.nextAction!.dueAtMs, level, reason: l.nextAction!.reason });
  }
  callbacks.sort((a, b) => a.dueAtMs - b.dueAtMs || a.leadId.localeCompare(b.leadId));

  return {
    newLeads: news.length ? { count: news.length, oldest: { id: news[0].l.id, name: who(news[0].l), ageMs: news[0].age, level: slaLevel(news[0].age) } } : null,
    callbacks,
    total: news.length + callbacks.length,
  };
}

/** Préfixe du titre de l'onglet : le télépro voit qu'il se passe quelque chose sans regarder l'onglet. */
export function titlePrefix(bars: Pick<AlertBars, 'newLeads' | 'callbacks'>): string {
  const due = bars.callbacks.filter((c) => c.level !== 'soon').length;
  const n = (bars.newLeads?.count ?? 0) + due;
  if (n === 0) return '';
  return bars.newLeads ? `(${n}) Nouveau lead · ` : `(${n}) Rappel client · `;
}

// ── Conservation de l'état pendant la session (évite de rejouer les alertes au rechargement) ──

const MAX_ENTRIES = 300;

export function parseAlertState(raw: string | null): AlertState {
  if (!raw) return EMPTY_ALERT_STATE;
  try {
    const s = JSON.parse(raw) as Partial<AlertState> | null;
    const sla: AlertState['sla'] = {};
    const cb: AlertState['cb'] = {};
    if (s && typeof s.sla === 'object' && s.sla) {
      for (const [k, v] of Object.entries(s.sla).slice(0, MAX_ENTRIES)) {
        const x = v as { lastAt?: unknown; breached?: unknown };
        if (typeof x?.lastAt === 'number' && Number.isFinite(x.lastAt)) sla[k] = { lastAt: x.lastAt, breached: x.breached === true };
      }
    }
    if (s && typeof s.cb === 'object' && s.cb) {
      for (const [k, v] of Object.entries(s.cb).slice(0, MAX_ENTRIES)) {
        if (typeof v === 'number' && v >= 1 && v <= 4) cb[k] = v;
      }
    }
    return { sla, cb };
  } catch {
    return EMPTY_ALERT_STATE;
  }
}
