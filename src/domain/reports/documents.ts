// Performance documentaire et goulots d'étranglement (§22.7, fig. 33). Fonctions pures, sans Firestore. Les volumes
// sont des DOSSIERS (un lead = un dossier documentaire), comptés avec les mêmes règles que le rapport Direction
// (étapes, modes événement / cohorte, hors doublons, faux leads et exclus).
//
// Limites assumées, faute de date enregistrée : la date de la PREMIÈRE pièce reçue n'est pas conservée (seule la
// dernière l'est), donc « demande → première pièce » n'est pas calculé ; « demande → complet » part de la dernière
// demande ; « complet → montage » utilise la dernière mise à jour du montage. Les délais affichent leur volume.

import { CLOSED_LEAD_STATUSES } from '../enums';
import { documentLabel, koLabel } from '../documents/plan';
import type { LeadListItem } from '../leads/leadList';
import { ratePct } from '../sales/outcome';
import { MIN_ALERT_VOLUME, scopeLeads, stageHits, type ReportCampaign, type ReportFilters } from './direction';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const BLOCK_DAYS_CHOICES = [3, 5, 7, 14] as const;
export type BlockDays = (typeof BLOCK_DAYS_CHOICES)[number];
/** Dossier complet qui attend son montage depuis plus de cette durée : signalé comme goulot. */
export const MOUNT_WAIT_MS = 24 * HOUR;
/** Délai médian au-delà duquel une étape est signalée en retard (jours). Valeurs d'origine, pas encore réglables. */
export const DELAY_LIMITS_DAYS = { requestToComplete: 3, completeToMount: 1, completeToSale: 3 } as const;

export type DocStage = 'requested' | 'received' | 'complete' | 'mounted';
export const DOC_STAGE_LABELS: Record<DocStage, string> = {
  requested: 'Documents demandés',
  received: 'Au moins une pièce reçue',
  complete: 'Dossiers complets',
  mounted: 'Dossiers montés',
};
export const DOC_STAGE_DEFINITIONS: Record<DocStage, string> = {
  requested: 'Dossiers valides pour lesquels des pièces ont été demandées. Date : dernière demande.',
  received: 'Dossiers valides dont au moins une pièce a été reçue. Date : dernière réception.',
  complete: 'Dossiers valides dont toutes les pièces obligatoires sont conformes. Date : dossier complet.',
  mounted: 'Dossiers valides dont le montage a commencé (brouillon, validation, vente). Date : dernière mise à jour du montage.',
};

/** Statuts qui sortent le dossier du parcours sans vente : un dossier demandé qui s'y trouve est un abandon documentaire. */
export const ABANDON_STATUSES: readonly string[] = ['not_interested', 'unreachable_archived', 'ineligible'];

const valid = (l: LeadListItem) => !l.duplicate && !l.excluded && l.status !== 'fake_lead';
const inRange = (ms: number, from: number, to: number) => ms >= from && ms < to;

/** Instant et appartenance d'un dossier à chaque étape documentaire. */
export function docHits(l: LeadListItem): Record<DocStage, { reached: boolean; atMs: number }> {
  const h = stageHits(l);
  const d = l.docs;
  return {
    requested: { reached: h.docsRequested.reached, atMs: h.docsRequested.atMs },
    received: { reached: valid(l) && !!d && (d.received > 0 || d.lastReceivedAtMs !== null), atMs: d?.lastReceivedAtMs ?? l.receivedAtMs },
    complete: { reached: h.docsComplete.reached, atMs: h.docsComplete.atMs },
    mounted: { reached: h.mounted.reached, atMs: h.mounted.atMs },
  };
}

const inPeriod = (l: LeadListItem, atMs: number, f: ReportFilters) => inRange(f.mode === 'cohort' ? l.receivedAtMs : atMs, f.fromMs, f.toMs);

export interface DocDelay {
  key: 'requestToComplete' | 'completeToMount' | 'completeToSale';
  label: string;
  /** Médiane en jours ; null sans donnée. */
  medianDays: number | null;
  /** Nombre de dossiers mesurés. */
  n: number;
  late: boolean;
  definition: string;
}

