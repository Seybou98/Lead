// Rentabilité (§22). Fonctions pures, sans Firestore. Le cahier ne définit pas de marge : le CRM n'a ni coût d'achat ni prix
// du CRM principal. La rentabilité est donc un RETOUR SUR DÉPENSES PUBLICITAIRES :
//
//   chiffre d'affaires  montant TTC du montage du dossier des ventes nettes de la période (ventes annulées retirées) ;
//   marge d'acquisition chiffre d'affaires − dépenses publicitaires de la période (ce n'est PAS une marge brute : le coût
//                       d'achat, la pose et les frais de structure ne sont pas connus) ;
//   retour (ROAS)       chiffre d'affaires / dépenses ;
//   coût d'acquisition  dépenses / chiffre d'affaires, en %.
//
// Mêmes règles de période et de périmètre que le rapport Direction : une vente est datée selon le mode (événement ou
// cohorte), les leads valides excluent doublons, faux leads et exclus, une dépense se rattache à une campagne et n'est donc
// pas attribuable à un télépro.

import type { LeadListItem } from '../leads/leadList';
import { outcomeOf, ratePct, toOutcomeInput } from '../sales/outcome';
import { MIN_ALERT_VOLUME, scopeLeads, stageHits, type ReportCampaign, type ReportFilters, type ReportSpend } from './direction';

export const PROFIT_DIMS = ['campaign', 'source', 'product', 'owner'] as const;
export type ProfitDim = (typeof PROFIT_DIMS)[number];
export const PROFIT_DIM_LABELS: Record<ProfitDim, string> = { campaign: 'Campagne', source: 'Source', product: 'Produit', owner: 'Télépro' };

export const PROFIT_DEFINITIONS = {
  revenue: 'Montant TTC du montage du dossier des ventes nettes de la période (ventes annulées retirées). Ce n’est pas le prix facturé par le CRM principal.',
  spend: 'Dépenses publicitaires saisies sur la période, rattachées à la campagne.',
  margin: 'Chiffre d’affaires moins dépenses publicitaires. Ce n’est pas une marge brute : le coût d’achat et la pose ne sont pas connus.',
  roas: 'Chiffre d’affaires divisé par les dépenses publicitaires : 3,0 = 3 € de ventes pour 1 € dépensé.',
  acquisition: 'Dépenses publicitaires rapportées au chiffre d’affaires, en %.',
  basket: 'Chiffre d’affaires moyen par vente nette ayant un montant.',
  secured: 'Part du chiffre d’affaires déjà sécurisé : vente signée ET paiement confirmé ou financement accepté.',
  cancelled: 'Chiffre d’affaires des ventes annulées ou rétractées sur la période : retiré du chiffre d’affaires.',
} as const;

export interface ProfitTally {
  /** Leads valides reçus pendant la période. */
  leads: number;
  sales: number;
  cancelled: number;
  secured: number;
  revenueCents: number;
  securedRevenueCents: number;
  cancelledRevenueCents: number;
  /** Ventes nettes sans montant de montage : elles comptent comme vente mais pas dans le chiffre d'affaires. */
  withoutAmount: number;
  /** null = aucune dépense attribuable (aucune saisie, ou découpage par télépro). */
  spendCents: number | null;
}

export interface ProfitRow {
  key: string;
  tally: ProfitTally;
  marginCents: number | null;
  /** Chiffre d'affaires / dépenses, deux décimales ; null sans dépense ou sans chiffre d'affaires. */
  roas: number | null;
  /** Dépenses / chiffre d'affaires (%). */
  acquisitionRate: number | null;
  basketCents: number | null;
  costPerSaleCents: number | null;
  lowVolume: boolean;
}

export interface ProfitReport {
  dim: ProfitDim;
  rows: ProfitRow[];
  total: ProfitRow;
  minVolume: number;
  /** Les dépenses ne se rattachent pas à un télépro : le découpage par télépro n'a pas de coût. */
  spendUnavailable: boolean;
}

