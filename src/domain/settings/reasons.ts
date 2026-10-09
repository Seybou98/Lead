// Motifs et listes administrables (§21.6) : non-intérêt, inéligibilité, faux lead, rappel, mauvais moment, intérêt,
// non-conformité d'une pièce. Fonctions PURES, partagées par l'écran d'administration, le navigateur et le serveur :
// une valeur affichée à l'administrateur est celle qu'acceptent la qualification d'appel et le contrôle des pièces.
//
// Règles du cahier :
//  - chaque valeur a un libellé, un ordre, un code statistique STABLE (son code, jamais modifié) et une exigence de
//    commentaire ;
//  - une valeur déjà utilisée ne se supprime pas : elle est ARCHIVÉE et reste lisible dans les historiques et rapports.
//    Ici aucune valeur ne se supprime : l'archivage est le seul retrait, et il est réversible.
//
// Les valeurs d'origine (codes du moteur) sont toujours présentes : l'enregistrement ne peut pas les faire disparaître.
// Les valeurs ajoutées ont un code « c_… » généré une fois pour toutes.

import { BAD_MOMENT_REASONS, CALLBACK_REASONS, FAKE_LEAD_MOTIVES, INELIGIBLE_MOTIVES, INTEREST_REASONS, REFUSAL_MOTIVES } from '../call/outcomes';

export const REASON_LISTS = ['callback', 'bad_moment', 'interest', 'refusal', 'fake_lead', 'ineligible_technical', 'ineligible_administrative', 'ineligible_financial', 'ineligible_zone', 'document_ko', 'reassign', 'temperature'] as const;
export type ReasonList = (typeof REASON_LISTS)[number];

export const REASON_LIST_LABELS: Record<ReasonList, { title: string; hint: string }> = {
  callback: { title: 'Rappel client', hint: 'Pourquoi le client demande à être rappelé (fig. 7).' },
  bad_moment: { title: 'Mauvais moment', hint: 'Rappel rapide : pourquoi l’appel tombe mal (fig. 13).' },
  interest: { title: 'Prospect intéressé', hint: 'Pourquoi le dossier n’avance pas tout de suite (fig. 8).' },
  refusal: { title: 'Non-intérêt', hint: 'Motif du refus du client (fig. 10).' },
  fake_lead: { title: 'Faux lead', hint: 'Motif d’un faux lead ou d’un mauvais contact (fig. 12).' },
  ineligible_technical: { title: 'Inéligibilité — technique', hint: 'Motifs de la catégorie « Technique » (fig. 11).' },
  ineligible_administrative: { title: 'Inéligibilité — administrative', hint: 'Motifs de la catégorie « Administrative ».' },
  ineligible_financial: { title: 'Inéligibilité — financière', hint: 'Motifs de la catégorie « Financière ».' },
  ineligible_zone: { title: 'Inéligibilité — zone', hint: 'Motifs de la catégorie « Zone non couverte ».' },
  document_ko: { title: 'Non-conformité d’une pièce', hint: 'Pourquoi une pièce est refusée au contrôle (§10.3).' },
  reassign: { title: 'Réattribution', hint: 'Pourquoi un lead change de télépro (cockpit, RG16).' },
  temperature: { title: 'Température', hint: 'Chaud, tiède, à travailler (§9.1). Les trois codes sont fixes : on règle leur libellé, leur ordre et leur disponibilité.' },
};

/** Listes dont les valeurs sont celles du moteur : pas d'ajout possible (priorité et statistiques en dépendent). */
export const FIXED_LISTS: readonly ReasonList[] = ['temperature'];

/** Motifs de réattribution d'origine (le cockpit demandait jusqu'ici un texte libre). */
export const REASSIGN_REASONS: Record<string, string> = {
  absence: 'Absence du télépro',
  overload: 'Charge trop élevée',
  expertise: 'Compétence produit',
  client_request: 'Demande du client',
  rebalancing: 'Rééquilibrage de portefeuille',
  other: 'Autre',
};

/** Libellés d'origine des motifs de non-conformité d'une pièce (§10.3). */
export const DOCUMENT_KO_LABELS: Record<string, string> = {
  unreadable: 'Illisible',
  incomplete: 'Incomplet',
  expired: 'Expiré',
  wrong_document: 'Mauvais document',
  inconsistent_info: 'Informations incohérentes',
  other: 'Autre',
};