export interface DocBar {
  key: string;
  label: string;
  count: number;
  /** Part des non-conformités en cours (%). */
  share: number | null;
}

export type Bottleneck = 'waiting' | 'mountWait';

export interface DocumentsReport {
  stages: { stage: DocStage; label: string; count: number; passage: number | null }[];
  counts: Record<DocStage, number>;
  toCheck: number;
  partial: number;
  avgReminders: number | null;
  abandoned: number;
  abandonRate: number | null;
  delays: DocDelay[];
  /** Dossiers bloqués : en attente de pièces depuis plus de N jours, complets en attente de montage depuis plus de 24 h. */
  bottlenecks: Record<Bottleneck, LeadListItem[]>;
  blockDays: number;
  nonConformDocs: DocBar[];
  nonConformReasons: DocBar[];
  nonConformTotal: number;
  minVolume: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildDocumentsReport(args: { leads: readonly LeadListItem[]; campaigns: readonly ReportCampaign[]; filters: ReportFilters; nowMs: number; blockDays?: number }): DocumentsReport {
  const f = args.filters;
  const blockDays = args.blockDays ?? 7;
  const scoped = scopeLeads(args.leads, f, args.campaigns);

  const counts: Record<DocStage, number> = { requested: 0, received: 0, complete: 0, mounted: 0 };
  const sets = documentPopulations(scoped, f);
  (Object.keys(counts) as DocStage[]).forEach((s) => (counts[s] = sets[s].length));

  const requested = sets.requested;
  const toCheck = requested.filter((l) => (l.docs?.toCheck ?? 0) > 0).length;
  const partial = requested.filter((l) => l.documentsState !== 'complete' && (l.docs?.received ?? 0) > 0).length;
  const reminders = requested.map((l) => l.docs?.followUpCount ?? 0);
  const abandoned = requested.filter((l) => ABANDON_STATUSES.includes(l.status) && l.documentsState !== 'complete').length;

  const gaps = (pick: (l: LeadListItem) => [number | null | undefined, number | null | undefined]) =>
    sets.complete.flatMap((l) => {
      const [from, to] = pick(l);
      return from != null && to != null && to >= from ? [(to - from) / DAY] : [];
    });
  const delay = (key: DocDelay['key'], label: string, xs: number[], definition: string): DocDelay => {
    const m = median(xs);
    return { key, label, medianDays: m === null ? null : round1(m), n: xs.length, late: m !== null && m > DELAY_LIMITS_DAYS[key], definition };
  };
  const delays: DocDelay[] = [
    delay('requestToComplete', 'Demande → complet', gaps((l) => [l.docs?.lastRequestAtMs, l.docs?.completedAtMs]), 'Médiane entre la dernière demande de pièces et le moment où le dossier est complet.'),
    delay('completeToMount', 'Complet → montage', gaps((l) => [l.docs?.completedAtMs, l.montage?.updatedAtMs]), 'Médiane entre le dossier complet et la dernière mise à jour du montage (approximation : la date de début du montage n’est pas conservée).'),
    delay('completeToSale', 'Complet → vente', gaps((l) => [l.docs?.completedAtMs, l.conversion?.convertedAtMs]), 'Médiane entre le dossier complet et la création de la vente.'),
  ];

  // Goulots : photographie actuelle des dossiers du périmètre (pas limitée à la période).
  const live = scoped.filter((l) => valid(l) && !CLOSED_LEAD_STATUSES.includes(l.status));
  const waiting = live.filter((l) => (l.status === 'awaiting_documents' || l.status === 'missing_info') && l.docs?.lastRequestAtMs != null && l.docs.lastRequestAtMs < args.nowMs - blockDays * DAY);
  const mountWait = live.filter((l) => l.status === 'file_ready_to_build' && l.docs?.completedAtMs != null && l.docs.completedAtMs < args.nowMs - MOUNT_WAIT_MS);

  // Non-conformités en cours sur les dossiers demandés de la période.
  const byDoc = new Map<string, DocBar>();
  const byReason = new Map<string, DocBar>();
  let nonConformTotal = 0;
  for (const l of requested) {
    for (const m of l.docs?.missing ?? []) {
      if (m.status !== 'non_conform') continue;
      nonConformTotal += 1;
      const dl = documentLabel(m.code, m.label);
      byDoc.set(m.code, { key: m.code, label: dl, count: (byDoc.get(m.code)?.count ?? 0) + 1, share: null });
      const rl = m.koReason ? koLabel(m) : 'Motif non renseigné';
      byReason.set(rl, { key: rl, label: rl, count: (byReason.get(rl)?.count ?? 0) + 1, share: null });
    }
  }
  const bars = (m: Map<string, DocBar>): DocBar[] => [...m.values()].map((b) => ({ ...b, share: ratePct(b.count, nonConformTotal) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'));

  const order: DocStage[] = ['requested', 'received', 'complete', 'mounted'];
  return {
    stages: order.map((stage, i) => ({ stage, label: DOC_STAGE_LABELS[stage], count: counts[stage], passage: i === 0 ? null : ratePct(counts[stage], counts[order[i - 1]]) })),
    counts,
    toCheck,
    partial,
    avgReminders: reminders.length ? round1(reminders.reduce((a, b) => a + b, 0) / reminders.length) : null,
    abandoned,
    abandonRate: ratePct(abandoned, counts.requested),
    delays,
    bottlenecks: { waiting, mountWait },
    blockDays,
    nonConformDocs: bars(byDoc),
    nonConformReasons: bars(byReason),
    nonConformTotal,
    minVolume: MIN_ALERT_VOLUME,
  };
}

/** Dossiers de chaque étape sur la période : source unique des volumes ET des listes ouvertes au clic (§22.12). */
export function documentPopulations(scoped: readonly LeadListItem[], f: ReportFilters): Record<DocStage, LeadListItem[]> {
  const out: Record<DocStage, LeadListItem[]> = { requested: [], received: [], complete: [], mounted: [] };
  for (const l of scoped) {
    const hits = docHits(l);
    for (const s of Object.keys(out) as DocStage[]) if (hits[s].reached && inPeriod(l, hits[s].atMs, f)) out[s].push(l);
  }
  return out;
}

export function documentStagePopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, stage: DocStage): LeadListItem[] {
  return documentPopulations(scopeLeads(leads, f, campaigns), f)[stage];
}

/** CSV : volumes, délais, goulots et non-conformités, avec le mode de date. */
export function documentsRows(r: DocumentsReport, modeLabel: string): (string | number)[][] {
  return [
    ['Mode de date', modeLabel],
    [],
    ['Étape', 'Dossiers', 'Passage depuis l’étape précédente (%)'],
    ...r.stages.map((s) => [s.label, s.count, s.passage ?? '']),
    ['Dossiers à contrôler', r.toCheck],
    ['Dossiers partiels', r.partial],
    ['Relances moyennes', r.avgReminders ?? ''],
    ['Abandon documentaire', r.abandoned, r.abandonRate ?? ''],
    [],
    ['Délai (médiane)', 'Jours', 'Dossiers mesurés', 'En retard'],
    ...r.delays.map((d) => [d.label, d.medianDays ?? '', d.n, d.late ? 'oui' : '']),
    [],
    [`Dossiers en attente de pièces depuis plus de ${r.blockDays} jours`, r.bottlenecks.waiting.length],
    ['Dossiers complets en attente de montage depuis plus de 24 h', r.bottlenecks.mountWait.length],
    [],
    ['Pièce la plus souvent non conforme', 'Nombre', 'Part (%)'],
    ...r.nonConformDocs.map((b) => [b.label, b.count, b.share ?? '']),
    [],
    ['Motif', 'Nombre', 'Part (%)'],
    ...r.nonConformReasons.map((b) => [b.label, b.count, b.share ?? '']),
  ];
}
