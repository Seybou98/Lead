// Import CSV de leads (§4.1, §24.2). Fonctions pures, sans Firestore ni navigateur : lecture du fichier, rapprochement
// des colonnes, construction du payload de chaque ligne et contrôle AVANT envoi. Le serveur applique ensuite exactement
// le pipeline des autres sources (donnée brute, normalisation, doublons, attribution, SLA) : ce module ne décide de rien
// d'autre que « cette ligne est-elle exploitable ? ».

import { normalizeText } from '../engine/normalize';
import { mapPayload, SYNONYMS } from './mapPayload';

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_COLUMNS = 60;
export const BATCH_SIZE = 10;

export type Delimiter = ';' | ',' | '\t';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
  /** Lignes ignorées parce qu'au-delà de la limite. */
  truncated: number;
  /** Lignes vides ignorées. */
  skippedEmpty: number;
}

/** Séparateur le plus fréquent dans la première ligne, hors guillemets. */
function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c as Delimiter] += 1;
  }
  return counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0 ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

/** Lecture RFC 4180 : guillemets doublés, retours à la ligne dans une cellule, CRLF ou LF, BOM ignoré. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const all: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell.trim());
    cell = '';
  };
  const endRow = () => {
    endCell();
    all.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) endRow();

  const isEmpty = (r: string[]) => r.every((x) => x === '');
  const nonEmpty = all.filter((r) => !isEmpty(r));
  const skippedEmpty = all.length - nonEmpty.length;
  const [head = [], ...body] = nonEmpty;
  const seen = new Map<string, number>();
  const headers = head.slice(0, MAX_IMPORT_COLUMNS).map((h, i) => {
    const base = h || `Colonne ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  return { headers, rows: body.slice(0, MAX_IMPORT_ROWS).map((r) => r.slice(0, headers.length)), delimiter, truncated: Math.max(0, body.length - MAX_IMPORT_ROWS), skippedEmpty };
}

// ── Rapprochement des colonnes ───────────────────────────────────────────────

export interface ImportField {
  /** Clé du payload attendue par la réception (mapPayload). */
  key: string;
  label: string;
  hint?: string;
  /** Nom du champ dans le payload, s'il diffère de la clé (la réception ne connaît que ses synonymes). */
  payloadKey?: string;
  /** Noms de colonne reconnus en plus des synonymes de la réception. */
  extra?: string[];
}

export const IMPORT_FIELDS: readonly ImportField[] = [
  { key: 'fullName', label: 'Nom complet', hint: 'Prénom et nom dans une seule colonne', extra: ['nom et prénom', 'nom prenom', 'client', 'contact'] },
  { key: 'firstName', label: 'Prénom' },
  { key: 'lastName', label: 'Nom' },
  { key: 'phone', label: 'Téléphone', extra: ['portable', 'gsm', 'numéro', 'numero', 'telephone mobile', 'tel portable'] },
  { key: 'email', label: 'Email', extra: ['mail', 'courriel', 'adresse mail', 'adresse e-mail'] },
  { key: 'addressLine', label: 'Adresse', extra: ['rue', 'adresse postale', 'adresse du logement'] },
  { key: 'postalCode', label: 'Code postal', extra: ['code postal', 'zip', 'postal'] },
  { key: 'city', label: 'Ville', extra: ['commune', 'localité', 'localite'] },
  { key: 'productCode', label: 'Produit', hint: 'Rapproché de la famille du catalogue', extra: ['produit', 'type de produit', 'equipement', 'équipement'] },
  { key: 'campaignName', payloadKey: 'campaign', label: 'Campagne', hint: 'Nom exact d’une campagne existante', extra: ['campagne', 'nom de la campagne'] },
  { key: 'externalId', label: 'Identifiant externe', hint: 'Évite de recréer un lead déjà importé', extra: ['id', 'identifiant', 'reference', 'référence', 'ref'] },
  { key: 'consent', label: 'Consentement', hint: 'oui / non', extra: ['rgpd', 'opt-in', 'optin', 'accord'] },
];

/** Pour chaque colonne du fichier, le champ proposé (ou « » pour l'ignorer). Une colonne par champ au plus. */
export function suggestMapping(headers: readonly string[]): string[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const n = normalizeText(h);
    if (!n) return '';
    const field = IMPORT_FIELDS.find((f) => {
      if (used.has(f.key)) return false;
      const names = [...(SYNONYMS[f.key] ?? []), ...(f.extra ?? []), f.label];
      return names.some((x) => normalizeText(x) === n);
    });
    if (!field) return '';
    used.add(field.key);
    return field.key;
  });
}