/** Valeurs d'origine de chaque liste (code → libellé), dans l'ordre d'affichage historique. */
export const BUILTIN_REASONS: Record<ReasonList, Record<string, string>> = {
  callback: { ...CALLBACK_REASONS },
  bad_moment: { ...BAD_MOMENT_REASONS },
  interest: { ...INTEREST_REASONS },
  refusal: { ...REFUSAL_MOTIVES },
  fake_lead: { ...FAKE_LEAD_MOTIVES },
  ineligible_technical: { ...INELIGIBLE_MOTIVES.technical },
  ineligible_administrative: { ...INELIGIBLE_MOTIVES.administrative },
  ineligible_financial: { ...INELIGIBLE_MOTIVES.financial },
  ineligible_zone: { ...INELIGIBLE_MOTIVES.zone },
  document_ko: { ...DOCUMENT_KO_LABELS },
  reassign: { ...REASSIGN_REASONS },
  temperature: { hot: 'Chaud', warm: 'Tiède', to_work: 'À travailler' },
};

/**
 * Listes dont la qualification demande déjà TOUJOURS un commentaire : l'exigence par valeur n'ajoute rien, l'écran la
 * montre acquise. Pour les autres (mauvais moment, pièce non conforme), elle rend le commentaire obligatoire.
 */
export const COMMENT_ALWAYS_REQUIRED: readonly ReasonList[] = ['callback', 'interest', 'refusal', 'fake_lead', 'ineligible_technical', 'ineligible_administrative', 'ineligible_financial', 'ineligible_zone', 'temperature'];

/** Valeur qui exige un commentaire dès l'origine (« Autre » : à préciser). */
const ORIGIN_COMMENT = (l: ReasonList, code: string): boolean => (l === 'document_ko' || l === 'reassign') && code === 'other';

/** Nombre maximal de valeurs par liste. */
export const MAX_ITEMS = 40;
export const CUSTOM_CODE = /^c_[a-z0-9_]{1,40}$/;

export interface ReasonItem {
  /** Code statistique stable (jamais modifié) : code d'origine du moteur, ou « c_… » pour une valeur ajoutée. */
  code: string;
  label: string;
  /** Archivée : plus proposée à la saisie, toujours lisible dans les historiques. */
  active: boolean;
  /** Valeur d'origine du moteur (non ajoutée par l'administrateur). */
  builtin: boolean;
  /** Le commentaire devient obligatoire quand cette valeur est choisie. */
  requireComment: boolean;
}

export type ReasonSettings = Record<ReasonList, ReasonItem[]>;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const cleanLabel = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

export function defaultReasons(): ReasonSettings {
  const out = {} as ReasonSettings;
  for (const l of REASON_LISTS) {
    out[l] = Object.entries(BUILTIN_REASONS[l]).map(([code, label]) => ({ code, label, active: true, builtin: true, requireComment: ORIGIN_COMMENT(l, code) }));
  }
  return out;
}

export const DEFAULT_REASON_SETTINGS: ReasonSettings = defaultReasons();

/**
 * Lecture tolérante d'un document `cl_settings/reasons`. Les valeurs d'origine sont toujours présentes (libellé,
 * état et exigence repris du document s'ils sont valides, sinon valeur d'origine) ; les valeurs ajoutées invalides
 * sont ignorées. L'ordre est celui du document ; ce qui n'y figure pas suit, dans l'ordre d'origine.
 */
export function parseReasonSettings(raw: unknown): ReasonSettings {
  const root = rec(raw);
  const out = {} as ReasonSettings;
  for (const l of REASON_LISTS) {
    const stored = Array.isArray(rec(root.lists)[l]) ? (rec(root.lists)[l] as unknown[]) : [];
    const builtin = BUILTIN_REASONS[l];
    const seen = new Set<string>();
    const items: ReasonItem[] = [];
    for (const r of stored) {
      const x = rec(r);
      const code = typeof x.code === 'string' ? x.code : '';
      if (!code || seen.has(code)) continue;
      const isBuiltin = code in builtin;
      if (!isBuiltin && (FIXED_LISTS.includes(l) || !CUSTOM_CODE.test(code))) continue;
      const label = cleanLabel(x.label);
      if (!isBuiltin && (label.length < 2 || label.length > 60)) continue;
      seen.add(code);
      items.push({
        code,
        label: label.length >= 2 && label.length <= 60 ? label : builtin[code],
        active: typeof x.active === 'boolean' ? x.active : true,
        builtin: isBuiltin,
        requireComment: !COMMENT_ALWAYS_REQUIRED.includes(l) && x.requireComment === true,
      });
      if (items.length >= MAX_ITEMS) break;
    }
    for (const [code, label] of Object.entries(builtin)) {
      if (!seen.has(code)) items.push({ code, label, active: true, builtin: true, requireComment: ORIGIN_COMMENT(l, code) });
    }
    out[l] = items;
  }
  return out;
}

