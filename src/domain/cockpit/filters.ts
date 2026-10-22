// Filtres globaux du cockpit manager (§12.4, §12.5) : équipe, produit, campagne, zone. Un filtre s'applique à TOUT ce que
// montre l'écran (cartes, alertes, décisions, équipe, flux, pipeline, documents), se retire individuellement ou se
// réinitialise, et se conserve dans l'adresse de la page (retour depuis une fiche). Fonctions pures.

import { zoneOf } from '../reports/quality';
import type { LeadListItem } from '../leads/leadList';
import type { UserRow } from '../admin/userRows';

export const COCKPIT_FILTER_KEYS = ['team', 'product', 'campaign', 'zone'] as const;
export type CockpitFilterKey = (typeof COCKPIT_FILTER_KEYS)[number];
export type CockpitFilters = Record<CockpitFilterKey, string>;

export const NO_COCKPIT_FILTERS: CockpitFilters = { team: '', product: '', campaign: '', zone: '' };
export const COCKPIT_FILTER_LABELS: Record<CockpitFilterKey, string> = { team: 'Équipe', product: 'Produit', campaign: 'Campagne', zone: 'Zone' };

export const activeFilterCount = (f: CockpitFilters): number => COCKPIT_FILTER_KEYS.filter((k) => f[k] !== '').length;

/** Lecture tolérante des paramètres d'adresse : une valeur absente ou trop longue est ignorée. */
export function filtersFromParams(p: URLSearchParams): CockpitFilters {
  const get = (k: CockpitFilterKey) => (p.get(k) ?? '').trim().slice(0, 128);
  return { team: get('team'), product: get('product'), campaign: get('campaign'), zone: get('zone') };
}

/** Paramètres d'adresse des filtres actifs, ajoutés aux autres paramètres existants. */
export function paramsWithFilters(base: URLSearchParams, f: CockpitFilters): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const k of COCKPIT_FILTER_KEYS) {
    if (f[k]) next.set(k, f[k]);
    else next.delete(k);
  }
  return next;
}

/**
 * Leads retenus. Équipe : les leads d'un membre de l'équipe ; un lead sans propriétaire (file tampon) n'appartient à aucune
 * équipe, il disparaît donc quand ce filtre est actif. Zone : département du code postal du lead.
 */
export function applyLeadFilters(items: readonly LeadListItem[], rows: readonly UserRow[], f: CockpitFilters): LeadListItem[] {
  if (activeFilterCount(f) === 0) return [...items];
  const members = f.team ? new Set(rows.filter((r) => r.teamIds.includes(f.team)).map((r) => r.uid)) : null;
  return items.filter((l) => {
    if (members && (l.ownerId === null || !members.has(l.ownerId))) return false;
    if (f.product && l.productCode !== f.product) return false;
    if (f.campaign && l.campaignId !== f.campaign) return false;
    if (f.zone && zoneOf(l.postalCode) !== f.zone) return false;
    return true;
  });
}

/** Télépros affichés : avec un filtre d'équipe, seulement les membres de l'équipe. */
export function applyRowFilters(rows: readonly UserRow[], f: CockpitFilters): UserRow[] {
  return f.team ? rows.filter((r) => r.teamIds.includes(f.team)) : [...rows];
}

export interface FilterOptions {
  teams: { id: string; name: string }[];
  products: string[];
  campaigns: { id: string; name: string }[];
  zones: { id: string; name: string }[];
}

/** Valeurs proposées : celles qui existent vraiment dans le périmètre du manager. */
export function filterOptions(items: readonly LeadListItem[], rows: readonly UserRow[], campaignNames: ReadonlyMap<string, string>): FilterOptions {
  const teams = new Map<string, string>();
  for (const r of rows) r.teamIds.forEach((id, i) => teams.set(id, r.teamNames[i] ?? id));
  const campaignIds = new Set(items.map((l) => l.campaignId).filter((x): x is string => !!x));
  const zones = new Set(items.map((l) => zoneOf(l.postalCode)));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');
  return {
    teams: [...teams].map(([id, name]) => ({ id, name })).sort(byName),
    products: [...new Set(items.map((l) => l.productCode).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'fr')),
    campaigns: [...campaignIds].map((id) => ({ id, name: campaignNames.get(id) ?? id })).sort(byName),
    zones: [...zones].filter((z) => z !== 'Inconnue').sort().map((z) => ({ id: z, name: `Département ${z}` })),
  };
}
