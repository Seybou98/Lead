// Cockpit Manager (§12, fig. 14) : le CRM détecte les risques, les classe et propose l'action utile. Fonctions pures,
// sans Firestore. Les chiffres des cartes viennent des MÊMES listes que celles qu'on ouvre en cliquant (critère de
// recette §12.13 : « les chiffres des cartes correspondent exactement aux listes détaillées »). Les alertes sont
// DÉRIVÉES de l'état des leads : elles disparaissent quand la situation est corrigée, jamais par simple consultation.

import { CLOSED_LEAD_STATUSES } from '../enums';
import { callbackLevel, isCallbackAction } from '../alerts/engine';
import { getSlaMs, slaAgeMs, slaLevel, type LeadListItem } from '../leads/leadList';
import { buildDayQueue } from '../leads/myDay';
import type { DistributionState, UserRow } from '../admin/userRows';
import { OPERATIONAL_STATUS_LABELS } from '../labels';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

export type Period = 'today' | 'week' | 'month';
export const PERIOD_LABELS: Record<Period, string> = { today: "Aujourd'hui", week: '7 derniers jours', month: '30 derniers jours' };

export type Severity = 'critical' | 'high' | 'watch' | 'info';
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, watch: 2, info: 3 };

/** Un lead concerné par une carte du cockpit, avec ce qui explique sa présence. */
export interface LeadIssue {
  lead: LeadListItem;
  /** Instant où le problème a commencé (échéance dépassée, SLA dépassé…) : sert au « depuis N min ». */
  sinceMs: number;
  severity: Severity;
  reason: string;
}

export interface Decision {
  id: string;
  severity: Severity;
  title: string;
  sinceMs: number | null;
  /** buffer : ouvre la file tampon · lead : panneau d'action · docs : onglet Documents de la fiche. */
  action: { label: string; kind: 'buffer' | 'lead' | 'docs' };
  leadId: string | null;
}

export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'grey';

export interface TeamRow {
  uid: string;
  name: string;
  state: { label: string; tone: Tone };
  /** Distribution de nouveaux leads : active, suspendue, en pause ou plafond atteint. */
  distribution: DistributionState;
  /** Ce que le télépro doit traiter en premier ; null si sa file est vide. */
  current: string | null;
  newLeads: number;
  cap: number;
  /** Charge hors nouveaux leads : ce que le télépro a déjà en main. */
  workload: { callbacks: number; interested: number; documents: number };
  /** Leads attribués au télépro sur la période. */
  assignedInPeriod: number;
  alert: { label: string; tone: Tone } | null;
}

export interface Cockpit {
  /** Nouveaux leads dont le SLA est dépassé ou proche (§12.6 P0). */
  danger: LeadIssue[];
  /** Rappels client en retard de plus de 5 minutes. */
  lateCallbacks: LeadIssue[];
  /** Décision à J+14, promesses échues, relances au-delà de J+5, pièces à contrôler depuis plus d'un jour. */
  blockedDocs: LeadIssue[];
  decisions: Decision[];
  team: TeamRow[];
  flow: { received: number; assigned: number; contacted: number };
  buffer: { count: number; oldestMs: number | null; leads: LeadListItem[] };
}

const nameOf = (l: LeadListItem) => l.fullName || 'Contact sans nom';

const isOpen = (l: LeadListItem) => !CLOSED_LEAD_STATUSES.includes(l.status) && !l.excluded;

export function periodStart(period: Period, nowMs: number): number {
  return period === 'today' ? startOfDay(nowMs) : period === 'week' ? nowMs - 7 * DAY : nowMs - 30 * DAY;
}

function dangerIssues(items: readonly LeadListItem[], nowMs: number): LeadIssue[] {
  const out: LeadIssue[] = [];
  for (const l of items) {
    if (!isOpen(l)) continue;
    const age = slaAgeMs(l, nowMs);
    if (age === null) continue;
    const level = slaLevel(age);
    if (level === 'ok') continue;
    const breached = level === 'breached';
    out.push({
      lead: l,
      sinceMs: (l.slaStartedAtMs ?? nowMs) + getSlaMs(),
      severity: breached ? 'critical' : 'high',
      reason: breached ? `SLA dépassé de ${Math.max(1, Math.floor((age - getSlaMs()) / MIN))} min` : 'SLA bientôt dépassé',
    });
  }
  return out.sort((a, b) => a.sinceMs - b.sinceMs);
}

