// Liste des leads : lignes, filtres, onglets rapides, âge et SLA. Fonctions pures, sans Firestore.

import type { AssignmentState, DocumentState, LeadStatus, PriorityClass, Temperature } from '../enums';
import { normalizeText } from '../engine/normalize';
import { workingElapsedMs, type ScheduleLike } from '../engine/schedule';
import { CLOSED_LEAD_STATUSES } from '../enums';
import type { LeadDocsInfo } from '../documents/board';
import type { ActivityEntry } from './activity';

export interface LeadListItem {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string;
  postalCode: string;
  campaignId: string | null;
  productCode: string | null;
  status: LeadStatus;
  temperature: Temperature | null;
  assignmentState: AssignmentState;
  bufferReason: string | null;
  ownerId: string | null;
  receivedAtMs: number;
  /** Démarrage du compteur SLA ; null si absent. */
  slaStartedAtMs: number | null;
  /** Arrêt du compteur : seul un changement de statut valide le renseigne (RG03). */
  slaStoppedAtMs: number | null;
  nextAction: { type: string; dueAtMs: number; priority: PriorityClass; reason: string } | null;
  documentsState: DocumentState;
  /** Résumé documentaire détaillé (écran Documents) ; absent si aucun document n'a été demandé. */
  docs?: LeadDocsInfo;
  /** Dernières actions utiles (prise en charge, NR, note, documents), de la plus récente à la plus ancienne. */
  activity?: ActivityEntry[];
  duplicate: boolean;
  excluded: boolean;
  /** Cycle NR en cours (§8.1) ; absent = aucun NR enregistré. */
  nr?: { attempt: number; cycle: number };
  /** Résumé du montage du dossier (recopié par le serveur) ; absent tant qu'aucun brouillon n'a été enregistré. */
  montage?: { validationState: string; blocking: number; toConfirm: number; totalTtcCents: number; remainderCents: number; updatedAtMs: number | null; financingMode?: string | null };
  /** Axes commercial et financier (§23.9) ; absents tant qu'aucune vente n'est créée. */
  commercialState?: string;
  financialState?: string;
  /** Instant où la vente est devenue sécurisée (signée et réglée) ; absent tant qu'elle ne l'est pas. */
  securedAtMs?: number | null;
  /** Suivi de la vente : relances, acompte attendu, organisme de financement. */
  saleTrack?: { lastReminderAtMs: number | null; reminderCount: number; depositCents: number | null; financingOrganism: string | null; offerSentAtMs: number | null; signedAtMs: number | null };
  /** Transmission au CRM principal ; absent tant qu'aucune vente n'est créée. */
  conversion?: { state: string; clientId: string | null; dossierId: string | null };
}

export interface LeadNames {
  users: ReadonlyMap<string, string>;
  campaigns: ReadonlyMap<string, string>;
}

export interface LeadRow extends LeadListItem {
  ownerName: string;
  campaignName: string;
}

export const DEFAULT_SLA_MS = 5 * 60_000;

/**
 * Réglages du SLA appliqués dans CE navigateur (Paramètres → SLA et horaires). Un seul état partagé, alimenté une fois
 * par l'application : tous les compteurs et couleurs lisent la même valeur. Par défaut : les valeurs du cahier.
 */
export interface SlaRuntime {
  slaMs: number;
  /** Le temps hors horaires ne compte pas dans l'âge du lead. */
  suspendOutsideHours: boolean;
  schedule: ScheduleLike | null;
}

let slaRuntime: SlaRuntime = { slaMs: DEFAULT_SLA_MS, suspendOutsideHours: false, schedule: null };
export const setSlaRuntime = (r: SlaRuntime): void => {
  slaRuntime = r;
};
export const resetSlaRuntime = (): void => setSlaRuntime({ slaMs: DEFAULT_SLA_MS, suspendOutsideHours: false, schedule: null });
/** Délai du SLA en vigueur (5 minutes tant qu'aucun réglage n'est chargé). */
export const getSlaMs = (): number => slaRuntime.slaMs;

/** Âge du lead pour le compteur : uniquement tant qu'aucun statut de traitement n'a été enregistré. */
export function slaAgeMs(l: Pick<LeadListItem, 'status' | 'slaStartedAtMs' | 'slaStoppedAtMs'>, nowMs: number): number | null {
  if (l.status !== 'new' || l.slaStoppedAtMs !== null || l.slaStartedAtMs === null) return null;
  if (slaRuntime.suspendOutsideHours && slaRuntime.schedule) return workingElapsedMs(slaRuntime.schedule, l.slaStartedAtMs, nowMs);
  return Math.max(0, nowMs - l.slaStartedAtMs);
}

export type SlaLevel = 'ok' | 'warning' | 'breached';

