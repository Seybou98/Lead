// Qualité des leads (§22.5). Fonctions pures, sans Firestore. La qualité s'analyse par source, campagne, produit,
// zone et télépro, sur les leads REÇUS pendant la période (lecture « cohorte » : la qualité se juge à l'arrivée).
//
// Brut et corrigé : la vue brute compte tous les leads reçus ; la vue corrigée en retire les doublons, faux leads et
// leads exclus. Les volumes exclus sont toujours montrés et leur liste reste ouverte au clic : rien n'est supprimé.
//
// Motifs : doublon, faux lead (par motif), inéligible (par catégorie et motif), non intéressé, opposition,
// injoignable, abandon documentaire. « Non-propriétaire » et « mauvais produit » n'ont pas de code propre : ils ne
// sont comptés que s'ils figurent parmi les motifs de clôture saisis. Les leads clos avant l'enregistrement du motif
// (champ `closure`) apparaissent avec « Motif non renseigné ».

import { BUILTIN_REASONS } from '../settings/reasons';
import type { LeadListItem } from '../leads/leadList';
import { ratePct } from '../sales/outcome';
import { MIN_ALERT_VOLUME, scopeLeads, type ReportCampaign, type ReportFilters } from './direction';
import { ABANDON_STATUSES } from './documents';

export const QUALITY_DIMS = ['source', 'campaign', 'product', 'zone', 'owner'] as const;
export type QualityDim = (typeof QUALITY_DIMS)[number];
export const QUALITY_DIM_LABELS: Record<QualityDim, string> = { source: 'Source', campaign: 'Campagne', product: 'Produit', zone: 'Zone', owner: 'Télépro' };

export const QUALITY_FLAGS = ['duplicate', 'fake', 'invalidContact', 'unreachable', 'ineligible', 'outOfZone', 'notInterested', 'opposition', 'docAbandon'] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export const QUALITY_FLAG_LABELS: Record<QualityFlag, string> = {
  duplicate: 'Doublons',
  fake: 'Faux leads',
  invalidContact: 'Coordonnées invalides',
  unreachable: 'Injoignables',
  ineligible: 'Inéligibles',
  outOfZone: 'Hors zone',
  notInterested: 'Non intéressés',
  opposition: 'Oppositions',
  docAbandon: 'Abandon documentaire',
};

export const QUALITY_FLAG_DEFINITIONS: Record<QualityFlag, string> = {
  duplicate: 'Lead reconnu comme doublon d’un lead existant à la réception.',
  fake: 'Lead déclaré faux (faux numéro, usurpation, hors cible, spam…) ou exclu après validation.',
  invalidContact: 'Faux lead dont le motif est un faux numéro, un numéro invalide ou une identité usurpée.',
  unreachable: 'Lead injoignable archivé à la fin des cycles de non-réponse.',
  ineligible: 'Lead déclaré inéligible (technique, administratif, financier, zone).',
  outOfZone: 'Inéligible pour une raison de zone non couverte.',
  notInterested: 'Lead clôturé « non intéressé » ou en recyclage après un refus.',
  opposition: 'Lead qui refuse tout contact ultérieur.',
  docAbandon: 'Pièces demandées, dossier jamais complet, lead clos sans vente.',
};

const INVALID_CODES = ['fake_number', 'invalid_number', 'usurped_identity'];
const INELIGIBLE_CATEGORY_LABELS: Record<string, string> = { technical: 'technique', administrative: 'administrative', financial: 'financière', zone: 'zone non couverte' };

/** Un lead est « de mauvaise qualité » s'il est doublon, faux, injoignable archivé ou inéligible. */
const LOW_QUALITY: readonly QualityFlag[] = ['duplicate', 'fake', 'unreachable', 'ineligible'];

export function flagsOf(l: LeadListItem): Record<QualityFlag, boolean> {
  const fakeStatus = l.status === 'fake_lead';
  const fake = !l.duplicate && (fakeStatus || l.excluded);
  const motive = l.closure?.kind === 'fake_lead' ? l.closure.code : l.excludedReason;
  const ineligible = l.status === 'ineligible';
  const reachedDocs = l.documentsState !== 'none' && l.documentsState !== 'complete';
  return {
    duplicate: l.duplicate,
    fake,
    invalidContact: fake && !!motive && INVALID_CODES.includes(motive),
    unreachable: l.status === 'unreachable_archived',
    ineligible,
    outOfZone: ineligible && l.closure?.category === 'zone',
    notInterested: l.status === 'not_interested' || (l.status === 'recycling' && l.closure?.kind === 'not_interested'),
    opposition: l.closure?.opposition === true,
    docAbandon: reachedDocs && ABANDON_STATUSES.includes(l.status),
  };
}