export function validateReasonSettings(s: ReasonSettings): string[] {
  const e: string[] = [];
  for (const l of REASON_LISTS) {
    const title = REASON_LIST_LABELS[l].title;
    const items = s[l] ?? [];
    if (items.length > MAX_ITEMS) e.push(`${title} : ${MAX_ITEMS} valeurs au plus.`);
    const labels = new Set<string>();
    const codes = new Set<string>();
    for (const it of items) {
      const label = cleanLabel(it.label);
      if (label.length < 2 || label.length > 60) e.push(`${title} : un libellé fait entre 2 et 60 caractères.`);
      const key = label.toLowerCase();
      if (labels.has(key)) e.push(`${title} : le libellé « ${label} » est en double.`);
      labels.add(key);
      if (codes.has(it.code)) e.push(`${title} : code en double (${it.code}).`);
      codes.add(it.code);
      if (!(it.code in BUILTIN_REASONS[l]) && (FIXED_LISTS.includes(l) || !CUSTOM_CODE.test(it.code))) e.push(`${title} : code invalide (${it.code}).`);
    }
    for (const code of Object.keys(BUILTIN_REASONS[l])) if (!codes.has(code)) e.push(`${title} : la valeur d’origine « ${BUILTIN_REASONS[l][code]} » ne peut pas disparaître, seulement être archivée.`);
    if (!items.some((it) => it.active)) e.push(`${title} : au moins une valeur doit rester active.`);
  }
  return [...new Set(e)];
}

/** Saisie de l'écran → réglages : mêmes champs, types contrôlés, sans valeur de repli silencieuse. */
export function coerceReasonInput(raw: unknown): ReasonSettings {
  const lists = rec(rec(raw).lists);
  const out = {} as ReasonSettings;
  for (const l of REASON_LISTS) {
    const arr = Array.isArray(lists[l]) ? (lists[l] as unknown[]) : [];
    out[l] = arr.map((r) => {
      const x = rec(r);
      const code = typeof x.code === 'string' ? x.code : '';
      return { code, label: cleanLabel(x.label), active: x.active === true, builtin: code in BUILTIN_REASONS[l], requireComment: !COMMENT_ALWAYS_REQUIRED.includes(l) && x.requireComment === true };
    });
  }
  return out;
}

/** Forme enregistrée dans Firestore : le minimum, sans l'indicateur « d'origine » (recalculé à la lecture). */
export function toStored(s: ReasonSettings): { lists: Record<string, { code: string; label: string; active: boolean; requireComment: boolean }[]> } {
  const lists: Record<string, { code: string; label: string; active: boolean; requireComment: boolean }[]> = {};
  for (const l of REASON_LISTS) lists[l] = s[l].map((it) => ({ code: it.code, label: it.label, active: it.active, requireComment: it.requireComment }));
  return { lists };
}

/** Code d'une nouvelle valeur : stable, unique dans la liste, dérivé du libellé. */
export function newReasonCode(label: string, taken: ReadonlySet<string>): string {
  const slug = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'valeur';
  let code = `c_${slug}`;
  for (let i = 2; taken.has(code); i++) code = `c_${slug}_${i}`;
  return code;
}

// ── Catalogue lu par les moteurs ─────────────────────────────────────────────

export interface ReasonCatalog {
  /** Valeurs proposées et acceptées à la saisie : code → libellé, dans l'ordre. */
  active: Record<ReasonList, Record<string, string>>;
  /** Toutes les valeurs, archivées comprises : pour relire un historique. */
  all: Record<ReasonList, Record<string, string>>;
  /** Codes dont le commentaire est obligatoire. */
  commentRequired: Record<ReasonList, readonly string[]>;
}

export function catalogOf(s: ReasonSettings): ReasonCatalog {
  const active = {} as ReasonCatalog['active'];
  const all = {} as ReasonCatalog['all'];
  const commentRequired = {} as ReasonCatalog['commentRequired'];
  for (const l of REASON_LISTS) {
    active[l] = Object.fromEntries(s[l].filter((i) => i.active).map((i) => [i.code, i.label]));
    all[l] = Object.fromEntries(s[l].map((i) => [i.code, i.label]));
    commentRequired[l] = s[l].filter((i) => i.requireComment).map((i) => i.code);
  }
  return { active, all, commentRequired };
}

export const DEFAULT_REASON_CATALOG: ReasonCatalog = catalogOf(DEFAULT_REASON_SETTINGS);

/** Libellé d'un code, même archivé ; à défaut, le code lui-même (jamais « undefined »). */
export const reasonLabel = (c: ReasonCatalog, list: ReasonList, code: string | null | undefined): string => (code ? (c.all[list][code] ?? DOCUMENT_KO_LABELS[code] ?? code) : '');

/** Les quatre listes de motifs d'inéligibilité, par catégorie. */
export const INELIGIBLE_LIST: Record<string, ReasonList> = { technical: 'ineligible_technical', administrative: 'ineligible_administrative', financial: 'ineligible_financial', zone: 'ineligible_zone' };
