// Ma journée (fig. 4, §12.1, §25.3) : la carte « action prioritaire maintenant », la liste « Ensuite » et
// les compteurs du jour. Fonctions pures, sans Firestore. Rien n'est inventé : un compteur dont la donnée
// n'est pas encore enregistrée par le CRM n'est pas affiché (voir `buildDayStats`).

import { CLOSED_LEAD_STATUSES, PRIORITY_CLASSES, type PriorityClass } from '../enums';
import { ACTION_TYPE_LABELS } from '../labels';
import { slaAgeMs, type LeadListItem } from './leadList';

/** Nombre d'actions montrées dans « Ensuite » (§25.3 : quatre au maximum). */
export const UPCOMING_LIMIT = 4;

/** Plafond de leads au statut Nouveau par télépro (§12.1.1). */
export const NEW_LEADS_CAP = 10;

export interface DayAction {
  lead: LeadListItem;
  /** « P0 » à « P4 ». Un lead Nouveau sans action planifiée est traité comme P1 (prise en charge). */
  priority: PriorityClass;
  title: string;
  dueAtMs: number | null;
  /** Échéance dépassée (ou lead Nouveau dont le compteur tourne). */
  late: boolean;
  /** À traiter maintenant : lead Nouveau, ou échéance atteinte. Une action future ne passe pas devant. */
  ready: boolean;
  isNewLead: boolean;
}

const rankOf = (p: PriorityClass) => PRIORITY_CLASSES.indexOf(p);

/** Actions ouvertes d'un télépro : ses leads actifs, un par lead, avec leur prochaine action. */
export function buildDayActions(items: readonly LeadListItem[], uid: string, nowMs: number): DayAction[] {
  const out: DayAction[] = [];
  for (const lead of items) {
    if (lead.ownerId !== uid || lead.excluded || CLOSED_LEAD_STATUSES.includes(lead.status)) continue;
    const isNewLead = lead.status === 'new' && lead.slaStoppedAtMs === null;
    if (lead.nextAction) {
      const a = lead.nextAction;
      out.push({
        lead,
        priority: a.priority,
        title: ACTION_TYPE_LABELS[a.type] ?? a.type,
        dueAtMs: a.dueAtMs,
        late: a.dueAtMs < nowMs || (isNewLead && slaAgeMs(lead, nowMs) !== null),
        ready: isNewLead || a.dueAtMs <= nowMs,
        isNewLead,
      });
    } else if (isNewLead) {
      out.push({ lead, priority: 'P1', title: ACTION_TYPE_LABELS.take_new_lead, dueAtMs: null, late: true, ready: true, isNewLead });
    }
  }
  return out;
}

/**
 * File d'action (§12.1.1) : ce qui est à faire maintenant d'abord (un rappel promis à 15 h ne passe pas
 * devant un lead qui attend), puis la priorité métier, pas l'heure seule. À priorité égale : les leads
 * Nouveaux avant le reste (leur compteur tourne), puis l'échéance la plus proche, puis le plus ancien reçu.
 * L'ordre est déterministe : l'identifiant départage les égalités.
 */
export function sortDayActions(actions: readonly DayAction[]): DayAction[] {
  return [...actions].sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      rankOf(a.priority) - rankOf(b.priority) ||
      Number(b.isNewLead) - Number(a.isNewLead) ||
      (a.dueAtMs ?? a.lead.receivedAtMs) - (b.dueAtMs ?? b.lead.receivedAtMs) ||
      a.lead.receivedAtMs - b.lead.receivedAtMs ||
      a.lead.id.localeCompare(b.lead.id)
  );
}

export interface DayQueue {
  /** Action à traiter maintenant ; null = rien à faire. */
  current: DayAction | null;
  /** Les actions suivantes, dans l'ordre, sans permettre de contourner la priorité. */
  upcoming: DayAction[];
  /** Nombre total d'actions ouvertes (courante comprise). */
  total: number;
}

export function buildDayQueue(items: readonly LeadListItem[], uid: string, nowMs: number): DayQueue {
  const sorted = sortDayActions(buildDayActions(items, uid, nowMs));
  return { current: sorted[0] ?? null, upcoming: sorted.slice(1, 1 + UPCOMING_LIMIT), total: sorted.length };
}

// ── Compteurs ────────────────────────────────────────────────────────────────

export interface DayStats {
  /** Leads Nouveaux actuellement attribués, pour la jauge x/10. */
  newLeads: number;
  /** Leads reçus aujourd'hui (attribués au télépro). */
  receivedToday: number;
  /** Leads en attente de documents ou dont le dossier est à monter. */
  documentsInProgress: number;
  /** Leads convertis. Sans date de conversion dans la liste, c'est le total du portefeuille, non « du jour ». */
  converted: number;
  /** Rappels et relances dont l'échéance est dépassée. */
  lateActions: number;
}

const DOCUMENT_FLOW = ['awaiting_documents', 'file_ready_to_build', 'missing_info'] as const;

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/**
 * Compteurs réellement calculables aujourd'hui. Le nombre d'appels, les documents obtenus du jour et les
 * objectifs ne sont PAS ici : le CRM n'enregistre pas encore les appels, les pièces ni les objectifs. Les
 * afficher à 0 serait faux ; ils arrivent avec la qualification de fin d'appel et le lot Documents.
 */
export function buildDayStats(items: readonly LeadListItem[], uid: string, nowMs: number): DayStats {
  const mine = items.filter((l) => l.ownerId === uid && !l.excluded);
  const today = startOfDay(nowMs);
  return {
    newLeads: mine.filter((l) => l.status === 'new').length,
    receivedToday: mine.filter((l) => l.receivedAtMs >= today).length,
    documentsInProgress: mine.filter((l) => (DOCUMENT_FLOW as readonly string[]).includes(l.status)).length,
    converted: mine.filter((l) => l.status === 'converted').length,
    lateActions: buildDayActions(items, uid, nowMs).filter((a) => a.late && !a.isNewLead).length,
  };
}

/** « Bonjour Sarah » : le prénom suffit, jamais l'identifiant ni l'email. */
export function firstName(fullName: string): string {
  const n = fullName.trim();
  if (n === '' || n.includes('@')) return '';
  return n.split(/\s+/)[0];
}

/** Voyant de l'échéance dans « Ensuite » : rouge = en retard, orange = dans l'heure, vert = plus tard. */
export type DueTone = 'late' | 'soon' | 'later';

export function dueTone(a: Pick<DayAction, 'late' | 'dueAtMs'>, nowMs: number): DueTone {
  if (a.late) return 'late';
  if (a.dueAtMs !== null && a.dueAtMs - nowMs <= 60 * 60_000) return 'soon';
  return 'later';
}