export interface QualityTally {
  received: number;
  /** Reçus moins doublons, faux leads et exclus : la population « corrigée ». */
  valid: number;
  excluded: number;
  flags: Record<QualityFlag, number>;
  /** Doublons, faux, injoignables, inéligibles sur les reçus (%) ; null sans lead. */
  /** Nombre de leads de mauvaise qualité (taux = ce nombre / reçus). */
  lowQuality: number;
  lowQualityRate: number | null;
}

export interface QualityRow {
  key: string;
  tally: QualityTally;
  lowVolume: boolean;
}

export interface MotifRow {
  key: string;
  family: string;
  label: string;
  count: number;
  share: number | null;
}

export interface QualityAlert {
  id: string;
  level: 'critical' | 'warning';
  title: string;
  detail: string;
  dim: QualityDim;
  key: string;
}

export interface QualityReport {
  dim: QualityDim;
  total: QualityTally;
  rows: QualityRow[];
  motifs: MotifRow[];
  alerts: QualityAlert[];
  minVolume: number;
}

const isValid = (l: LeadListItem) => !l.duplicate && !l.excluded && l.status !== 'fake_lead';

const isLowQuality = (l: LeadListItem): boolean => {
  const fl = flagsOf(l);
  return LOW_QUALITY.some((f) => fl[f]);
};

function tally(leads: readonly LeadListItem[]): QualityTally {
  const flags = Object.fromEntries(QUALITY_FLAGS.map((f) => [f, 0])) as Record<QualityFlag, number>;
  let valid = 0;
  let low = 0;
  for (const l of leads) {
    const fl = flagsOf(l);
    for (const f of QUALITY_FLAGS) if (fl[f]) flags[f] += 1;
    if (isValid(l)) valid += 1;
    if (isLowQuality(l)) low += 1;
  }
  return { received: leads.length, valid, excluded: leads.length - valid, flags, lowQuality: low, lowQualityRate: ratePct(low, leads.length) };
}

/** Département (2 chiffres, 3 en outre-mer) ; « Inconnue » si le code postal est absent ou illisible. */
export function zoneOf(postalCode: string): string {
  const cp = (postalCode ?? '').replace(/\s/g, '');
  if (!/^\d{5}$/.test(cp)) return 'Inconnue';
  return cp.startsWith('97') || cp.startsWith('98') ? cp.slice(0, 3) : cp.slice(0, 2);
}

export function dimKey(l: LeadListItem, dim: QualityDim, campaigns: readonly ReportCampaign[]): string {
  switch (dim) {
    case 'source': return (l.campaignId && campaigns.find((c) => c.id === l.campaignId)?.sourceId) || '—';
    case 'campaign': return l.campaignId ?? '—';
    case 'product': return l.productCode ?? '—';
    case 'zone': return zoneOf(l.postalCode);
    case 'owner': return l.ownerId ?? '—';
  }
}

const inPeriod = (l: LeadListItem, f: ReportFilters) => l.receivedAtMs >= f.fromMs && l.receivedAtMs < f.toMs;

/** Leads reçus pendant la période, dans le périmètre des filtres (source, campagne, produit, télépro). */
export function receivedLeads(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters): LeadListItem[] {
  return scopeLeads(leads, f, campaigns).filter((l) => inPeriod(l, f));
}

/** Motif principal d'un lead, une seule fois : doublon, puis clôture, puis injoignable. */
export function motifOf(l: LeadListItem): { key: string; family: string; label: string } | null {
  if (l.duplicate) return { key: 'duplicate', family: 'Doublon', label: 'Doublon' };
  const c = l.closure;
  if (c) {
    if (c.kind === 'fake_lead') return { key: `fake:${c.code}`, family: 'Faux lead', label: c.label };
    if (c.kind === 'ineligible') {
      const cat = INELIGIBLE_CATEGORY_LABELS[c.category ?? ''] ?? 'autre';
      return { key: `inel:${c.category ?? '-'}:${c.code}`, family: `Inéligibilité — ${cat}`, label: c.label };
    }
    return { key: `ni:${c.code}`, family: 'Non-intérêt', label: c.label };
  }
  if (l.status === 'fake_lead' || l.excluded) {
    const code = l.excludedReason;
    return code && BUILTIN_REASONS.fake_lead[code] ? { key: `fake:${code}`, family: 'Faux lead', label: BUILTIN_REASONS.fake_lead[code] } : { key: 'fake:?', family: 'Faux lead', label: 'Motif non renseigné' };
  }
  if (l.status === 'ineligible') return { key: 'inel:?', family: 'Inéligibilité', label: 'Motif non renseigné' };
  if (l.status === 'not_interested') return { key: 'ni:?', family: 'Non-intérêt', label: 'Motif non renseigné' };
  if (l.status === 'unreachable_archived') return { key: 'unreachable', family: 'Injoignable', label: 'Cycle de non-réponse terminé' };
  return null;
}

