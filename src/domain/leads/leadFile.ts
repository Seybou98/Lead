// Fiche lead (fig. 45, §25.5) : prochaine action, informations essentielles, progression et
// historique récent. Fonctions pures, sans Firestore. Ce qui n'est pas connu n'est jamais inventé :
// une information absente s'affiche « Non renseigné », une étape non atteinte reste « à venir ».

import type { DocumentState, LeadStatus } from '../enums';
import { CONTACTED_STATUSES } from '../admin/campaignStats';
import { normalizeText } from '../engine/normalize';
import {
  ACTION_TYPE_LABELS,
  ENGINE_REASON_LABELS,
  LEAD_STATUS_LABELS,
} from '../labels';

export interface LeadFileData {
  id: string;
  status: LeadStatus;
  productCode: string | null;
  qualification: Record<string, unknown>;
  ownerId: string | null;
  bufferReason: string | null;
  nextAction: { type: string; dueAtMs: number; priority: string; reason: string } | null;
  documents: { state: DocumentState; expected: number; received: number; conform: number; mandatory: number; mandatoryConform: number };
  lastNote: { text: string; atMs: number; authorId: string } | null;
}

export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

// ── Prochaine action ─────────────────────────────────────────────────────────

export interface NextActionView {
  title: string;
  reason: string;
  dueAtMs: number | null;
  overdue: boolean;
  /** Code P0–P4 : réservé au manager et à l'administrateur (§25.1 : masqué au télépro). */
  priority: string | null;
  tone: Tone;
}

export function buildNextAction(lead: LeadFileData, nowMs: number, canSeePriority: boolean): NextActionView {
  const a = lead.nextAction;
  if (!a) {
    // Pas d'action datée : soit le lead attend une attribution, soit il est clos.
    if (lead.ownerId === null) {
      const why = lead.bufferReason ? (ENGINE_REASON_LABELS[lead.bufferReason] ?? lead.bufferReason) : 'en attente d’attribution';
      return { title: 'En attente d’attribution', reason: `Aucun propriétaire : ${why.toLowerCase()}.`, dueAtMs: null, overdue: false, priority: null, tone: 'warning' };
    }
    return { title: 'Aucune action programmée', reason: 'Ce lead n’a pas de prochaine action. Un statut actif devrait toujours en avoir une (RG02).', dueAtMs: null, overdue: false, priority: null, tone: 'danger' };
  }
  const overdue = a.dueAtMs < nowMs;
  return {
    title: ACTION_TYPE_LABELS[a.type] ?? a.type,
    reason: a.reason,
    dueAtMs: a.dueAtMs,
    overdue,
    priority: canSeePriority ? a.priority : null,
    tone: overdue ? 'danger' : 'info',
  };
}

// ── Informations essentielles ────────────────────────────────────────────────

export interface EssentialRow {
  label: string;
  value: string;
  /** true = information manquante, affichée en retrait. */
  missing: boolean;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || normalizeText(t) === 'non renseigne' ? null : t;
};

const YES = ['oui', 'yes', 'true', 'proprietaire', 'proprietaire occupant'];
const NO = ['non', 'no', 'false', 'locataire'];

/** « oui » / « non » ne disent pas tout seuls : on les rattache à la question posée. */
export function housingStatus(qualification: Record<string, unknown>): string | null {
  const raw = str(qualification.isHomeOwner);
  if (raw === null) return str(qualification.ownerType);
  const n = normalizeText(raw);
  if (YES.includes(n)) return 'Propriétaire';
  if (NO.includes(n)) return 'Non propriétaire';
  return raw;
}

export function buildEssentials(lead: LeadFileData, ownerName: string | null): EssentialRow[] {
  const q = lead.qualification;
  const row = (label: string, value: string | null, always = true): EssentialRow | null =>
    value === null ? (always ? { label, value: 'Non renseigné', missing: true } : null) : { label, value, missing: false };

  const surface = str(q.houseSurface);
  const rows = [
    row('Statut logement', housingStatus(q)),
    row('Surface', surface && surface !== '0' ? `${surface} m²` : null, false),
    row('Année de construction', str(q.constructionYear), false),
    row('Chauffage actuel', str(q.currentHeatingType)),
    row('Projet', lead.productCode),
    // Aucun moteur d'éligibilité en V1 de ce lot : on ne prétend pas la connaître.
    { label: 'Éligibilité', value: 'À confirmer', missing: false },
    row('Télépro', ownerName, true),
  ];
  return rows.filter((r): r is EssentialRow => r !== null);
}

// ── Progression ──────────────────────────────────────────────────────────────

export type StepState = 'done' | 'current' | 'todo';

export interface ProgressStep {
  key: 'contacted' | 'interested' | 'documents' | 'sale';
  label: string;
  state: StepState;
  detail: string;
}

const INTERESTED_OR_BEYOND: readonly LeadStatus[] = [
  'interested',
  'awaiting_documents',
  'file_ready_to_build',
  'file_building',
  'missing_info',
  'manager_validation',
  'file_ready',
  'transmitting',
  'transmission_error',
  'converted',
];

