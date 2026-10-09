// Rapport Direction (§22, fig. 30). Fonctions pures, sans Firestore : les cartes, l'entonnoir, la série hebdomadaire et
// les alertes sortent des MÊMES lignes (critère de recette §22.12 : un chiffre = la liste qui le compose).
//
// Deux lectures (§22.2), toujours affichées à côté des chiffres :
//   événement    chaque étape est comptée à sa date réelle (contact, dossier complet, vente) ;
//   cohorte      toutes les étapes sont rattachées à la date de réception initiale du lead.
//
// Dates d'étape disponibles sur le lead : réception, première prise en charge (contact), dernière demande de pièces,
// dossier complet, dernière mise à jour du dossier, transmission. Quand une date exacte manque, la date de réception
// fait foi : jamais de date inventée plus favorable. L'étape « intéressé » se déduit du statut ACTUEL (un lead devenu
// « non intéressé » n'y figure plus) : à lire comme un plancher.

import { CONTACTED_STATUSES } from '../admin/campaignStats';
import type { LeadListItem } from '../leads/leadList';
import { outcomeOf, ratePct, toOutcomeInput } from '../sales/outcome';

const DAY = 86_400_000;

export type DateMode = 'event' | 'cohort';
export const DATE_MODE_LABELS: Record<DateMode, string> = { event: 'Date d’événement', cohort: 'Cohorte d’acquisition' };

export interface ReportFilters {
  fromMs: number;
  /** Borne exclue. */
  toMs: number;
  mode: DateMode;
  sourceId: string;
  campaignId: string;
  product: string;
  owner: string;
}

export interface ReportCampaign {
  id: string;
  name: string;
  sourceId: string;
  productCode: string | null;
}

export interface ReportSpend {
  campaignId: string;
  amountCents: number;
  atMs: number;
}

export const STAGES = ['received', 'valid', 'contacted', 'interested', 'docsRequested', 'docsComplete', 'mounted', 'sales'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  received: 'Leads reçus',
  valid: 'Leads valides',
  contacted: 'Contactés',
  interested: 'Intéressés',
  docsRequested: 'Documents demandés',
  docsComplete: 'Documents complets',
  mounted: 'Dossiers montés',
  sales: 'Ventes',
};

/** Définition affichée en infobulle (§22 « tout indicateur affiche sa définition »). */
export const STAGE_DEFINITIONS: Record<Stage, string> = {
  received: 'Tous les leads reçus sur la période, doublons et faux leads compris. Date : réception.',
  valid: 'Leads reçus, hors doublons, faux leads et leads exclus. Date : réception.',
  contacted: 'Leads valides joints (statut rappel, intéressé, documents, dossier, vente, non intéressé, inéligible). Un « pas de réponse » n’est pas un contact. Date : première prise en charge.',
  interested: 'Leads valides qui sont, d’après leur statut actuel, intéressés ou plus avancés. Plancher : un lead devenu « non intéressé » n’y figure plus.',
  docsRequested: 'Leads valides pour lesquels des pièces ont été demandées. Date : dernière demande.',
  docsComplete: 'Leads valides dont toutes les pièces obligatoires sont conformes. Date : dossier complet.',
  mounted: 'Leads valides dont le dossier a été monté (brouillon enregistré, validation, vente). Date : dernière mise à jour du dossier.',
  sales: 'Ventes nettes : créées et non annulées (côté CRM Leads ou CRM principal). Date : transmission, sinon dernière mise à jour du dossier.',
};

const INTERESTED_STATUSES: readonly string[] = ['interested', 'awaiting_documents', 'file_ready_to_build', 'file_building', 'missing_info', 'manager_validation', 'file_ready', 'transmitting', 'transmission_error', 'converted'];
const MOUNTED_STATUSES: readonly string[] = ['file_building', 'manager_validation', 'file_ready', 'transmitting', 'transmission_error', 'converted'];

export interface StageHit {
  reached: boolean;
  atMs: number;
}