const NONE = '—';
const inRange = (ms: number, from: number, to: number) => ms >= from && ms < to;
const empty = (): ProfitTally => ({ leads: 0, sales: 0, cancelled: 0, secured: 0, revenueCents: 0, securedRevenueCents: 0, cancelledRevenueCents: 0, withoutAmount: 0, spendCents: null });
const amountOf = (l: LeadListItem): number => (l.montage && l.montage.totalTtcCents > 0 ? l.montage.totalTtcCents : 0);

function keyOf(l: LeadListItem, dim: ProfitDim, byId: Map<string, ReportCampaign>): string {
  switch (dim) {
    case 'campaign': return l.campaignId ?? NONE;
    case 'source': return (l.campaignId && byId.get(l.campaignId)?.sourceId) || NONE;
    case 'product': return l.productCode ?? NONE;
    case 'owner': return l.ownerId ?? NONE;
  }
}

/** Dépenses de la période par clé de dimension. null = non attribuables (filtre ou découpage par télépro). */
function spendByKey(spends: readonly ReportSpend[], campaigns: readonly ReportCampaign[], f: ReportFilters, dim: ProfitDim): Map<string, number> | null {
  if (f.owner || dim === 'owner') return null;
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const out = new Map<string, number>();
  for (const sp of spends) {
    if (!inRange(sp.atMs, f.fromMs, f.toMs)) continue;
    const c = byId.get(sp.campaignId);
    // Campagne inconnue : la dépense compte seulement quand aucun filtre de périmètre n'est actif.
    if (!c && (f.sourceId || f.campaignId || f.product)) continue;
    if (c && ((f.campaignId && c.id !== f.campaignId) || (f.sourceId && c.sourceId !== f.sourceId) || (f.product && c.productCode !== f.product))) continue;
    const key = dim === 'campaign' ? sp.campaignId : dim === 'source' ? (c?.sourceId ?? NONE) : (c?.productCode ?? NONE);
    out.set(key, (out.get(key) ?? 0) + sp.amountCents);
  }
  return out;
}

function derive(key: string, t: ProfitTally): ProfitRow {
  const priced = t.sales - t.withoutAmount;
  return {
    key,
    tally: t,
    marginCents: t.spendCents === null ? null : t.revenueCents - t.spendCents,
    roas: t.spendCents && t.spendCents > 0 && t.revenueCents > 0 ? Math.round((t.revenueCents / t.spendCents) * 100) / 100 : null,
    acquisitionRate: t.spendCents !== null && t.revenueCents > 0 ? ratePct(t.spendCents, t.revenueCents) : null,
    basketCents: priced > 0 ? Math.round(t.revenueCents / priced) : null,
    costPerSaleCents: t.spendCents !== null && t.sales > 0 ? Math.round(t.spendCents / t.sales) : null,
    lowVolume: t.leads < MIN_ALERT_VOLUME && t.sales < MIN_ALERT_VOLUME,
  };
}

const add = (a: ProfitTally, l: LeadListItem, what: 'lead' | 'sale' | 'cancelled'): void => {
  if (what === 'lead') { a.leads += 1; return; }
  const amount = amountOf(l);
  if (what === 'cancelled') { a.cancelled += 1; a.cancelledRevenueCents += amount; return; }
  a.sales += 1;
  if (amount > 0) a.revenueCents += amount; else a.withoutAmount += 1;
  if (outcomeOf(toOutcomeInput(l)).secured) { a.secured += 1; a.securedRevenueCents += amount; }
};

/** Ce qu'un lead apporte à la période : lead valide reçu, vente nette, vente annulée. */
function contributions(l: LeadListItem, f: ReportFilters): ('lead' | 'sale' | 'cancelled')[] {
  const hits = stageHits(l);
  const out: ('lead' | 'sale' | 'cancelled')[] = [];
  if (hits.valid.reached && inRange(l.receivedAtMs, f.fromMs, f.toMs)) out.push('lead');
  const o = outcomeOf(toOutcomeInput(l));
  const saleDate = f.mode === 'cohort' ? l.receivedAtMs : hits.sales.atMs;
  const valid = hits.valid.reached;
  if (valid && inRange(saleDate, f.fromMs, f.toMs)) {
    if (o.net) out.push('sale');
    else if (o.sold && o.cancelled) out.push('cancelled');
  }
  return out;
}