export function buildProgress(lead: LeadFileData): ProgressStep[] {
  const contacted = CONTACTED_STATUSES.includes(lead.status);
  const interested = INTERESTED_OR_BEYOND.includes(lead.status);
  const d = lead.documents;
  const docsDone = d.state === 'complete';
  const docsStarted = d.state !== 'none';
  const sold = lead.status === 'converted';

  const docDetail =
    d.expected > 0 ? `${d.received}/${d.expected} pièces reçues` : docsStarted ? 'Documents demandés' : 'À venir';

  // Une seule étape est « en cours » : la première non terminée.
  const raw: { key: ProgressStep['key']; label: string; done: boolean; detail: string }[] = [
    { key: 'contacted', label: 'Contacté', done: contacted, detail: contacted ? 'Client joint' : 'À venir' },
    { key: 'interested', label: 'Intéressé', done: interested, detail: interested ? 'Intérêt confirmé' : 'À venir' },
    { key: 'documents', label: 'Documents', done: docsDone, detail: docsDone ? 'Complets' : docDetail },
    { key: 'sale', label: 'Vente', done: sold, detail: sold ? 'Convertie' : 'À venir' },
  ];
  const firstTodo = raw.findIndex((s) => !s.done);
  return raw.map((s, i) => ({
    key: s.key,
    label: s.label,
    detail: s.detail,
    state: s.done ? 'done' : i === firstTodo ? 'current' : 'todo',
  }));
}

// ── Historique ───────────────────────────────────────────────────────────────

export interface EventInput {
  id: string;
  type: string;
  atMs: number;
  actorId: string;
  reason?: string;
  note?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export type TimelineKind = 'created' | 'assigned' | 'status' | 'call' | 'note' | 'document' | 'alert' | 'other';

export interface TimelineItem {
  id: string;
  atMs: number;
  kind: TimelineKind;
  title: string;
  detail: string | null;
}

const actorName = (names: ReadonlyMap<string, string>, id: string) =>
  id === 'engine' ? 'le moteur' : id === 'system' ? 'le système' : (names.get(id) ?? id);

const statusLabel = (v: unknown) => (typeof v === 'string' ? (LEAD_STATUS_LABELS[v as LeadStatus] ?? v) : '—');

export function eventToTimeline(e: EventInput, users: ReadonlyMap<string, string>): TimelineItem {
  const base = { id: e.id, atMs: e.atMs };
  const reasonText = e.reason ? (ENGINE_REASON_LABELS[e.reason] ?? e.reason) : null;

  switch (e.type) {
    case 'created':
      return { ...base, kind: 'created', title: 'Lead reçu', detail: 'Lead créé et intégré dans le système.' };
    case 'assigned': {
      const to = e.after?.ownerId;
      return { ...base, kind: 'assigned', title: `Attribué à ${typeof to === 'string' ? (users.get(to) ?? to) : '—'}`, detail: reasonText ? `Raison : ${reasonText.toLowerCase()}.` : null };
    }
    case 'reassigned': {
      const from = e.before?.ownerId;
      const to = e.after?.ownerId;
      const f = typeof from === 'string' ? (users.get(from) ?? from) : '—';
      const t = typeof to === 'string' ? (users.get(to) ?? to) : '—';
      return { ...base, kind: 'assigned', title: `Réattribué de ${f} à ${t}`, detail: e.reason ? `Motif : ${e.reason}` : null };
    }
    case 'status_changed':
      return { ...base, kind: 'status', title: `Statut : ${statusLabel(e.before?.status)} → ${statusLabel(e.after?.status)}`, detail: e.note ?? null };
    case 'call_result':
      return { ...base, kind: 'call', title: 'Appel qualifié', detail: e.note ?? reasonText };
    case 'note':
      return { ...base, kind: 'note', title: `Note de ${actorName(users, e.actorId)}`, detail: e.note ?? null };
    case 'document':
      return { ...base, kind: 'document', title: 'Document', detail: e.note ?? reasonText };
    case 'duplicate_interaction':
      return { ...base, kind: 'other', title: 'Nouvelle demande rattachée à ce lead', detail: e.note ?? null };
    case 'alert':
      return { ...base, kind: 'alert', title: 'Alerte', detail: e.note ?? reasonText };
    case 'field_corrected':
      return { ...base, kind: 'other', title: 'Donnée corrigée', detail: e.reason ? `Motif : ${e.reason}` : null };
    case 'conversion':
      return { ...base, kind: 'other', title: 'Conversion', detail: e.note ?? null };
    case 'exception':
      return { ...base, kind: 'alert', title: 'Exception', detail: e.note ?? reasonText };
    default:
      return { ...base, kind: 'other', title: e.type, detail: e.note ?? null };
  }
}

/**
 * Rang de création quand deux événements ont exactement la même heure (le moteur écrit « créé » et
 * « attribué » dans la même transaction) : le lead est d'abord reçu, puis attribué, puis le reste.
 * Sans cela l'ordre dépendrait de l'identifiant du document, donc du hasard.
 */
const TIE_RANK: Record<string, number> = { created: 0, assigned: 1, reassigned: 1, alert: 1 };
const rank = (type: string) => TIE_RANK[type] ?? 2;

/** Du plus récent au plus ancien. */
export function buildTimeline(events: readonly EventInput[], users: ReadonlyMap<string, string>): TimelineItem[] {
  return [...events]
    .sort((a, b) => b.atMs - a.atMs || rank(b.type) - rank(a.type))
    .map((e) => eventToTimeline(e, users));
}