/** Pour chaque étape : le lead l'a-t-il atteinte, et à quelle date (événement). */
export function stageHits(l: LeadListItem): Record<Stage, StageHit> {
  const valid = !l.duplicate && !l.excluded && l.status !== 'fake_lead';
  const out = outcomeOf(toOutcomeInput(l));
  const docs = l.docs;
  const taken = l.slaStoppedAtMs ?? l.receivedAtMs;
  const hit = (reached: boolean, atMs: number): StageHit => ({ reached, atMs });
  return {
    received: hit(true, l.receivedAtMs),
    valid: hit(valid, l.receivedAtMs),
    contacted: hit(valid && CONTACTED_STATUSES.includes(l.status), taken),
    interested: hit(valid && (INTERESTED_STATUSES.includes(l.status) || l.documentsState !== 'none'), taken),
    docsRequested: hit(valid && l.documentsState !== 'none', docs?.lastRequestAtMs ?? l.receivedAtMs),
    docsComplete: hit(valid && l.documentsState === 'complete', docs?.completedAtMs ?? l.receivedAtMs),
    mounted: hit(valid && (MOUNTED_STATUSES.includes(l.status) || !!l.montage || out.sold), l.montage?.updatedAtMs ?? l.receivedAtMs),
    sales: hit(valid && out.net, l.conversion?.convertedAtMs ?? l.montage?.updatedAtMs ?? l.receivedAtMs),
  };
}

const inRange = (ms: number, from: number, to: number) => ms >= from && ms < to;

/** Leads retenus par les filtres de périmètre (source, campagne, produit, télépro) ; la période s'applique ensuite, étape par étape. */
export function scopeLeads(leads: readonly LeadListItem[], f: Pick<ReportFilters, 'sourceId' | 'campaignId' | 'product' | 'owner'>, campaigns: readonly ReportCampaign[]): LeadListItem[] {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  return leads.filter((l) => {
    if (f.campaignId && l.campaignId !== f.campaignId) return false;
    if (f.sourceId && (l.campaignId === null || byId.get(l.campaignId)?.sourceId !== f.sourceId)) return false;
    if (f.product && l.productCode !== f.product) return false;
    if (f.owner && l.ownerId !== f.owner) return false;
    return true;
  });
}

export interface PeriodCounts {
  counts: Record<Stage, number>;
  /** Ventes annulées, installées, facturées parmi les ventes de la période (retour du CRM principal). */
  cancelled: number;
  installed: number;
  invoiced: number;
  /** null = aucune dépense saisie sur la période (ou dépense non attribuable au filtre télépro). */
  spendCents: number | null;
}

/** Comptage d'une période, dans le mode choisi. */
export function countPeriod(leads: readonly LeadListItem[], spends: readonly ReportSpend[], campaigns: readonly ReportCampaign[], f: ReportFilters, from: number, to: number): PeriodCounts {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  let cancelled = 0;
  let installed = 0;
  let invoiced = 0;
  for (const l of leads) {
    const hits = stageHits(l);
    for (const s of STAGES) {
      const h = hits[s];
      if (!h.reached) continue;
      if (inRange(f.mode === 'cohort' ? l.receivedAtMs : h.atMs, from, to)) counts[s] += 1;
    }
    const o = outcomeOf(toOutcomeInput(l));
    const saleDate = f.mode === 'cohort' ? l.receivedAtMs : hits.sales.atMs;
    if (o.sold && !l.duplicate && !l.excluded && l.status !== 'fake_lead' && inRange(saleDate, from, to)) {
      if (o.cancelled) cancelled += 1;
      if (o.installed) installed += 1;
      if (o.invoiced) invoiced += 1;
    }
  }
  return { counts, cancelled, installed, invoiced, spendCents: spendOf(spends, campaigns, f, from, to) };
}

