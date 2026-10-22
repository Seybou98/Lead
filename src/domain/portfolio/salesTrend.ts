// Évolution des ventes d'un télépro (fig. 22) : ventes nettes par mois sur les six derniers mois, et ventes du mois en cours
// comparées au mois précédent. Fonctions pures.
//
// Une vente est comptée à sa date de transmission, sinon à la dernière mise à jour du dossier, sinon à la réception du lead
// (jamais une date plus favorable) ; une vente annulée ou rétractée n'est pas une vente nette (même définition que partout :
// src/domain/sales/outcome.ts). Le chiffre d'affaires est le montant TTC du montage, comme dans les rapports de rentabilité.

import type { LeadListItem } from '../leads/leadList';
import { outcomeOf, toOutcomeInput } from '../sales/outcome';

export const TREND_MONTHS = 6;

export interface MonthPoint {
  /** Premier jour du mois (ms). */
  startMs: number;
  /** « 10/26 » */
  label: string;
  sales: number;
  revenueCents: number;
}

export interface SalesTrend {
  months: MonthPoint[];
  current: MonthPoint;
  previous: MonthPoint | null;
  /** Variation des ventes du mois en cours par rapport au mois précédent (%) ; null sans mois précédent ou sans base. */
  delta: number | null;
  /** Ventes nettes sur la période affichée. */
  total: number;
}

const monthStart = (ms: number): number => new Date(new Date(ms).getFullYear(), new Date(ms).getMonth(), 1).getTime();
const addMonths = (ms: number, n: number): number => new Date(new Date(ms).getFullYear(), new Date(ms).getMonth() + n, 1).getTime();
const label = (ms: number): string => `${String(new Date(ms).getMonth() + 1).padStart(2, '0')}/${String(new Date(ms).getFullYear()).slice(2)}`;

export const saleDateOf = (l: LeadListItem): number => l.conversion?.convertedAtMs ?? l.montage?.updatedAtMs ?? l.receivedAtMs;

export function salesTrend(items: readonly LeadListItem[], uid: string, nowMs: number, months = TREND_MONTHS): SalesTrend {
  const first = addMonths(monthStart(nowMs), -(months - 1));
  const points: MonthPoint[] = Array.from({ length: months }, (_, i) => {
    const startMs = addMonths(first, i);
    return { startMs, label: label(startMs), sales: 0, revenueCents: 0 };
  });
  for (const l of items) {
    if (l.ownerId !== uid || l.excluded || l.duplicate) continue;
    if (!outcomeOf(toOutcomeInput(l)).net) continue;
    const at = saleDateOf(l);
    const p = points.find((x, i) => at >= x.startMs && (i === points.length - 1 ? at < addMonths(x.startMs, 1) : at < points[i + 1].startMs));
    if (!p) continue;
    p.sales += 1;
    p.revenueCents += l.montage && l.montage.totalTtcCents > 0 ? l.montage.totalTtcCents : 0;
  }
  const current = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  return {
    months: points,
    current,
    previous,
    delta: previous && previous.sales > 0 ? Math.round(((current.sales - previous.sales) / previous.sales) * 1000) / 10 : null,
    total: points.reduce((n, p) => n + p.sales, 0),
  };
}