export function buildProfitReport(args: { leads: readonly LeadListItem[]; spends: readonly ReportSpend[]; campaigns: readonly ReportCampaign[]; filters: ReportFilters; dim: ProfitDim }): ProfitReport {
  const { filters: f, dim } = args;
  const byId = new Map(args.campaigns.map((c) => [c.id, c]));
  const scoped = scopeLeads(args.leads, f, args.campaigns);
  const groups = new Map<string, ProfitTally>();
  const total = empty();
  for (const l of scoped) {
    for (const what of contributions(l, f)) {
      const key = keyOf(l, dim, byId);
      const g = groups.get(key) ?? empty();
      add(g, l, what);
      groups.set(key, g);
      add(total, l, what);
    }
  }
  const spend = spendByKey(args.spends, args.campaigns, f, dim);
  if (spend) for (const [key, cents] of spend) groups.set(key, { ...(groups.get(key) ?? empty()), spendCents: cents });
  // Total : toutes les dépenses du périmètre, quelle que soit la dimension (sauf filtre télépro).
  const all = f.owner ? null : spendByKey(args.spends, args.campaigns, f, 'campaign');
  total.spendCents = all && all.size > 0 ? [...all.values()].reduce((s, v) => s + v, 0) : null;

  const rows = [...groups.entries()].map(([key, t]) => derive(key, t));
  // Les plus rentables d'abord ; sans dépense (marge inconnue), classées par chiffre d'affaires.
  rows.sort((a, b) => (b.marginCents ?? Number.NEGATIVE_INFINITY) - (a.marginCents ?? Number.NEGATIVE_INFINITY) || b.tally.revenueCents - a.tally.revenueCents || a.key.localeCompare(b.key));
  return { dim, rows, total: derive('total', total), minVolume: MIN_ALERT_VOLUME, spendUnavailable: spend === null };
}

export type ProfitSelector = 'sales' | 'cancelled' | 'noAmount';

/** Leads derrière un chiffre du tableau (clé null = ensemble). */
export function profitPopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, dim: ProfitDim, key: string | null, what: ProfitSelector): LeadListItem[] {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  return scopeLeads(leads, f, campaigns).filter((l) => {
    if (key !== null && keyOf(l, dim, byId) !== key) return false;
    const c = contributions(l, f);
    if (what === 'cancelled') return c.includes('cancelled');
    if (what === 'noAmount') return c.includes('sale') && amountOf(l) === 0;
    return c.includes('sale');
  });
}

/** CSV du rapport (en euros, pas en centimes). */
export function profitabilityRows(r: ProfitReport, nameOf: (key: string) => string): (string | number)[][] {
  const eur = (c: number | null): number | string => (c === null ? '' : c / 100);
  const line = (label: string, x: ProfitRow): (string | number)[] => [
    label, x.tally.leads, x.tally.sales, x.tally.cancelled, eur(x.tally.revenueCents), eur(x.tally.securedRevenueCents), eur(x.tally.cancelledRevenueCents), eur(x.tally.spendCents), eur(x.marginCents), x.roas ?? '', x.acquisitionRate ?? '', eur(x.basketCents), eur(x.costPerSaleCents), x.tally.withoutAmount,
  ];
  return [
    [`Rentabilité par ${PROFIT_DIM_LABELS[r.dim].toLowerCase()} (retour sur dépenses publicitaires)`],
    [PROFIT_DIM_LABELS[r.dim], 'Leads valides', 'Ventes nettes', 'Ventes annulées', 'Chiffre d’affaires TTC (€)', 'dont sécurisé (€)', 'CA des ventes annulées (€)', 'Dépenses (€)', 'Marge d’acquisition (€)', 'Retour (CA / dépenses)', 'Coût d’acquisition (% du CA)', 'Panier moyen (€)', 'Coût par vente (€)', 'Ventes sans montant'],
    ...r.rows.map((x) => line(nameOf(x.key), x)),
    line('Ensemble', r.total),
  ];
}