function spendOf(spends: readonly ReportSpend[], campaigns: readonly ReportCampaign[], f: ReportFilters, from: number, to: number): number | null {
  // Une dépense se rattache à une campagne, pas à un télépro : filtrer par télépro rend le coût non attribuable.
  if (f.owner) return null;
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const mine = spends.filter((sp) => {
    if (!inRange(sp.atMs, from, to)) return false;
    const c = byId.get(sp.campaignId);
    // Campagne inconnue : la dépense compte seulement quand aucun filtre de périmètre n'est actif.
    if (!c) return !f.sourceId && !f.campaignId && !f.product;
    return (!f.campaignId || c.id === f.campaignId) && (!f.sourceId || c.sourceId === f.sourceId) && (!f.product || c.productCode === f.product);
  });
  return mine.length ? mine.reduce((sum, sp) => sum + sp.amountCents, 0) : null;
}

export interface Kpi {
  value: number | null;
  /** Valeur de la période précédente ; null si non calculable. */
  previous: number | null;
  /** Variation relative en % (volumes, coûts) ou en points (taux) ; null si la période précédente est vide. */
  delta: number | null;
  deltaUnit: '%' | 'pts';
}

const rel = (cur: number | null, prev: number | null): number | null => (cur === null || prev === null || prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);
const pts = (cur: number | null, prev: number | null): number | null => (cur === null || prev === null ? null : Math.round((cur - prev) * 10) / 10);
const kpi = (cur: number | null, prev: number | null, unit: Kpi['deltaUnit']): Kpi => ({ value: cur, previous: prev, delta: unit === '%' ? rel(cur, prev) : pts(cur, prev), deltaUnit: unit });
const per = (spend: number | null, den: number): number | null => (spend !== null && den > 0 ? Math.round(spend / den) : null);

export interface DirectionKpis {
  spendCents: Kpi;
  received: Kpi;
  costPerLeadCents: Kpi;
  contactRate: Kpi;
  docsComplete: Kpi;
  sales: Kpi;
  costPerSaleCents: Kpi;
}

export interface FunnelStep {
  stage: Stage;
  label: string;
  count: number;
  /** Part des leads reçus (%) ; null si aucun lead reçu. */
  rateOfReceived: number | null;
  /** Taux de passage depuis l'étape précédente (%) ; null pour la première étape ou sans volume précédent. */
  passage: number | null;
}

export interface WeekPoint {
  startMs: number;
  label: string;
  spendCents: number;
  sales: number;
}

export interface ReportAlert {
  id: string;
  level: 'critical' | 'warning' | 'ok';
  title: string;
  detail: string;
}

export interface DirectionReport {
  kpis: DirectionKpis;
  funnel: FunnelStep[];
  weeks: WeekPoint[];
  alerts: ReportAlert[];
  projection: { salesSoFar: number; projected: number; elapsedDays: number; totalDays: number } | null;
  current: PeriodCounts;
  previous: PeriodCounts;
  /** Périmètre de la période précédente (même durée, juste avant). */
  previousRange: { fromMs: number; toMs: number };
  /** Volume minimal sous lequel une alerte statistique n'est pas déclenchée (§22.8). */
  minVolume: number;
}

export const MIN_ALERT_VOLUME = 10;
export const MIN_ALERT_SALES = 3;

export function previousRange(f: Pick<ReportFilters, 'fromMs' | 'toMs'>): { fromMs: number; toMs: number } {
  const len = f.toMs - f.fromMs;
  return { fromMs: f.fromMs - len, toMs: f.fromMs };
}

