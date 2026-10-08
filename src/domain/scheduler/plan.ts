// Planificateur serveur (§15.1 « moteur de tâches / échéances asynchrone », §8, §24.4). Ce qui doit arriver SANS qu'un
// navigateur soit ouvert : escalades vers le manager, entrée en recyclage ou archivage, et réévaluation de la
// file tampon. Fonctions PURES : elles décrivent ce qu'il faut faire, la couche serveur (functions/src/scheduler.ts)
// l'applique. Idempotentes par construction : chaque effet a un identifiant déterministe, rejouer un passage ne
// double rien.

import type { LeadStatus } from '../enums';
import { nextWorkingTime, workingElapsedMs, type ScheduleLike } from '../engine/schedule';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Ce que le planificateur lit d'un lead. */
export interface SchedLead {
  id: string;
  fullName: string;
  status: LeadStatus;
  assignmentState: string;
  ownerId: string | null;
  managerIds: readonly string[];
  receivedAtMs: number;
  slaStartedAtMs: number | null;
  slaStoppedAtMs: number | null;
  bufferReason: string | null;
  nextAction: { type: string; dueAtMs: number; reason: string } | null;
  nr: { attempt: number; cycle: number; nextAtMs: number | null };
  campaignId: string | null;
  productCode: string | null;
  zone: string | null;
  reassignCount: number;
  lastReassignedAtMs: number | null;
}

export interface SchedulerRules {
  /** Rappel client non effectué : alerte manager après ce délai (§8.2 : +30 min). */
  callbackEscalationMin: number;
  /** SLA de prise en charge (§5.1). */
  slaMs: number;
  /** Retard critique (+10 min) : le manager est alors prévenu (§19.4). Absent : le délai du SLA. */
  criticalMs?: number;
  /** Le temps hors horaires ne compte pas dans le délai du SLA (§19.4). */
  suspendOutsideHours?: boolean;
  /** Lead non attribué : alerte manager après ce délai. */
  bufferWarnMin: number;
  /** Lead non attribué depuis aussi longtemps : anomalie (§24.4 : « un ou deux jours »). */
  bufferAnomalyHours: number;
  /** Après ce nombre de cycles NR5 sans réponse : « Injoignable / archivé » (§8.1). */
  maxRecycleCycles: number;
  schedule: ScheduleLike;
}

export const DEFAULT_SCHEDULER_RULES: SchedulerRules = {
  callbackEscalationMin: 30,
  slaMs: 5 * MIN,
  criticalMs: 10 * MIN,
  suspendOutsideHours: true,
  bufferWarnMin: 15,
  bufferAnomalyHours: 24,
  maxRecycleCycles: 3,
  schedule: { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })) },
};

// ── Escalades vers le manager ────────────────────────────────────────────────

export interface Escalation {
  /** Identifiant déterministe de la notification : le créer deux fois est sans effet. */
  id: string;
  leadId: string;
  recipientIds: string[];
  title: string;
  description: string;
  sound: 'critical' | null;
}

const CALLBACK_TYPES = ['client_callback', 'short_callback'];
const OPEN_FOR_DOCS: readonly LeadStatus[] = ['awaiting_documents', 'missing_info'];

/** Âge du lead pour le SLA : temps réel, ou temps de travail seulement si le SLA est suspendu hors horaires. */
export const slaAge = (startedAtMs: number, nowMs: number, rules: Pick<SchedulerRules, 'suspendOutsideHours' | 'schedule'>): number =>
  rules.suspendOutsideHours ? workingElapsedMs(rules.schedule, startedAtMs, nowMs) : Math.max(0, nowMs - startedAtMs);

const who = (l: SchedLead) => l.fullName || 'Contact sans nom';

