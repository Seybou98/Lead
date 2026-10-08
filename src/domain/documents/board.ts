// Écran Documents (fig. 46) : classement des dossiers en trois colonnes (à relancer, à contrôler, complets),
// compteurs, filtres et libellés de carte. Fonctions pures, sans Firestore : tout vient du résumé documentaire
// recopié sur le lead par le serveur.

import { CLOSED_LEAD_STATUSES, type DocumentKoReason, type DocumentStatus, type LeadStatus } from '../enums';
import type { LeadListItem } from '../leads/leadList';
import { normalizeText } from '../engine/normalize';
import { documentLabel, KO_REASON_LABELS } from './plan';

/** Résumé documentaire d'un lead, tel que lu sur `cl_leads/{id}.documents`. */
export interface LeadDocsInfo {
  expected: number;
  received: number;
  conform: number;
  mandatory: number;
  mandatoryConform: number;
  toCheck: number;
  missing: { code: string; label?: string | null; status: DocumentStatus; koReason: DocumentKoReason | null }[];
  lastReceivedAtMs: number | null;
  completedAtMs: number | null;
  lastRequestAtMs: number | null;
  nextFollowUpAtMs: number | null;
  promisedAtMs: number | null;
  followUpCount: number;
}

export type BoardColumn = 'relaunch' | 'check' | 'complete';

/** Statuts où un dossier documentaire existe encore pour l'équipe. */
const IN_FLOW: readonly LeadStatus[] = ['awaiting_documents', 'missing_info', 'file_ready_to_build', 'file_building'];

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/**
 * Colonne d'un dossier. À contrôler passe avant tout (une pièce reçue attend une réponse) ; « complet » = toutes les
 * obligatoires conformes ; sinon il y a quelque chose à demander. Un dossier au montage n'apparaît dans « Complets »
 * que le jour où il est devenu complet : il n'a plus rien à faire ici.
 */
export function columnOf(l: Pick<LeadListItem, 'status' | 'documentsState' | 'docs'>, nowMs: number): BoardColumn | null {
  if (CLOSED_LEAD_STATUSES.includes(l.status) || !IN_FLOW.includes(l.status)) return null;
  if (l.documentsState === 'none' || !l.docs) return null;
  if (l.docs.toCheck > 0) return 'check';
  if (l.documentsState === 'complete') {
    if (l.status === 'file_building' && !(l.docs.completedAtMs !== null && sameDay(l.docs.completedAtMs, nowMs))) return null;
    return 'complete';
  }
  return 'relaunch';
}

export interface BoardFilters {
  search: string;
  /** '' = tous les produits. */
  product: string;
  order: 'oldest' | 'newest';
  mineOnly: boolean;
}

export const NO_BOARD_FILTERS: BoardFilters = { search: '', product: '', order: 'oldest', mineOnly: false };

export interface Board {
  relaunch: LeadListItem[];
  check: LeadListItem[];
  complete: LeadListItem[];
  /** Dossiers devenus complets aujourd'hui (tous statuts : un dossier passé au montage compte encore). */
  completeToday: number;
}

/** Date de référence du tri « ancienneté » : la dernière demande, sinon la réception du lead. */
const ageOf = (l: LeadListItem): number => l.docs?.lastRequestAtMs ?? l.receivedAtMs;

export function buildBoard(items: readonly LeadListItem[], filters: BoardFilters, uid: string, nowMs: number): Board {
  const q = normalizeText(filters.search);
  const kept = items.filter((l) => {
    if (filters.mineOnly && l.ownerId !== uid) return false;
    if (filters.product && l.productCode !== filters.product) return false;
    if (q && !normalizeText(l.fullName).includes(q)) return false;
    return true;
  });
  const out: Board = { relaunch: [], check: [], complete: [], completeToday: 0 };
  for (const l of kept) {
    if (l.docs?.completedAtMs != null && sameDay(l.docs.completedAtMs, nowMs) && !CLOSED_LEAD_STATUSES.includes(l.status)) out.completeToday += 1;
    const c = columnOf(l, nowMs);
    if (c) out[c].push(l);
  }
  const dir = filters.order === 'oldest' ? 1 : -1;
  out.relaunch.sort((a, b) => dir * (ageOf(a) - ageOf(b)));
  // À contrôler : la pièce reçue depuis le plus longtemps d'abord (ou la dernière, selon l'ordre choisi).
  out.check.sort((a, b) => dir * ((a.docs?.lastReceivedAtMs ?? 0) - (b.docs?.lastReceivedAtMs ?? 0)));
  out.complete.sort((a, b) => -((a.docs?.completedAtMs ?? 0) - (b.docs?.completedAtMs ?? 0)));
  return out;
}