export function buildDirectionReport(args: { leads: readonly LeadListItem[]; spends: readonly ReportSpend[]; campaigns: readonly ReportCampaign[]; filters: ReportFilters; nowMs: number }): DirectionReport {
  const { filters: f, nowMs } = args;
  const leads = scopeLeads(args.leads, f, args.campaigns);
  const prevR = previousRange(f);
  const cur = countPeriod(leads, args.spends, args.campaigns, f, f.fromMs, f.toMs);
  const prev = countPeriod(leads, args.spends, args.campaigns, f, prevR.fromMs, prevR.toMs);

  const contact = (p: PeriodCounts) => ratePct(p.counts.contacted, p.counts.valid);
  const kpis: DirectionKpis = {
    spendCents: kpi(cur.spendCents, prev.spendCents, '%'),
    received: kpi(cur.counts.received, prev.counts.received, '%'),
    costPerLeadCents: kpi(per(cur.spendCents, cur.counts.valid), per(prev.spendCents, prev.counts.valid), '%'),
    contactRate: kpi(contact(cur), contact(prev), 'pts'),
    docsComplete: kpi(cur.counts.docsComplete, prev.counts.docsComplete, '%'),
    sales: kpi(cur.counts.sales, prev.counts.sales, '%'),
    costPerSaleCents: kpi(per(cur.spendCents, cur.counts.sales), per(prev.spendCents, prev.counts.sales), '%'),
  };

  const funnel: FunnelStep[] = STAGES.map((stage, i) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: cur.counts[stage],
    rateOfReceived: ratePct(cur.counts[stage], cur.counts.received),
    passage: i === 0 ? null : ratePct(cur.counts[stage], cur.counts[STAGES[i - 1]]),
  }));

  // Série par semaine (lundi), dépenses à leur date, ventes à leur date de mode.
  const weeks: WeekPoint[] = [];
  const monday = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  for (let w = monday(f.fromMs); w < f.toMs; ) {
    const next = new Date(w); next.setDate(next.getDate() + 7);
    const from = Math.max(w, f.fromMs);
    const to = Math.min(next.getTime(), f.toMs);
    const part = countPeriod(leads, args.spends, args.campaigns, f, from, to);
    weeks.push({ startMs: w, label: new Date(w).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }), spendCents: part.spendCents ?? 0, sales: part.counts.sales });
    w = next.getTime();
  }

  const alerts = buildAlerts(cur, prev, kpis);

  const covers = nowMs >= f.fromMs && nowMs < f.toMs;
  const elapsedDays = Math.max(1, Math.ceil((Math.min(nowMs, f.toMs) - f.fromMs) / DAY));
  const totalDays = Math.max(1, Math.round((f.toMs - f.fromMs) / DAY));
  const projection = covers ? { salesSoFar: cur.counts.sales, projected: Math.round((cur.counts.sales / elapsedDays) * totalDays), elapsedDays, totalDays } : null;

  return { kpis, funnel, weeks, alerts, projection, current: cur, previous: prev, previousRange: prevR, minVolume: MIN_ALERT_VOLUME };
}

/** Alertes statistiques : seuil ET volume minimum, pour ne pas crier au loup sur trois leads (§22.8). */
export function buildAlerts(cur: PeriodCounts, prev: PeriodCounts, k: DirectionKpis): ReportAlert[] {
  const out: ReportAlert[] = [];
  const enough = cur.counts.valid >= MIN_ALERT_VOLUME && prev.counts.valid >= MIN_ALERT_VOLUME;

  const cps = k.costPerSaleCents;
  if (cps.delta !== null && cps.delta >= 20 && cur.counts.sales >= MIN_ALERT_SALES && prev.counts.sales >= MIN_ALERT_SALES) {
    out.push({ id: 'cost-per-sale', level: 'critical', title: `Coût par vente +${String(cps.delta).replace('.', ',')} %`, detail: `Sur ${cur.counts.sales} ventes, contre ${prev.counts.sales} la période précédente.` });
  }
  const cpl = k.costPerLeadCents;
  if (cpl.delta !== null && cpl.delta >= 25 && enough) out.push({ id: 'cpl', level: 'warning', title: `Coût par lead valide +${String(cpl.delta).replace('.', ',')} %`, detail: `Sur ${cur.counts.valid} leads valides.` });
  const cr = k.contactRate;
  if (cr.delta !== null && cr.delta <= -10 && enough) out.push({ id: 'contact', level: 'warning', title: `Taux de contact ${String(cr.delta).replace('.', ',')} pts`, detail: `${cur.counts.contacted} contactés sur ${cur.counts.valid} leads valides.` });
  const reqNow = ratePct(cur.counts.docsComplete, cur.counts.docsRequested);
  const reqPrev = ratePct(prev.counts.docsComplete, prev.counts.docsRequested);
  if (reqNow !== null && reqPrev !== null && reqNow - reqPrev <= -10 && cur.counts.docsRequested >= MIN_ALERT_VOLUME && prev.counts.docsRequested >= MIN_ALERT_VOLUME) {
    out.push({ id: 'docs', level: 'warning', title: 'Documents demandés → complets en baisse', detail: `${String(reqNow).replace('.', ',')} % contre ${String(reqPrev).replace('.', ',')} % (${cur.counts.docsComplete} sur ${cur.counts.docsRequested}).` });
  }
  const sold = cur.counts.sales + cur.cancelled;
  if (sold >= 5 && cur.cancelled / sold >= 0.2) out.push({ id: 'cancelled', level: 'critical', title: 'Ventes annulées élevées', detail: `${cur.cancelled} annulée${cur.cancelled > 1 ? 's' : ''} sur ${sold} ventes créées.` });

  if (out.length === 0) out.push({ id: 'ok', level: 'ok', title: 'Aucune alerte', detail: `Volume minimal : ${MIN_ALERT_VOLUME} leads valides sur chaque période comparée.` });
  return out;
}

