// Espace Ventes (§25.7, fig. 39) : « À signer », « À sécuriser » et « Sécurisées ». Fonctions pures, sans Firestore.
//
// Une vente est sécurisée seulement après signature ET confirmation du paiement ou de l'acceptation du financement
// (§23.11 : une demande de financement envoyée n'est pas une vente financée). Les trois états — commercial, financier,
// documentaire — restent distincts sur chaque carte.

import { isSaleSecured } from '../cockpit/cockpit';
import type { LeadRow } from '../leads/leadList';

export type SaleColumn = 'to_sign' | 'to_secure' | 'secured';

export const SALE_COLUMNS: { key: SaleColumn; label: string }[] = [
  { key: 'to_sign', label: 'À signer' },
  { key: 'to_secure', label: 'À sécuriser' },
  { key: 'secured', label: 'Sécurisées' },
];

export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'grey';

export const SIGNATURE_STATES: Record<string, { label: string; tone: Tone }> = {
  none: { label: 'Non commencée', tone: 'grey' },
  sale_committed: { label: 'Vente engagée', tone: 'amber' },
  offer_sent: { label: 'Offre envoyée', tone: 'blue' },
  signed: { label: 'Signé', tone: 'green' },
  cancelled: { label: 'Annulée', tone: 'red' },
  retracted: { label: 'Rétractée', tone: 'red' },
};

export const FINANCIAL_STATES: Record<string, { label: string; tone: Tone }> = {
  none: { label: 'Non renseigné', tone: 'grey' },
  deposit_expected: { label: 'Acompte attendu', tone: 'amber' },
  deposit_received: { label: 'Acompte reçu', tone: 'amber' },
  financing_in_progress: { label: 'Financement en cours', tone: 'blue' },
  financing_accepted: { label: 'Financement accepté', tone: 'green' },
  financing_refused: { label: 'Financement refusé', tone: 'red' },
  payment_confirmed: { label: 'Paiement confirmé', tone: 'green' },
};

export const isSale = (r: Pick<LeadRow, 'conversion' | 'excluded'>): boolean => !!r.conversion && !r.excluded;

/** Colonne d'une vente ; null si le lead n'a pas de vente, ou si elle est annulée ou rétractée. */
export function saleColumn(r: Pick<LeadRow, 'conversion' | 'excluded' | 'commercialState' | 'financialState'>): SaleColumn | null {
  if (!isSale(r)) return null;
  if (r.commercialState === 'cancelled' || r.commercialState === 'retracted') return null;
  if (isSaleSecured(r)) return 'secured';
  return r.commercialState === 'signed' ? 'to_secure' : 'to_sign';
}

export type PaymentFilter = '' | 'cash' | 'credit';
export type AgeFilter = '' | 'day' | 'week' | 'older';

export const PAYMENT_FILTER_LABELS: Record<Exclude<PaymentFilter, ''>, string> = { cash: 'Comptant', credit: 'Crédit' };
export const AGE_FILTER_LABELS: Record<Exclude<AgeFilter, ''>, string> = { day: 'Moins d’un jour', week: '1 à 7 jours', older: 'Plus de 7 jours' };

export interface SaleFilters {
  search: string;
  /** Famille de produit ; vide = toutes. */
  product: string;
  mineOnly: boolean;
  uid: string;
  /** Mode de règlement choisi au montage (comptant ou crédit) ; vide = tous. */
  payment?: PaymentFilter;
  /** Ancienneté de la vente ; vide = toutes. */
  age?: AgeFilter;
  /** Instant de référence : « sécurisées ce mois-ci » et ancienneté. */
  nowMs: number;
}

export interface SaleBoard {
  columns: Record<SaleColumn, LeadRow[]>;
  kpis: { toSign: number; paymentsPending: number; financingInProgress: number; secured: number };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sinceOf = (r: LeadRow) => r.montage?.updatedAtMs ?? r.receivedAtMs;
const DAY = 86_400_000;
const sameMonth = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear() && new Date(a).getMonth() === new Date(b).getMonth();
/** Quand la vente est devenue sécurisée ; à défaut (vente ancienne), la date de sa dernière mise à jour. */
const securedOf = (r: LeadRow) => r.securedAtMs ?? sinceOf(r);

/** Familles de produits présentes dans les ventes, pour le filtre. */
export const saleProducts = (rows: readonly LeadRow[]): string[] =>
  [...new Set(rows.filter((r) => saleColumn(r) !== null && r.productCode).map((r) => r.productCode as string))].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

export function buildSaleBoard(rows: readonly LeadRow[], f: SaleFilters): SaleBoard {
  const q = norm(f.search.trim());
  const digits = f.search.replace(/\D/g, '');
  const columns: Record<SaleColumn, LeadRow[]> = { to_sign: [], to_secure: [], secured: [] };
  for (const r of rows) {
    const col = saleColumn(r);
    if (!col) continue;
    if (f.mineOnly && r.ownerId !== f.uid) continue;
    if (f.product && r.productCode !== f.product) continue;
    if (f.payment && (r.montage?.financingMode ?? 'cash') !== f.payment) continue;
    if (f.age) {
      const age = f.nowMs - sinceOf(r);
      if (f.age === 'day' ? age >= DAY : f.age === 'week' ? age < DAY || age > 7 * DAY : age <= 7 * DAY) continue;
    }
    // Sécurisées : celles du mois en cours (fig. 39 : « 12 ventes sécurisées ce mois »).
    if (col === 'secured' && !sameMonth(securedOf(r), f.nowMs)) continue;
    if (q && !(norm([r.fullName, r.city, r.productCode ?? '', r.campaignName, r.conversion?.clientId ?? ''].join(' ')).includes(q) || (digits.length >= 4 && (r.phone ?? '').replace(/\D/g, '').includes(digits)))) continue;
    columns[col].push(r);
  }
  // À traiter : la plus ancienne d'abord. Sécurisées : la plus récente d'abord.
  columns.to_sign.sort((a, b) => sinceOf(a) - sinceOf(b));
  columns.to_secure.sort((a, b) => sinceOf(a) - sinceOf(b));
  columns.secured.sort((a, b) => securedOf(b) - securedOf(a));
  const unsecured = [...columns.to_sign, ...columns.to_secure];
  return {
    columns,
    kpis: {
      toSign: columns.to_sign.length,
      // Signées dont ni le paiement ni un financement n'est encore confirmé ou en cours.
      paymentsPending: columns.to_secure.filter((r) => r.financialState !== 'financing_in_progress' && r.financialState !== 'financing_refused').length,
      financingInProgress: unsecured.filter((r) => r.financialState === 'financing_in_progress').length,
      secured: columns.secured.length,
    },
  };
}
