// Pipeline et cockpit documentaire du cockpit manager (§12.9). Fonctions pures. Chaque étape et chaque vue documentaire
// donne la liste EXACTE des leads qu'elle compte (critère de recette §12.13).
//
// Ce que le modèle ne permet pas : le CRM ne garde pas la date d'entrée dans un statut. Les « entrées / sorties du jour » et
// la « durée dans l'étape » ne sont donc pas calculables ; on montre l'ancienneté depuis la réception du lead. Le taux de
// passage est un PLANCHER déduit du statut actuel (un lead sorti en « non intéressé » n'est plus compté plus haut).

import { CLOSED_LEAD_STATUSES, type LeadStatus } from '../enums';
import type { LeadListItem } from '../leads/leadList';
import type { LeadIssue } from './cockpit';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const isOpen = (l: LeadListItem) => !CLOSED_LEAD_STATUSES.includes(l.status) && !l.excluded;

// ── Pipeline ─────────────────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  { key: 'new', label: 'Nouveaux', statuses: ['new'] },
  { key: 'contact', label: 'Prise de contact', statuses: ['nr', 'callback', 'unreachable_cycle_end'] },
  { key: 'interested', label: 'Intéressés', statuses: ['interested'] },
  { key: 'documents', label: 'Documents', statuses: ['awaiting_documents', 'missing_info'] },
  { key: 'toBuild', label: 'Prêts à monter', statuses: ['file_ready_to_build'] },
  { key: 'building', label: 'Montage et validation', statuses: ['file_building', 'manager_validation', 'file_ready'] },
  { key: 'transmission', label: 'Transmission', statuses: ['transmitting', 'transmission_error'] },
  { key: 'sold', label: 'Vendus', statuses: ['converted'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly LeadStatus[] }[];
export type PipelineKey = (typeof PIPELINE_STAGES)[number]['key'];

export interface PipelineStep {
  key: PipelineKey;
  label: string;
  leads: LeadListItem[];
  count: number;
  /** Leads de l'étape déjà signalés ailleurs au cockpit (SLA, rappel en retard, documents bloqués). */
  blocked: number;
  /** Ancienneté moyenne depuis la réception du lead (ms) ; null sans lead. */
  avgAgeMs: number | null;
  /** Part des leads qui ont atteint cette étape et atteint aussi la suivante (%) ; null pour la dernière ou sans volume. */
  passage: number | null;
}

export function buildPipeline(items: readonly LeadListItem[], flagged: ReadonlySet<string>, nowMs: number): PipelineStep[] {
  const live = items.filter((l) => !l.excluded);
  const steps = PIPELINE_STAGES.map((s) => {
    const leads = live.filter((l) => (s.statuses as readonly string[]).includes(l.status)).sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    return {
      key: s.key,
      label: s.label,
      leads,
      count: leads.length,
      blocked: leads.filter((l) => flagged.has(l.id)).length,
      avgAgeMs: leads.length ? Math.round(leads.reduce((sum, l) => sum + (nowMs - l.receivedAtMs), 0) / leads.length) : null,
      passage: null as number | null,
    };
  });
  // Atteint l'étape i = en est à l'étape i ou plus loin (statuts ouverts ou vendu uniquement).
  const reached = steps.map((_, i) => steps.slice(i).reduce((sum, s) => sum + s.count, 0));
  steps.forEach((s, i) => {
    s.passage = i < steps.length - 1 && reached[i] > 0 ? Math.round((reached[i + 1] / reached[i]) * 1000) / 10 : null;
  });
  return steps;
}

// ── Cockpit documentaire ─────────────────────────────────────────────────────

export const DOC_VIEWS = ['requested', 'partial', 'promised', 'toCheck', 'nonConform', 'toBuild'] as const;
export type DocView = (typeof DOC_VIEWS)[number];

export const DOC_VIEW_LABELS: Record<DocView, string> = {
  requested: 'Documents demandés',
  partial: 'Documents partiels',
  promised: 'Promesses échues',
  toCheck: 'À contrôler',
  nonConform: 'Non conformes',
  toBuild: 'Prêts à monter',
};

export const DOC_VIEW_DEFINITIONS: Record<DocView, string> = {
  requested: 'Pièces demandées, aucune encore reçue : date de demande, pièces attendues, dernière et prochaine relance.',
  partial: 'Au moins une pièce reçue, checklist incomplète : pièces reçues, manquantes et ancienneté du blocage.',
  promised: 'Date promise dépassée sans pièce reçue : date promise, marge dépassée et propriétaire.',
  toCheck: 'Pièces reçues non encore validées : délai de contrôle.',
  nonConform: 'Au moins une pièce rejetée : pièce, motif et nouvelle pièce attendue.',
  toBuild: 'Dossiers documentaires complets, pas encore pris en charge pour le montage.',
};

const piece = (l: LeadListItem): string => (l.docs ? `${l.docs.mandatoryConform}/${l.docs.mandatory} obligatoires conformes` : '');

/** Une vue = une liste de dossiers avec, pour chacun, ce qui l'explique et depuis quand. */
export function buildDocViews(items: readonly LeadListItem[], nowMs: number): Record<DocView, LeadIssue[]> {
  const out: Record<DocView, LeadIssue[]> = { requested: [], partial: [], promised: [], toCheck: [], nonConform: [], toBuild: [] };
  for (const l of items) {
    if (!isOpen(l)) continue;
    const d = l.docs;
    if (l.status === 'file_ready_to_build') {
      out.toBuild.push({ lead: l, sinceMs: d?.completedAtMs ?? l.receivedAtMs, severity: 'watch', reason: `Dossier complet, montage à démarrer · ${piece(l)}` });
    }
    if (!d || l.documentsState === 'none' || l.documentsState === 'complete') continue;
    if (l.documentsState === 'requested') {
      const next = d.nextFollowUpAtMs ? ` · prochaine relance ${new Date(d.nextFollowUpAtMs).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}` : '';
      out.requested.push({ lead: l, sinceMs: d.lastRequestAtMs ?? l.receivedAtMs, severity: 'info', reason: `${d.expected} pièce${d.expected > 1 ? 's' : ''} attendue${d.expected > 1 ? 's' : ''}, ${d.followUpCount} relance${d.followUpCount > 1 ? 's' : ''}${next}` });
    }
    if (l.documentsState === 'partial') {
      const missing = d.missing.filter((m) => m.status === 'expected' || m.status === 'to_reask').length;
      out.partial.push({ lead: l, sinceMs: d.lastReceivedAtMs ?? d.lastRequestAtMs ?? l.receivedAtMs, severity: nowMs - (d.lastReceivedAtMs ?? l.receivedAtMs) > 3 * DAY ? 'high' : 'watch', reason: `${d.received} reçue${d.received > 1 ? 's' : ''}, ${missing} manquante${missing > 1 ? 's' : ''} · ${piece(l)}` });
    }
    if (d.promisedAtMs !== null && d.promisedAtMs <= nowMs) {
      const late = Math.max(1, Math.floor((nowMs - d.promisedAtMs) / MIN));
      out.promised.push({ lead: l, sinceMs: d.promisedAtMs, severity: 'high', reason: `Promesse dépassée de ${late < 60 ? `${late} min` : late < 1440 ? `${Math.floor(late / 60)} h` : `${Math.floor(late / 1440)} j`}` });
    }
    if (d.toCheck > 0) {
      out.toCheck.push({ lead: l, sinceMs: d.lastReceivedAtMs ?? l.receivedAtMs, severity: d.lastReceivedAtMs !== null && nowMs - d.lastReceivedAtMs > DAY ? 'high' : 'watch', reason: `${d.toCheck} pièce${d.toCheck > 1 ? 's' : ''} à contrôler` });
    }
    const ko = d.missing.filter((m) => m.status === 'non_conform' || m.status === 'to_reask');
    if (l.documentsState === 'incomplete_non_conform' || ko.length > 0) {
      out.nonConform.push({ lead: l, sinceMs: d.lastReceivedAtMs ?? l.receivedAtMs, severity: 'high', reason: ko.length ? ko.map((m) => `${m.label ?? m.code}${m.koReasonLabel ? ` (${m.koReasonLabel})` : ''}`).join(', ') : 'Pièce non conforme' });
    }
  }
  for (const k of DOC_VIEWS) out[k].sort((a, b) => a.sinceMs - b.sinceMs);
  return out;
}