/** CSV du rapport : cartes et entonnoir, dans le mode affiché. */
export function directionRows(r: DirectionReport, mode: DateMode): (string | number)[][] {
  const v = (n: number | null, div = 1) => (n === null ? '' : n / div);
  return [
    ['Mode de date', DATE_MODE_LABELS[mode]],
    [],
    ['Indicateur', 'Valeur', 'Période précédente', 'Variation', 'Unité de variation'],
    ['Dépenses (€)', v(r.kpis.spendCents.value, 100), v(r.kpis.spendCents.previous, 100), v(r.kpis.spendCents.delta), '%'],
    ['Leads reçus', v(r.kpis.received.value), v(r.kpis.received.previous), v(r.kpis.received.delta), '%'],
    ['Coût par lead valide (€)', v(r.kpis.costPerLeadCents.value, 100), v(r.kpis.costPerLeadCents.previous, 100), v(r.kpis.costPerLeadCents.delta), '%'],
    ['Taux de contact (%)', v(r.kpis.contactRate.value), v(r.kpis.contactRate.previous), v(r.kpis.contactRate.delta), 'pts'],
    ['Dossiers complets', v(r.kpis.docsComplete.value), v(r.kpis.docsComplete.previous), v(r.kpis.docsComplete.delta), '%'],
    ['Ventes nettes', v(r.kpis.sales.value), v(r.kpis.sales.previous), v(r.kpis.sales.delta), '%'],
    ['Coût par vente (€)', v(r.kpis.costPerSaleCents.value, 100), v(r.kpis.costPerSaleCents.previous, 100), v(r.kpis.costPerSaleCents.delta), '%'],
    [],
    ['Entonnoir', 'Volume', '% des reçus', 'Passage depuis l’étape précédente (%)'],
    ...r.funnel.map((s) => [s.label, s.count, s.rateOfReceived ?? '', s.passage ?? '']),
    [],
    ['Ventes annulées', r.current.cancelled],
    ['Ventes installées', r.current.installed],
    ['Ventes facturées', r.current.invoiced],
  ];
}

/**
 * Leads qui composent un chiffre de l'entonnoir (§22.12 : « chaque nombre cliquable ouvre une liste dont le total
 * correspond exactement au KPI »). Même règle de comptage que `countPeriod`, donc même total.
 */
export function stagePopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, stage: Stage): LeadListItem[] {
  return scopeLeads(leads, f, campaigns).filter((l) => {
    const h = stageHits(l)[stage];
    return h.reached && inRange(f.mode === 'cohort' ? l.receivedAtMs : h.atMs, f.fromMs, f.toMs);
  });
}
