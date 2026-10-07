// Statistiques de campagne (fig. 15, §19.1, §22.4). Fonctions pures.
//
// Règles :
//  - le tableau, les cartes de synthèse et l'entonnoir utilisent les MÊMES lignes (§19.1) ;
//  - doublons et faux leads sont comptés à part, jamais dans les « leads valides » (§19.1, §22.5) ;
//  - un taux ou un coût dont le dénominateur est nul vaut null (affiché « — »), jamais 0 ni NaN (§22.12).

import type { CampaignStatus, DocumentState, LeadStatus } from '../enums';
import { normalizeText } from '../engine/normalize';

export interface CampaignView {
  id: string;
  name: string;
  sourceId: string;
  externalId: string | null;
  productCode: string | null;
  zones: readonly string[];
  status: CampaignStatus;
  budgetCents: number | null;
}

export interface LeadStatView {
  campaignId: string | null;
  status: LeadStatus;
  receivedAtMs: number;
  documentsState: DocumentState;
  /** Doublon d'un autre lead. */
  duplicate: boolean;
  /** Exclu des performances par un acteur autorisé (§22.5). */
  excluded: boolean;
}

export interface SpendView {
  id?: string;
  note?: string | null;
  campaignId: string;
  amountCents: number;
  atMs: number;
}

export interface Period {
  fromMs: number | null;
  /** Borne exclue. */
  toMs: number | null;
}

/**
 * Statuts qui impliquent qu'un échange a eu lieu avec le client (§12.1.3, §22.3).
 * « Pas de réponse » (NR) n'est PAS un contact : un lead en NR, injoignable ou en recyclage n'a
 * jamais été joint. À l'inverse, un lead rappelé, intéressé, en attente de documents, converti,
 * ou clos pour non-intérêt / inéligibilité a forcément été joint.
 */
export const CONTACTED_STATUSES: readonly LeadStatus[] = [
  'callback',
  'interested',
  'awaiting_documents',
  'file_ready_to_build',
  'file_building',
  'missing_info',
  'manager_validation',
  'file_ready',
  'transmitting',
  'transmission_error',
  'converted',
  'not_interested',
  'ineligible',
];

const inPeriod = (ms: number, p: Period) => (p.fromMs === null || ms >= p.fromMs) && (p.toMs === null || ms < p.toMs);

export interface Funnel {
  leads: number;
  contacted: number;
  documents: number;
  sales: number;
}

export interface CampaignStats {
  campaign: CampaignView;
  /** Leads valides : ni doublon, ni faux lead, ni exclus. */
  leads: number;
  duplicates: number;
  fakeLeads: number;
  /** null = aucune dépense saisie sur la période. */
  spendCents: number | null;
  cplCents: number | null;
  docsComplete: number;
  sales: number;
  costPerSaleCents: number | null;
  funnel: Funnel;
  /** Ventes / leads valides, en pourcentage ; null si aucun lead valide. */
  conversionRate: number | null;
}

const perUnit = (spend: number | null, den: number): number | null => (spend !== null && den > 0 ? Math.round(spend / den) : null);

export function computeCampaignStats(
  campaigns: readonly CampaignView[],
  leads: readonly LeadStatView[],
  spend: readonly SpendView[],
  period: Period
): CampaignStats[] {
  return campaigns.map((campaign) => {
    const mine = leads.filter((l) => l.campaignId === campaign.id && inPeriod(l.receivedAtMs, period));
    const fake = mine.filter((l) => l.status === 'fake_lead');
    const dup = mine.filter((l) => l.status !== 'fake_lead' && l.duplicate);
    const valid = mine.filter((l) => l.status !== 'fake_lead' && !l.duplicate && !l.excluded);

    const sales = valid.filter((l) => l.status === 'converted').length;
    const docsComplete = valid.filter((l) => l.documentsState === 'complete').length;
    const contacted = valid.filter((l) => CONTACTED_STATUSES.includes(l.status)).length;

    const spends = spend.filter((s) => s.campaignId === campaign.id && inPeriod(s.atMs, period));
    const spendCents = spends.length ? spends.reduce((sum, s) => sum + s.amountCents, 0) : null;

    return {
      campaign,
      leads: valid.length,
      duplicates: dup.length,
      fakeLeads: fake.length,
      spendCents,
      cplCents: perUnit(spendCents, valid.length),
      docsComplete,
      sales,
      costPerSaleCents: perUnit(spendCents, sales),
      funnel: { leads: valid.length, contacted, documents: docsComplete, sales },
      conversionRate: valid.length > 0 ? (sales / valid.length) * 100 : null,
    };
  });
}