export function planEscalations(leads: readonly SchedLead[], nowMs: number, rules: SchedulerRules = DEFAULT_SCHEDULER_RULES): Escalation[] {
  const out: Escalation[] = [];
  for (const l of leads) {
    if (l.managerIds.length === 0) continue; // personne à prévenir : l'écran cockpit reste la seule trace
    const to = [...l.managerIds];
    const push = (e: Omit<Escalation, 'leadId' | 'recipientIds'>) => out.push({ ...e, leadId: l.id, recipientIds: to });

    // Rappel client non effectué (§8.2). Le lead n'est PAS réattribué : le manager décide.
    if (l.status === 'callback' && l.nextAction && CALLBACK_TYPES.includes(l.nextAction.type) && nowMs - l.nextAction.dueAtMs >= rules.callbackEscalationMin * MIN) {
      push({
        id: `${l.id}_esc_cb_${l.nextAction.dueAtMs}`,
        title: 'Rappel client non effectué',
        description: `${who(l)} : rappel prévu il y a ${Math.floor((nowMs - l.nextAction.dueAtMs) / MIN)} min, toujours pas fait.`,
        sound: 'critical',
      });
    }

    // Lead non attribué : « tout lead non attribué reste visible, chronométré et réévalué ».
    if (l.ownerId === null && l.assignmentState === 'buffer') {
      const waited = nowMs - l.receivedAtMs;
      if (waited >= rules.bufferAnomalyHours * HOUR) {
        push({ id: `${l.id}_esc_buffer_anomaly`, title: 'Anomalie : lead non attribué depuis plus d’un jour', description: `${who(l)} attend une attribution depuis ${Math.floor(waited / HOUR)} h.`, sound: 'critical' });
      } else if (waited >= rules.bufferWarnMin * MIN) {
        push({ id: `${l.id}_esc_buffer_warn`, title: 'Lead non attribué', description: `${who(l)} attend un télépro depuis ${Math.floor(waited / MIN)} min.`, sound: 'critical' });
      }
      continue; // pas de seconde alerte « SLA » pour le même lead
    }

    // Nouveau lead hors SLA (§5.1) : le manager est prévenu une fois.
    if (l.status === 'new' && l.slaStartedAtMs !== null && l.slaStoppedAtMs === null) {
      const age = slaAge(l.slaStartedAtMs, nowMs, rules);
      if (age > (rules.criticalMs ?? rules.slaMs)) push({ id: `${l.id}_esc_sla`, title: 'Lead hors SLA', description: `${who(l)} n’est toujours pas pris en charge (${Math.floor(age / MIN)} min).`, sound: 'critical' });
    }

    // Documents toujours incomplets (alerte rouge J+7 §10.4) et décision J+14.
    if (OPEN_FOR_DOCS.includes(l.status) && l.nextAction && l.nextAction.dueAtMs <= nowMs) {
      if (l.nextAction.type === 'document_decision') {
        push({ id: `${l.id}_esc_docs_decision_${l.nextAction.dueAtMs}`, title: 'Décision documentaire à prendre', description: `${who(l)} : documents toujours incomplets, décision obligatoire.`, sound: null });
      } else if (l.nextAction.type === 'document_followup' && l.nextAction.reason === 'Documents toujours incomplets') {
        push({ id: `${l.id}_esc_docs_red_${l.nextAction.dueAtMs}`, title: 'Documents toujours incomplets', description: `${who(l)} : plusieurs relances restées sans effet.`, sound: null });
      }
    }
  }
  return out;
}

// ── Recyclage (§8.1) ─────────────────────────────────────────────────────────

export type RecyclePlan =
  | { kind: 'recycle'; action: { id: string; dueAtMs: number; reason: string }; cycle: number }
  | { kind: 'archive'; reason: string };

/**
 * Un lead « Injoignable — fin de cycle » dont le délai est écoulé entre en recyclage ; après le nombre de cycles
 * configuré, il est archivé (toujours consultable). L'action de recyclage est de priorité P4 : elle ne passe
 * jamais devant un nouveau lead ni un rappel, ce qui réalise « traitement en période creuse ».
 */
export function planRecycling(l: SchedLead, nowMs: number, rules: SchedulerRules = DEFAULT_SCHEDULER_RULES): RecyclePlan | null {
  if (l.status !== 'unreachable_cycle_end' || l.nr.nextAtMs === null || l.nr.nextAtMs > nowMs) return null;
  if (l.nr.cycle >= rules.maxRecycleCycles) return { kind: 'archive', reason: `Aucune réponse après ${l.nr.cycle} cycle${l.nr.cycle > 1 ? 's' : ''} d’appels.` };
  const due = nextWorkingTime(rules.schedule, nowMs) ?? nowMs;
  return { kind: 'recycle', cycle: l.nr.cycle + 1, action: { id: `${l.id}_recycle_c${l.nr.cycle + 1}`, dueAtMs: due, reason: `Recyclage — cycle ${l.nr.cycle + 1}` } };
}

// ── File tampon (§24.4) ──────────────────────────────────────────────────────

/** Motifs de mise en attente qui demandent une décision humaine : le moteur ne les contourne pas. */
const MANUAL_HOLDS = ['duplicate_review', 'campaign_not_active', 'auto_distribution_off'];

/** Lead non attribué que le moteur doit réévaluer : attente « technique » (capacité, horaires, produit, zone…). */
export const isEngineBuffered = (l: SchedLead): boolean =>
  l.ownerId === null && l.assignmentState === 'buffer' && l.status === 'new' && !(l.bufferReason !== null && MANUAL_HOLDS.includes(l.bufferReason));

// ── Réattribution au SLA (§19.4 : « +15 minutes : transfert selon la règle de campagne, si activé ») ───────────

export interface SlaReassignRule {
  autoReassign: boolean;
  reassignMin: number;
  maxReassignments: number;
}

/**
 * Un nouveau lead non pris en charge est réattribué quand le délai est atteint, si la règle est activée et que le
 * nombre maximal de réattributions n'est pas atteint. Le délai se mesure en temps de travail si le SLA est suspendu
 * hors horaires, depuis la réception pour la première réattribution, puis depuis la dernière : le nouveau
 * propriétaire dispose du même délai. Un rappel client n'est JAMAIS réattribué automatiquement (§8.2).
 */
export function dueForSlaReassign(l: SchedLead, nowMs: number, rule: SlaReassignRule, rules: Pick<SchedulerRules, 'suspendOutsideHours' | 'schedule'>): boolean {
  if (!rule.autoReassign || l.status !== 'new' || l.ownerId === null || l.slaStartedAtMs === null || l.slaStoppedAtMs !== null) return false;
  if (l.reassignCount >= rule.maxReassignments) return false;
  const reference = l.lastReassignedAtMs ?? l.slaStartedAtMs;
  return slaAge(reference, nowMs, rules) >= rule.reassignMin * MIN;
}
