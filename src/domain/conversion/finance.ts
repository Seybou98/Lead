// Récapitulatif financier du montage (§11.5) : Prix total TTC − MPR − CEE − remise commerciale = reste à charge.
// Tous les montants sont des centimes entiers : jamais de flottant dans un calcul d'argent.

export interface OfferLine {
  id: string;
  /** Article du catalogue du CRM principal (collection `products`) ; null = ligne saisie à la main (hors catalogue). */
  productId: string | null;
  label: string;
  /** Prestation associée : « Fourniture et pose », « Fourniture seule »… */
  service: string;
  qty: number;
  unitHtCents: number;
  /** Taux de TVA en pourcentage (20, 10, 5,5). */
  vatRate: number;
}

export interface Recap {
  totalHtCents: number;
  vatCents: number;
  totalTtcCents: number;
  mprCents: number;
  ceeCents: number;
  discountCents: number;
  /** Peut être négatif : les aides dépassent alors le prix, ce que les contrôles bloquent. */
  remainderCents: number;
  /** Remise rapportée au prix TTC, en pourcentage (0 si le prix est nul). */
  discountPct: number;
  /** Aides (MPR + CEE) rapportées au prix TTC, en pourcentage. */
  aidsPct: number;
}

const int = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0);

/** « 11 990,50 », « 11990.5 » ou 11990.5 → 1199050. null si illisible ou négatif. */
export function parseEuroCents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\s  €]/g, '').replace(',', '.');
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const formatEuros = (cents: number): string =>
  `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100)} €`;

export const lineHtCents = (l: Pick<OfferLine, 'qty' | 'unitHtCents'>): number => int(l.qty * l.unitHtCents);
export const lineTtcCents = (l: Pick<OfferLine, 'qty' | 'unitHtCents' | 'vatRate'>): number => int(lineHtCents(l) * (1 + l.vatRate / 100));

export function computeRecap(lines: readonly OfferLine[], mprCents: number, ceeCents: number, discountCents: number): Recap {
  const totalHtCents = lines.reduce((s, l) => s + lineHtCents(l), 0);
  const totalTtcCents = lines.reduce((s, l) => s + lineTtcCents(l), 0);
  const mpr = Math.max(0, int(mprCents));
  const cee = Math.max(0, int(ceeCents));
  const discount = Math.max(0, int(discountCents));
  return {
    totalHtCents,
    vatCents: totalTtcCents - totalHtCents,
    totalTtcCents,
    mprCents: mpr,
    ceeCents: cee,
    discountCents: discount,
    remainderCents: totalTtcCents - mpr - cee - discount,
    discountPct: totalTtcCents > 0 ? Math.round((discount / totalTtcCents) * 1000) / 10 : 0,
    aidsPct: totalTtcCents > 0 ? Math.round(((mpr + cee) / totalTtcCents) * 1000) / 10 : 0,
  };
}

/** Prix d'un article du CRM principal : `price: { ht, tva, ttc }` en chaînes. Rend le HT en centimes et la TVA, ou null. */
export function priceOfProduct(price: unknown): { unitHtCents: number; vatRate: number } | null {
  if (!price || typeof price !== 'object') return null;
  const p = price as Record<string, unknown>;
  const vat = typeof p.tva === 'number' ? p.tva : Number(String(p.tva ?? '').replace(',', '.'));
  const vatRate = Number.isFinite(vat) && vat >= 0 && vat <= 30 ? vat : 20;
  const ht = parseEuroCents(p.ht);
  if (ht !== null && ht > 0) return { unitHtCents: ht, vatRate };
  const ttc = parseEuroCents(p.ttc);
  if (ttc !== null && ttc > 0) return { unitHtCents: Math.round(ttc / (1 + vatRate / 100)), vatRate };
  return null;
}