function lateCallbackIssues(items: readonly LeadListItem[], nowMs: number): LeadIssue[] {
  const out: LeadIssue[] = [];
  for (const l of items) {
    if (!isOpen(l) || !isCallbackAction(l) || !l.nextAction) continue;
    const level = callbackLevel(l.nextAction.dueAtMs, nowMs);
    if (level !== 'orange' && level !== 'red') continue; // « en retard » = au moins 5 minutes après l'échéance
    out.push({
      lead: l,
      sinceMs: l.nextAction.dueAtMs,
      severity: level === 'red' ? 'critical' : 'high',
      reason: `Rappel client en retard de ${Math.floor((nowMs - l.nextAction.dueAtMs) / MIN)} min`,
    });
  }
  return out.sort((a, b) => a.sinceMs - b.sinceMs);
}

const DOC_FLOW = ['awaiting_documents', 'missing_info', 'file_ready_to_build'];

function blockedDocIssues(items: readonly LeadListItem[], nowMs: number): LeadIssue[] {
  const out: LeadIssue[] = [];
  for (const l of items) {
    if (!isOpen(l) || !DOC_FLOW.includes(l.status) || !l.docs) continue;
    const a = l.nextAction;
    const d = l.docs;
    if (a?.type === 'document_decision') {
      out.push({ lead: l, sinceMs: a.dueAtMs, severity: 'high', reason: 'Décision à prendre : documents toujours incomplets' });
    } else if (a?.type === 'promised_docs_missing' && a.dueAtMs <= nowMs) {
      out.push({ lead: l, sinceMs: a.dueAtMs, severity: 'high', reason: 'Documents promis non reçus' });
    } else if (d.toCheck > 0 && d.lastReceivedAtMs !== null && nowMs - d.lastReceivedAtMs > DAY) {
      out.push({ lead: l, sinceMs: d.lastReceivedAtMs + DAY, severity: 'watch', reason: 'Pièces reçues non contrôlées depuis plus d’un jour' });
    } else if (d.followUpCount >= 3 && d.toCheck === 0 && l.documentsState !== 'complete' && l.status !== 'file_ready_to_build') {
      out.push({ lead: l, sinceMs: a?.dueAtMs ?? d.lastRequestAtMs ?? l.receivedAtMs, severity: 'watch', reason: 'Documents toujours incomplets après plusieurs relances' });
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.sinceMs - b.sinceMs);
}

function stateOf(row: UserRow): TeamRow['state'] {
  if (!row.connected) return { label: 'Déconnecté', tone: 'grey' };
  const s = row.operationalStatus;
  if (!s) return { label: 'Connecté', tone: 'green' };
  const label = OPERATIONAL_STATUS_LABELS[s];
  if (s === 'available') return { label, tone: 'green' };
  if (s === 'paused' || s === 'absent') return { label, tone: 'grey' };
  if (s === 'unavailable') return { label, tone: 'red' };
  if (s === 'in_meeting') return { label, tone: 'amber' };
  return { label, tone: 'blue' };
}

export function buildCockpit(args: { items: readonly LeadListItem[]; rows: readonly UserRow[]; nowMs: number; period: Period }): Cockpit {
  const { items, rows, nowMs, period } = args;
  const danger = dangerIssues(items, nowMs);
  const lateCallbacks = lateCallbackIssues(items, nowMs);
  const blockedDocs = blockedDocIssues(items, nowMs);

  const bufferLeads = items.filter((l) => isOpen(l) && l.ownerId === null && (l.assignmentState === 'buffer' || l.assignmentState === 'to_assign'));
  const oldestMs = bufferLeads.length ? Math.min(...bufferLeads.map((l) => l.receivedAtMs)) : null;

  // ── Décisions à prendre : les plus graves d'abord, l'ancienneté départage ──
  const decisions: Decision[] = [];
  if (bufferLeads.length > 0) {
    const waited = nowMs - (oldestMs as number);
    decisions.push({
      id: 'buffer',
      severity: waited > 15 * MIN ? 'critical' : 'high',
      title: `Attribuer ${bufferLeads.length} lead${bufferLeads.length > 1 ? 's' : ''} en attente`,
      sinceMs: oldestMs,
      action: { label: 'Attribuer', kind: 'buffer' },
      leadId: null,
    });
  }
  for (const i of lateCallbacks) {
    decisions.push({ id: `cb:${i.lead.id}`, severity: i.severity, title: `Rappel client en retard — ${nameOf(i.lead)}`, sinceMs: i.sinceMs, action: { label: 'Intervenir', kind: 'lead' }, leadId: i.lead.id });
  }
  for (const i of danger.filter((x) => x.severity === 'critical')) {
    decisions.push({ id: `sla:${i.lead.id}`, severity: 'critical', title: `Lead hors SLA — ${nameOf(i.lead)}`, sinceMs: i.sinceMs, action: { label: 'Intervenir', kind: 'lead' }, leadId: i.lead.id });
  }
  for (const i of blockedDocs.filter((x) => x.severity === 'high')) {
    const decision = i.lead.nextAction?.type === 'document_decision';
    decisions.push({ id: `doc:${i.lead.id}`, severity: 'high', title: `${decision ? 'Décision documentaire' : 'Documents promis non reçus'} — ${nameOf(i.lead)}`, sinceMs: i.sinceMs, action: { label: decision ? 'Décider' : 'Relancer', kind: 'docs' }, leadId: i.lead.id });
  }
  decisions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.sinceMs ?? nowMs) - (b.sinceMs ?? nowMs));

  // ── Équipe en temps réel ──
  const start = periodStart(period, nowMs);
  const team: TeamRow[] = rows
    .filter((r) => r.role === 'telepro' && r.hasProfile && r.accountActive)
    .map((r) => {
      const cur = buildDayQueue(items, r.uid, nowMs).current;
      const mine = items.filter((l) => l.ownerId === r.uid && isOpen(l));
      const late = lateCallbacks.some((i) => i.lead.ownerId === r.uid);
      const breached = danger.some((i) => i.lead.ownerId === r.uid && i.severity === 'critical');
      const full = r.cap !== null && r.newLeads !== null && r.newLeads >= r.cap;
      const alert: TeamRow['alert'] = late ? { label: 'Rappel en retard', tone: 'red' } : breached ? { label: 'SLA dépassé', tone: 'red' } : full ? { label: 'Saturé', tone: 'amber' } : null;
      return {
        uid: r.uid,
        name: r.name,
        state: stateOf(r),
        distribution: r.distribution,
        current: cur ? `${cur.title} — ${nameOf(cur.lead)}` : null,
        newLeads: r.newLeads ?? 0,
        cap: r.cap ?? 0,
        workload: {
          callbacks: mine.filter((l) => l.status === 'callback').length,
          interested: mine.filter((l) => l.status === 'interested').length,
          documents: mine.filter((l) => DOC_FLOW.includes(l.status)).length,
        },
        assignedInPeriod: mine.filter((l) => l.receivedAtMs >= start).length,
        alert,
      };
    })
    .sort((a, b) => Number(b.alert?.tone === 'red') - Number(a.alert?.tone === 'red') || Number(!!b.alert) - Number(!!a.alert) || a.name.localeCompare(b.name, 'fr'));

  const inPeriod = items.filter((l) => !l.excluded && l.receivedAtMs >= start);
  return {
    danger,
    lateCallbacks,
    blockedDocs,
    decisions,
    team,
    flow: { received: inPeriod.length, assigned: inPeriod.filter((l) => l.ownerId !== null).length, contacted: inPeriod.filter((l) => l.slaStoppedAtMs !== null).length },
    buffer: { count: bufferLeads.length, oldestMs, leads: bufferLeads.sort((a, b) => a.receivedAtMs - b.receivedAtMs) },
  };
}

