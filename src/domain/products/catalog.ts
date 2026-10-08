// Produits du CRM Leads = familles du catalogue du CRM principal (collection `products`, champ `category` :
// PAC, SSC, CESI, POELE…). Le catalogue principal reste la seule source : on n'y recopie rien, on en déduit la
// liste des familles. Fonctions pures, sans Firestore.

import { normalizeText } from '../engine/normalize';

export interface ProductCategory {
  /** Valeur stockée partout dans le CRM Leads (campagnes, profils, équipes, leads). */
  code: string;
  /** Nombre d'articles du catalogue dans cette famille. */
  count: number;
  /** Quelques noms d'articles, pour reconnaître la famille. */
  samples: string[];
}

/** Familles distinctes (casse et accents ignorés ; la première graphie rencontrée est conservée), triées. */
export function categoriesOf(rows: readonly { category?: unknown; name?: unknown }[]): ProductCategory[] {
  const byKey = new Map<string, ProductCategory>();
  for (const r of rows) {
    const code = typeof r.category === 'string' ? r.category.trim() : '';
    const key = normalizeText(code);
    if (!key) continue;
    const entry = byKey.get(key) ?? { code, count: 0, samples: [] };
    entry.count += 1;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name && entry.samples.length < 3) entry.samples.push(name);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.code.localeCompare(b.code, 'fr', { sensitivity: 'base' }));
}

/**
 * Famille du catalogue correspondant à un texte reçu d'une source de leads (« PAC », « pac air/eau », « Poêle »).
 * Correspondance exacte, ou un seul mot du texte qui est une famille. Plusieurs familles (« PAC + SSC ») ou aucune :
 * le texte est rendu tel quel, jamais deviné.
 */
export function resolveProductCode(raw: string | null | undefined, categories: readonly string[]): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  const wanted = normalizeText(text);
  const exact = categories.find((c) => normalizeText(c) === wanted);
  if (exact) return exact;
  const tokens = new Set(wanted.split(/[^a-z0-9]+/).filter(Boolean));
  const hits = categories.filter((c) => {
    const k = normalizeText(c);
    return k !== '' && tokens.has(k);
  });
  return hits.length === 1 ? hits[0] : text;
}

/** « * » dans un périmètre = tous les produits. */
export const ALL_PRODUCTS = '*';
