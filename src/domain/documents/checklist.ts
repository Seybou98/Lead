// Checklists documentaires par produit (§10.1, §21.4, fig. 28). Une checklist par famille de produit du catalogue
// (collection `cl_checklists`, identifiant = clé de la famille), plus une checklist « par défaut » pour toutes les
// autres. Fonctions pures : lecture tolérante, validation, choix de la checklist d'un lead.

import { normalizeText } from '../engine/normalize';
import { DEFAULT_DOCUMENT_TYPES, type DocumentTypeDef } from '../call/outcomes';

export type ChecklistItem = DocumentTypeDef;

export const DEFAULT_CHECKLIST_KEY = 'default';
export const MAX_CHECKLIST_ITEMS = 20;
export const MAX_LABEL = 60;

/** Identifiant Firestore d'une famille : « PAC » → « pac », « Poêle (bois) » → « poele-bois ». */
export function checklistKey(productCode: string | null | undefined): string {
  const k = normalizeText(productCode ?? '').replace(/ /g, '-');
  return k === '' || k === DEFAULT_CHECKLIST_KEY ? DEFAULT_CHECKLIST_KEY : k.slice(0, 80);
}

/** Code stable d'une pièce, tiré de son libellé et unique dans la liste (« Avis d'imposition » → « avis-d-imposition »). */
export function slugCode(label: string, taken: ReadonlySet<string>): string {
  const base = normalizeText(label).replace(/ /g, '-').slice(0, 40) || 'piece';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${taken.size + 1}`;
}

/** Liste lue en base : null si absente, vide ou illisible (jamais de pièce inventée). */
export function parseChecklist(raw: unknown): ChecklistItem[] | null {
  const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return null;
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const { code, label, mandatory } = it as Record<string, unknown>;
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(code) || seen.has(code)) continue;
    if (typeof label !== 'string' || !label.trim()) continue;
    seen.add(code);
    out.push({ code, label: label.trim().slice(0, MAX_LABEL), mandatory: mandatory === true });
  }
  return out.length > 0 ? out.slice(0, MAX_CHECKLIST_ITEMS) : null;
}

/** Erreurs d'une checklist en cours d'édition (liste vide = enregistrable). */
export function validateChecklist(items: readonly ChecklistItem[]): string[] {
  const errors: string[] = [];
  if (items.length === 0) errors.push('Ajoutez au moins une pièce.');
  if (items.length > MAX_CHECKLIST_ITEMS) errors.push(`${MAX_CHECKLIST_ITEMS} pièces au maximum.`);
  const labels = new Set<string>();
  for (const it of items) {
    const l = it.label.trim();
    if (!l) errors.push('Chaque pièce doit avoir un nom.');
    else if (l.length > MAX_LABEL) errors.push(`« ${l.slice(0, 20)}… » : ${MAX_LABEL} caractères au maximum.`);
    else if (labels.has(normalizeText(l))) errors.push(`« ${l} » est en double.`);
    labels.add(normalizeText(l));
  }
  return [...new Set(errors)];
}

export interface ResolvedChecklist {
  items: ChecklistItem[];
  /** product : propre à la famille · default : checklist par défaut éditée · builtin : liste d'origine du code. */
  source: 'product' | 'default' | 'builtin';
  key: string;
}

/** Checklist d'un lead : celle de sa famille de produit, sinon la « par défaut » éditée, sinon la liste d'origine. */
export function resolveChecklist(productCode: string | null | undefined, byKey: Readonly<Record<string, unknown>>): ResolvedChecklist {
  const key = checklistKey(productCode);
  const own = key === DEFAULT_CHECKLIST_KEY ? null : parseChecklist(byKey[key]);
  if (own) return { items: own, source: 'product', key };
  const def = parseChecklist(byKey[DEFAULT_CHECKLIST_KEY]);
  if (def) return { items: def, source: 'default', key: DEFAULT_CHECKLIST_KEY };
  return { items: [...DEFAULT_DOCUMENT_TYPES], source: 'builtin', key: DEFAULT_CHECKLIST_KEY };
}