export interface Totals {
  spendCents: number | null;
  leads: number;
  duplicates: number;
  fakeLeads: number;
  cplCents: number | null;
  docsComplete: number;
  sales: number;
  costPerSaleCents: number | null;
}

/** Totaux = somme des lignes affichées : une carte ne peut pas diverger du tableau. */
export function computeTotals(rows: readonly CampaignStats[]): Totals {
  const withSpend = rows.filter((r) => r.spendCents !== null);
  const spendCents = withSpend.length ? withSpend.reduce((s, r) => s + (r.spendCents ?? 0), 0) : null;
  const leads = rows.reduce((s, r) => s + r.leads, 0);
  const sales = rows.reduce((s, r) => s + r.sales, 0);
  return {
    spendCents,
    leads,
    duplicates: rows.reduce((s, r) => s + r.duplicates, 0),
    fakeLeads: rows.reduce((s, r) => s + r.fakeLeads, 0),
    cplCents: perUnit(spendCents, leads),
    docsComplete: rows.reduce((s, r) => s + r.docsComplete, 0),
    sales,
    costPerSaleCents: perUnit(spendCents, sales),
  };
}

// ── Filtres (fig. 15 : source, produit, zone, recherche) ─────────────────────

export interface CampaignFilters {
  status: CampaignStatus | 'all';
  sourceId: string | 'all';
  productCode: string | 'all';
  zone: string | 'all';
  search: string;
}

export const NO_CAMPAIGN_FILTERS: CampaignFilters = { status: 'all', sourceId: 'all', productCode: 'all', zone: 'all', search: '' };

export function filterCampaigns(campaigns: readonly CampaignView[], f: CampaignFilters): CampaignView[] {
  const q = normalizeText(f.search);
  return campaigns.filter((c) => {
    if (f.status !== 'all' && c.status !== f.status) return false;
    if (f.sourceId !== 'all' && c.sourceId !== f.sourceId) return false;
    if (f.productCode !== 'all' && c.productCode !== f.productCode) return false;
    if (f.zone !== 'all' && !c.zones.includes(f.zone)) return false;
    if (q && !normalizeText(`${c.name} ${c.externalId ?? ''}`).includes(q)) return false;
    return true;
  });
}

// ── Affichage ────────────────────────────────────────────────────────────────

/** 24800 centimes → « 248,00 € » ; null → « — ». */
export function formatEuros(cents: number | null, fractionDigits = 2): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${rate.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

// ── Tri des colonnes (fig. 15 : flèches de tri) ──────────────────────────────

export type CampaignSortKey = 'name' | 'source' | 'product' | 'zone' | 'budget' | 'leads' | 'cpl' | 'docs' | 'sales' | 'status';
export type SortDir = 'asc' | 'desc';

const STATUS_RANK: Record<CampaignStatus, number> = { active: 0, suspended: 1, draft: 2, ended: 3 };

/**
 * Trie sans modifier la liste d'origine. Une valeur absente (coût sans dépense, produit non renseigné)
 * passe TOUJOURS en dernier, quel que soit le sens : elle ne doit pas se retrouver en tête d'un tri
 * décroissant comme si c'était la plus grande. À égalité, l'ordre alphabétique des noms départage.
 */
export function sortCampaignRows(rows: readonly CampaignStats[], key: CampaignSortKey, dir: SortDir, sourceName: (id: string) => string): CampaignStats[] {
  const value = (r: CampaignStats): string | number | null => {
    switch (key) {
      case 'name': return r.campaign.name;
      case 'source': return sourceName(r.campaign.sourceId);
      case 'product': return r.campaign.productCode;
      case 'zone': return r.campaign.zones.length ? r.campaign.zones.join(' ') : null;
      case 'budget': return r.campaign.budgetCents;
      case 'leads': return r.leads;
      case 'cpl': return r.cplCents;
      case 'docs': return r.docsComplete;
      case 'sales': return r.sales;
      case 'status': return STATUS_RANK[r.campaign.status];
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.campaign.name.localeCompare(b.campaign.name, 'fr');
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'fr', { sensitivity: 'base' });
    return c !== 0 ? c * sign : a.campaign.name.localeCompare(b.campaign.name, 'fr');
  });
}