/** Un champ ne peut venir que d'une colonne : renvoie les champs choisis plusieurs fois. */
export function duplicateTargets(mapping: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of mapping) {
    if (!k) continue;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

/** La ligne devient le payload reçu par la réception ; les valeurs par défaut ne remplacent jamais une cellule renseignée. */
export function buildPayload(row: readonly string[], mapping: readonly string[], defaults: { campaignId?: string; productCode?: string } = {}): Record<string, string> {
  const payload: Record<string, string> = {};
  mapping.forEach((key, i) => {
    const field = IMPORT_FIELDS.find((f) => f.key === key);
    if (!field) return;
    const v = (row[i] ?? '').trim();
    const target = field.payloadKey ?? field.key;
    if (v && !payload[target]) payload[target] = v;
  });
  if (defaults.campaignId && !payload.campaign) payload.campaignId = defaults.campaignId;
  if (defaults.productCode && !payload.productCode) payload.productCode = defaults.productCode;
  return payload;
}

// ── Contrôle avant envoi ─────────────────────────────────────────────────────

export type RowStatus = 'ok' | 'warning' | 'error';

export interface RowCheck {
  /** Numéro de ligne dans le fichier (l'en-tête est la ligne 1). */
  line: number;
  status: RowStatus;
  problems: string[];
  /** Valeurs reconnues, pour l'aperçu. */
  name: string;
  phone: string | null;
  email: string | null;
}

/**
 * Contrôle d'une ligne avec les MÊMES règles que la réception (téléphone et email normalisés, au moins un moyen de
 * contact). Un téléphone illisible reste un avertissement tant qu'un email valide permet de joindre la personne.
 */
export function checkRows(payloads: readonly Record<string, string>[]): RowCheck[] {
  const firstSeen = new Map<string, number>();
  return payloads.map((p, i) => {
    const line = i + 2;
    const m = mapPayload(p, {});
    const problems: string[] = [];
    let status: RowStatus = 'ok';
    if (!m.phone && !m.email) {
      status = 'error';
      problems.push(m.phoneRaw || m.emailRaw ? 'Ni téléphone ni email exploitable.' : 'Aucun téléphone ni email.');
    } else {
      if (m.phoneRaw && !m.phone) { status = 'warning'; problems.push(`Téléphone illisible (« ${m.phoneRaw} ») : ignoré.`); }
      if (m.emailRaw && !m.email) { status = 'warning'; problems.push(`Email illisible (« ${m.emailRaw} ») : ignoré.`); }
    }
    if (!m.fullName) {
      if (status === 'ok') status = 'warning';
      problems.push('Nom manquant.');
    }
    for (const key of [m.phone, m.email].filter((x): x is string => !!x)) {
      const prev = firstSeen.get(key);
      if (prev !== undefined) {
        if (status === 'ok') status = 'warning';
        problems.push(`Même ${key.includes('@') ? 'email' : 'téléphone'} que la ligne ${prev} : rattaché au lead existant, pas de doublon créé.`);
      } else firstSeen.set(key, line);
    }
    return { line, status, problems, name: m.fullName, phone: m.phone, email: m.email };
  });
}

export interface ImportSummary {
  total: number;
  ok: number;
  warning: number;
  error: number;
}

export const summarize = (checks: readonly RowCheck[]): ImportSummary => ({ total: checks.length, ok: checks.filter((c) => c.status === 'ok').length, warning: checks.filter((c) => c.status === 'warning').length, error: checks.filter((c) => c.status === 'error').length });

/** Découpe en lots : une requête serveur traite peu de lignes pour rester sous le délai d'une fonction. */
export function batches<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lots de lignes CONSÉCUTIVES du fichier : le serveur numérote un lot à partir de sa première ligne, donc un trou en démarre un nouveau. */
export function lineBatches<T extends { line: number }>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.length < size && last[last.length - 1].line + 1 === it.line) last.push(it);
    else out.push([it]);
  }
  return out;
}

/** Fichier des lignes refusées ou en erreur, prêt à corriger et à ré-importer (mêmes colonnes + motif). */
export function rejectsCsvRows(headers: readonly string[], rows: readonly (readonly string[])[], rejects: readonly { line: number; reason: string }[]): (string | number)[][] {
  return [[...headers, 'Ligne', 'Motif du refus'], ...rejects.map((r) => [...(rows[r.line - 2] ?? []), r.line, r.reason])];
}