/** « 18 min », « 2 h », « 3 j » : durée écoulée depuis un instant. */
export function sinceLabel(fromMs: number, nowMs: number): string {
  const m = Math.max(0, Math.floor((nowMs - fromMs) / MIN));
  if (m < 1) return "moins d'une minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
}

export interface TargetChoice extends TeamRow {
  /** Meilleur choix proposé : disponible, sous son plafond, la file de nouveaux leads la moins chargée. */
  recommended: boolean;
  /** Plafond de nouveaux leads atteint : le manager peut quand même décider, mais il en est averti. */
  full: boolean;
}

/**
 * Télépros proposés pour une réattribution (§12.8) : le moteur recommande, le manager décide. Seuls les
 * disponibles sous leur plafond sont candidats à la recommandation ; les autres restent choisissables.
 */
export function targetChoices(team: readonly TeamRow[], excludeUid: string | null): TargetChoice[] {
  const list = team
    .filter((t) => t.uid !== excludeUid)
    .map((t) => ({ ...t, recommended: false, full: t.cap > 0 && t.newLeads >= t.cap }));
  const eligible = (t: TargetChoice) => t.state.tone === 'green' && !t.full;
  const best = list.filter(eligible).sort((a, b) => a.newLeads - b.newLeads || a.name.localeCompare(b.name, 'fr'))[0];
  if (best) best.recommended = true;
  return list.sort((a, b) => Number(b.recommended) - Number(a.recommended) || Number(eligible(b)) - Number(eligible(a)) || a.newLeads - b.newLeads || a.name.localeCompare(b.name, 'fr'));
}