/** Couleur progressive (§5.1) : calme jusqu'aux 3/5 du délai, orange ensuite, rouge au dépassement. */
export function slaLevel(ageMs: number, slaMs = getSlaMs()): SlaLevel {
  if (ageMs > slaMs) return 'breached';
  if (ageMs >= slaMs * 0.6) return 'warning';
  return 'ok';
}

/** « 02:43 » ; « 1:05:12 » au-delà d'une heure. */
export function formatCounter(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** « il y a 5 min », « il y a 2 h », « il y a 3 j ». */
export function formatAgo(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export function buildLeadRows(items: readonly LeadListItem[], names: LeadNames): LeadRow[] {
  return items.map((l) => ({
    ...l,
    ownerName: l.ownerId ? (names.users.get(l.ownerId) ?? l.ownerId) : '—',
    campaignName: l.campaignId ? (names.campaigns.get(l.campaignId) ?? l.campaignId) : '—',
  }));
}

// ── Onglets rapides ──────────────────────────────────────────────────────────

export type QuickTab = 'all' | 'new' | 'buffer' | 'interested' | 'documents' | 'closed';

const DOCUMENT_STATUSES: readonly LeadStatus[] = ['awaiting_documents', 'file_ready_to_build', 'missing_info'];

export const QUICK_TAB_MATCH: Record<QuickTab, (l: LeadListItem) => boolean> = {
  all: () => true,
  new: (l) => l.status === 'new',
  // « File tampon » : tout lead sans propriétaire, y compris ceux à examiner par un manager.
  buffer: (l) => l.ownerId === null && !CLOSED_LEAD_STATUSES.includes(l.status),
  interested: (l) => l.status === 'interested',
  documents: (l) => DOCUMENT_STATUSES.includes(l.status),
  closed: (l) => CLOSED_LEAD_STATUSES.includes(l.status),
};

export function quickTabCounts(items: readonly LeadListItem[]): Record<QuickTab, number> {
  const out = {} as Record<QuickTab, number>;
  for (const k of Object.keys(QUICK_TAB_MATCH) as QuickTab[]) out[k] = items.filter(QUICK_TAB_MATCH[k]).length;
  return out;
}

// ── Filtres ──────────────────────────────────────────────────────────────────

export interface LeadFilters {
  tab: QuickTab;
  search: string;
  status: LeadStatus | 'all';
  campaignId: string | 'all';
  /** uid, 'none' (sans propriétaire) ou 'all'. */
  ownerId: string | 'none' | 'all';
  temperature: Temperature | 'all';
}

export const NO_LEAD_FILTERS: LeadFilters = { tab: 'all', search: '', status: 'all', campaignId: 'all', ownerId: 'all', temperature: 'all' };

const digits = (s: string) => s.replace(/\D/g, '');

export function filterLeadRows(rows: readonly LeadRow[], f: LeadFilters): LeadRow[] {
  const q = normalizeText(f.search);
  const qDigits = digits(f.search);
  return rows.filter((r) => {
    if (!QUICK_TAB_MATCH[f.tab](r)) return false;
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.campaignId !== 'all' && r.campaignId !== f.campaignId) return false;
    if (f.ownerId === 'none' ? r.ownerId !== null : f.ownerId !== 'all' && r.ownerId !== f.ownerId) return false;
    if (f.temperature !== 'all' && r.temperature !== f.temperature) return false;
    if (q) {
      const hay = normalizeText(`${r.fullName} ${r.email ?? ''} ${r.city} ${r.id}`);
      // Un numéro se retrouve quelle que soit sa mise en forme (06 12…, +33 6…) : on compare les chiffres,
      // seulement si la saisie en contient assez pour ne pas tout trouver.
      const phoneHit = qDigits.length >= 3 && digits(r.phone ?? '').includes(qDigits.replace(/^0/, ''));
      if (!hay.includes(q) && !phoneHit) return false;
    }
    return true;
  });
}

/**
 * Tri : les plus récents d'abord. Les leads Nouveaux dont le compteur tourne passent AVANT, du plus
 * ancien (le plus en retard) au plus récent : l'urgence prime sur la date (RG05).
 */
export function sortLeadRows(rows: readonly LeadRow[], nowMs: number): LeadRow[] {
  return [...rows].sort((a, b) => {
    const aa = slaAgeMs(a, nowMs);
    const bb = slaAgeMs(b, nowMs);
    if (aa !== null && bb !== null) return bb - aa;
    if (aa !== null) return -1;
    if (bb !== null) return 1;
    return b.receivedAtMs - a.receivedAtMs;
  });
}

/** « +33612345678 » → « 06 12 34 56 78 ». Un numéro non français est affiché tel que stocké (E.164). */
export function formatPhoneDisplay(phone: string | null): string {
  if (!phone) return '—';
  const m = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(phone);
  return m ? `0${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : phone;
}