/** Produits présents dans la liste, pour le filtre. */
export const productsOf = (items: readonly LeadListItem[]): string[] => [...new Set(items.map((l) => l.productCode).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, 'fr'));

// ── Libellés de carte ────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** « il y a 12 min », « il y a 1 h », « il y a 3 jours ». */
export function agoShort(fromMs: number, nowMs: number): string {
  const m = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${plural(Math.floor(h / 24), 'jour', 'jours')}`;
}

const hm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** « Aujourd'hui à 10:24 », « Hier à 09:17 », « 12/10 à 09:17 ». */
export function dayAt(ms: number, nowMs: number): string {
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return `Aujourd'hui à ${hm(ms)}`;
  if (days === 1) return `Hier à ${hm(ms)}`;
  return `${new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} à ${hm(ms)}`;
}

export interface RelaunchCard {
  /** Haut droite : promesse du client, sinon ancienneté de la demande. */
  timing: string;
  headline: string;
  detail: string | null;
  /** Pièces manquantes affichées en pastilles (vide si une pièce est rejetée). */
  chips: string[];
  /** Une pièce rejetée : le bouton devient « Redemander ». */
  reask: boolean;
}

export function relaunchCard(l: LeadListItem, nowMs: number): RelaunchCard {
  const d = l.docs;
  const missing = d?.missing ?? [];
  const rejected = missing.filter((m) => m.status === 'non_conform' || m.status === 'to_reask');
  const promised = d?.promisedAtMs ?? null;
  const since = d?.lastRequestAtMs ?? l.receivedAtMs;
  const timing = promised !== null && promised > nowMs - 24 * 3_600_000
    ? `Promis ${dayAt(promised, nowMs).replace(/^Aujourd'hui à/, "aujourd'hui à").replace(/^Hier à/, 'hier à')}`
    : `Depuis ${plural(Math.max(0, Math.floor((nowMs - since) / 86_400_000)), 'jour', 'jours')}`;
  if (rejected.length > 0) {
    const first = rejected[0];
    return {
      timing,
      headline: `${documentLabel(first.code, first.label)} non conforme${rejected.length > 1 ? ` (+${rejected.length - 1})` : ''}`,
      detail: first.koReason ? `Document ${KO_REASON_LABELS[first.koReason].toLowerCase()}` : null,
      chips: [],
      reask: true,
    };
  }
  if (missing.length === 1) return { timing, headline: `${documentLabel(missing[0].code, missing[0].label)} manquant`, detail: null, chips: [], reask: false };
  return { timing, headline: `${missing.length} pièces manquantes`, detail: null, chips: missing.map((m) => documentLabel(m.code, m.label)), reask: false };
}

export interface CheckCard {
  timing: string;
  headline: string;
  /** « tout reçu » : coche verte ; sinon pictogramme « nouvelles pièces ». */
  allReceived: boolean;
}

export function checkCard(l: LeadListItem, nowMs: number): CheckCard {
  const d = l.docs;
  const received = d?.received ?? 0;
  const expected = d?.expected ?? 0;
  const toCheck = d?.toCheck ?? 0;
  const timing = d?.lastReceivedAtMs != null ? `Reçus ${agoShort(d.lastReceivedAtMs, nowMs)}` : 'Reçus';
  const allReceived = expected > 0 && received + (d?.missing.length ?? 0) >= expected && (d?.missing.length ?? 0) === 0;
  return { timing, headline: allReceived ? `${received}/${expected} reçus` : `${plural(toCheck, 'nouvelle pièce', 'nouvelles pièces')}`, allReceived };
}

export function completeCard(l: LeadListItem, nowMs: number): { timing: string; headline: string; ready: boolean } {
  const d = l.docs;
  return {
    timing: d?.completedAtMs != null ? dayAt(d.completedAtMs, nowMs) : '',
    headline: d ? `${d.conform}/${d.expected} conformes` : '',
    ready: l.status === 'file_ready_to_build',
  };
}