export function buildQualityReport(args: { leads: readonly LeadListItem[]; campaigns: readonly ReportCampaign[]; filters: ReportFilters; dim: QualityDim; labelOf?: (dim: QualityDim, key: string) => string }): QualityReport {
  const { dim } = args;
  const pop = receivedLeads(args.leads, args.campaigns, args.filters);
  const groups = new Map<string, LeadListItem[]>();
  for (const l of pop) {
    const k = dimKey(l, dim, args.campaigns);
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  }
  const rows: QualityRow[] = [...groups.entries()]
    .map(([key, ls]) => ({ key, tally: tally(ls), lowVolume: ls.length < MIN_ALERT_VOLUME }))
    .sort((a, b) => (b.tally.lowQualityRate ?? -1) - (a.tally.lowQualityRate ?? -1) || b.tally.received - a.tally.received || a.key.localeCompare(b.key, 'fr'));

  const motifMap = new Map<string, MotifRow>();
  let withMotif = 0;
  for (const l of pop) {
    const m = motifOf(l);
    if (!m) continue;
    withMotif += 1;
    const cur = motifMap.get(m.key);
    if (cur) cur.count += 1;
    else motifMap.set(m.key, { ...m, count: 1, share: null });
  }
  const motifs = [...motifMap.values()].map((m) => ({ ...m, share: ratePct(m.count, withMotif) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'));

  const total = tally(pop);
  const name = (k: string) => args.labelOf?.(dim, k) ?? k;
  const alerts: QualityAlert[] = [];
  for (const r of rows) {
    const rate = r.tally.lowQualityRate;
    // Alerte seulement avec un volume suffisant (§22.8) : trois leads ne font pas une tendance.
    if (r.tally.received >= MIN_ALERT_VOLUME && rate !== null && total.lowQualityRate !== null && rate >= 30 && rate >= total.lowQualityRate + 10) {
      alerts.push({ id: `${dim}:${r.key}`, level: rate >= 50 ? 'critical' : 'warning', title: `${QUALITY_DIM_LABELS[dim]} « ${name(r.key)} » : ${String(rate).replace('.', ',')} % de leads de mauvaise qualité`, detail: `${r.tally.received} leads reçus, ${r.tally.flags.duplicate} doublons, ${r.tally.flags.fake} faux, ${r.tally.flags.ineligible} inéligibles, ${r.tally.flags.unreachable} injoignables. Ensemble : ${String(total.lowQualityRate).replace('.', ',')} %.`, dim, key: r.key });
    }
  }
  return { dim, total, rows, motifs, alerts, minVolume: MIN_ALERT_VOLUME };
}

export type QualitySelector = QualityFlag | 'received' | 'valid' | 'excluded' | 'lowQuality';

/** Leads qui composent un chiffre du tableau : même règle de comptage, donc même total (§22.12). */
export function qualityPopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, dim: QualityDim, key: string | null, what: QualitySelector): LeadListItem[] {
  return receivedLeads(leads, campaigns, f).filter((l) => {
    if (key !== null && dimKey(l, dim, campaigns) !== key) return false;
    if (what === 'received') return true;
    if (what === 'valid') return isValid(l);
    if (what === 'excluded') return !isValid(l);
    if (what === 'lowQuality') return isLowQuality(l);
    return flagsOf(l)[what];
  });
}

/** Leads d'un motif (ligne du tableau des motifs). */
export function motifPopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, motifKey: string): LeadListItem[] {
  return receivedLeads(leads, campaigns, f).filter((l) => motifOf(l)?.key === motifKey);
}

export function qualityRows(r: QualityReport, nameOf: (key: string) => string): (string | number)[][] {
  const v = (n: number | null) => (n === null ? '' : n);
  const line = (name: string, t: QualityTally) => [name, t.received, t.valid, t.excluded, ...QUALITY_FLAGS.map((f) => t.flags[f]), v(t.lowQualityRate)];
  return [
    ['Lecture', 'Brut : tous les leads reçus ; corrigé : hors doublons, faux leads et exclus'],
    [],
    [QUALITY_DIM_LABELS[r.dim], 'Reçus (brut)', 'Valides (corrigé)', 'Exclus', ...QUALITY_FLAGS.map((f) => QUALITY_FLAG_LABELS[f]), 'Mauvaise qualité (%)'],
    ...r.rows.map((x) => line(nameOf(x.key), x.tally)),
    line('Ensemble', r.total),
    [],
    ['Famille', 'Motif', 'Leads', 'Part (%)'],
    ...r.motifs.map((m) => [m.family, m.label, m.count, v(m.share)]),
  ];
}
