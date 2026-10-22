// Périmètre, éligibilité et aides par produit (§21.2, fig. 26 et 28). Fonctions pures, partagées par l'écran Produits, la
// fiche de qualification du télépro, le cycle de publication et les tests. Le produit est une FAMILLE du catalogue du CRM
// principal (src/domain/products/catalog.ts) ; ici on ne décrit que ce que le CRM Leads ajoute à sa famille :
//
//   périmètre commercial  actif ou suspendu, et départements couverts (vide = toute la France) ;
//   éligibilité           critères que le télépro confirme avec le client (propriétaire, logement individuel, surface…) ;
//   aides                 dispositifs compatibles (MaPrimeRénov', CEE, financement, autres).
//
// Effet : ce sont des repères affichés au télépro dans la qualification (zone du lead couverte ou non, critères à confirmer,
// aides proposables) et des anomalies de configuration. Le moteur de conversion ne les applique PAS : l'éligibilité d'un
// dossier reste celle de son montage et du formulaire de qualification publié.

import { normalizeText } from '../engine/normalize';
import { zoneOf } from '../reports/zone';

export const AIDS = ['mpr', 'cee', 'financing', 'other'] as const;
export type AidCode = (typeof AIDS)[number];
export const AID_LABELS: Record<AidCode, string> = { mpr: 'MaPrimeRénov’', cee: 'CEE', financing: 'Financement', other: 'Autres dispositifs' };

export const MAX_PRODUCTS = 40;
export const MAX_CRITERIA = 10;
export const CRITERION_MAX = 120;
export const NOTE_MAX = 300;
/** Département : 2 chiffres, 2A, 2B, ou 3 chiffres d'outre-mer. */
export const ZONE_CODE = /^(\d{2}|2[AB]|9[78]\d)$/;

export interface ProductRule {
  /** Famille du catalogue du CRM principal, telle que stockée sur les campagnes et les leads. */
  code: string;
  /** Suspendu : plus proposé pour de nouvelles campagnes ; les leads en cours ne changent pas. */
  active: boolean;
  /** Départements couverts ; vide = toute la France. */
  zones: string[];
  aids: AidCode[];
  /** Critères d'éligibilité que le télépro confirme avec le client. */
  criteria: string[];
  note: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const productKey = (code: string): string => normalizeText(code);

export const defaultRule = (code: string): ProductRule => ({ code, active: true, zones: [], aids: [], criteria: [], note: '' });

function ruleFrom(raw: unknown): ProductRule | null {
  const x = rec(raw);
  const code = typeof x.code === 'string' ? x.code.trim().slice(0, 80) : '';
  if (!code) return null;
  const zones = [...new Set(strs(x.zones).map((z) => z.trim().toUpperCase()).filter((z) => ZONE_CODE.test(z)))].sort();
  return {
    code,
    active: x.active !== false,
    zones,
    aids: AIDS.filter((a) => strs(x.aids).includes(a)),
    criteria: strs(x.criteria).map((c) => c.replace(/\s+/g, ' ').trim().slice(0, CRITERION_MAX)).filter(Boolean).slice(0, MAX_CRITERIA),
    note: typeof x.note === 'string' ? x.note.trim().slice(0, NOTE_MAX) : '',
  };
}

/** Lecture tolérante de `cl_settings/products` : une règle par famille, sans règle enregistrée = aucune restriction. */
export function parseProductRules(raw: unknown): ProductRule[] {
  const list = rec(raw).products;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ProductRule[] = [];
  for (const r of list) {
    const p = ruleFrom(r);
    const key = p ? productKey(p.code) : '';
    if (p && key && !seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out.slice(0, MAX_PRODUCTS);
}

/** Saisie de l'écran : mêmes champs, rien n'est corrigé en silence (la validation dit ce qui ne va pas). */
export function coerceProductsInput(raw: unknown): ProductRule[] {
  const list = rec(raw).products;
  return (Array.isArray(list) ? list : []).map((r): ProductRule => {
    const x = rec(r);
    return {
      code: typeof x.code === 'string' ? x.code.trim() : '',
      active: x.active !== false,
      zones: strs(x.zones).map((z) => z.trim().toUpperCase()),
      aids: strs(x.aids) as AidCode[],
      criteria: strs(x.criteria).map((c) => c.replace(/\s+/g, ' ').trim()),
      note: typeof x.note === 'string' ? x.note.trim() : '',
    };
  });
}

export function validateProductRules(list: readonly ProductRule[]): string[] {
  const e: string[] = [];
  if (list.length > MAX_PRODUCTS) e.push(`${MAX_PRODUCTS} produits au plus.`);
  const keys = new Set<string>();
  for (const p of list) {
    const name = p.code || 'Produit';
    if (!p.code) e.push('Un produit n’a pas de code.');
    if (keys.has(productKey(p.code))) e.push(`${name} : produit en double.`);
    keys.add(productKey(p.code));
    const bad = p.zones.filter((z) => !ZONE_CODE.test(z));
    if (bad.length > 0) e.push(`${name} : département invalide (${bad.slice(0, 3).join(', ')}) — attendu 75, 2A, 974…`);
    if (new Set(p.zones).size !== p.zones.length) e.push(`${name} : département en double.`);
    if (p.aids.some((a) => !(AIDS as readonly string[]).includes(a))) e.push(`${name} : aide inconnue.`);
    if (p.criteria.length > MAX_CRITERIA) e.push(`${name} : ${MAX_CRITERIA} critères au plus.`);
    if (p.criteria.some((c) => c.length === 0 || c.length > CRITERION_MAX)) e.push(`${name} : chaque critère fait de 1 à ${CRITERION_MAX} caractères.`);
    if (p.note.length > NOTE_MAX) e.push(`${name} : note de ${NOTE_MAX} caractères au plus.`);
  }
  return e;
}

export const toStoredProducts = (list: readonly ProductRule[]): { products: ProductRule[] } => ({ products: list.map((p) => ({ ...p, zones: [...p.zones], aids: [...p.aids], criteria: [...p.criteria] })) });

/** Règle d'un produit (famille), casse et accents ignorés ; null si rien n'est configuré pour lui. */
export function ruleFor(rules: readonly ProductRule[], productCode: string | null | undefined): ProductRule | null {
  if (!productCode) return null;
  const key = productKey(productCode);
  return rules.find((r) => productKey(r.code) === key) ?? null;
}

export type ZoneStatus = 'all' | 'covered' | 'outside' | 'unknown';

/** Le code postal du lead est-il dans le périmètre du produit ? « unknown » : zone illisible, on ne conclut pas. */
export function zoneStatus(rule: ProductRule | null, postalCode: string | null | undefined): ZoneStatus {
  if (!rule || rule.zones.length === 0) return 'all';
  const z = zoneOf(postalCode ?? '');
  if (z === 'Inconnue') return 'unknown';
  return rule.zones.includes(z) ? 'covered' : 'outside';
}

/** Départements d'une campagne qui sortent du périmètre du produit (seulement ceux qui ressemblent à un département). */
export function campaignZoneConflicts(rule: ProductRule | null, campaignZones: readonly string[]): string[] {
  if (!rule || rule.zones.length === 0) return [];
  return campaignZones.map((z) => z.trim().toUpperCase()).filter((z) => ZONE_CODE.test(z) && !rule.zones.includes(z));
}
