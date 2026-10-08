// Workflow documentaire (§10, fig. 46). Fonctions PURES : état d'un dossier à partir de ses pièces, cadence des
// relances (J+1, J+3, J+5, J+7, J+14), et planification de chaque action (réception, contrôle, relance,
// décision). La couche serveur (functions/src/documents.ts) lit, appelle ce planificateur, puis écrit TOUT en
// une transaction ; le navigateur réutilise `summarizeDocuments` et `buildReminderMessage`.

import {
  CLOSED_LEAD_STATUSES,
  DOCUMENT_KO_REASONS,
  type ActionType,
  type DocumentKoReason,
  type DocumentState,
  type DocumentStatus,
  type LeadStatus,
  type PriorityClass,
  type Role,
} from '../enums';
import { nextWorkingTime, type ScheduleLike } from '../engine/schedule';
import { DOCUMENT_CHANNELS, DEFAULT_DOCUMENT_TYPES } from '../call/outcomes';
import { formatWhen, loadDeltaFor, type LoadBucket } from '../call/plan';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// ── Libellés ─────────────────────────────────────────────────────────────────

export const KO_REASON_LABELS: Record<DocumentKoReason, string> = {
  unreadable: 'Illisible',
  incomplete: 'Incomplet',
  expired: 'Expiré',
  wrong_document: 'Mauvais document',
  inconsistent_info: 'Informations incohérentes',
  other: 'Autre',
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  expected: 'Attendu',
  received: 'Reçu — à contrôler',
  conform: 'Conforme',
  non_conform: 'Non conforme',
  to_reask: 'À redemander',
};

/** Libellé d'une pièce d'après son code (checklist par défaut ; le code lui-même si la pièce est inconnue). */
/** Libellé d'une pièce : celui enregistré avec la pièce (checklist du produit), sinon la liste d'origine, sinon le code. */
export const documentLabel = (code: string, label?: string | null): string => (label && label.trim() ? label : (DEFAULT_DOCUMENT_TYPES.find((t) => t.code === code)?.label ?? code));

// ── État d'un dossier ────────────────────────────────────────────────────────

export interface DocRow {
  code: string;
  /** Libellé figé à la demande ; absent sur les anciens dossiers. */
  label?: string | null;
  mandatory: boolean;
  status: DocumentStatus;
  koReason?: DocumentKoReason | null;
}

export interface DocSummary {
  state: DocumentState;
  expected: number;
  /** Pièces reçues ET non rejetées : une pièce non conforme ne compte pas dans la progression (§10.3). */
  received: number;
  conform: number;
  mandatory: number;
  mandatoryConform: number;
  /** Pièces reçues, en attente de contrôle. */
  toCheck: number;
}

const isRejected = (s: DocumentStatus) => s === 'non_conform' || s === 'to_reask';
const isIn = (s: DocumentStatus) => s === 'received' || s === 'conform';

export function summarizeDocuments(rows: readonly DocRow[]): DocSummary {
  const mandatoryRows = rows.filter((r) => r.mandatory);
  const mandatoryConform = mandatoryRows.filter((r) => r.status === 'conform').length;
  const base = {
    expected: rows.length,
    received: rows.filter((r) => isIn(r.status)).length,
    conform: rows.filter((r) => r.status === 'conform').length,
    mandatory: mandatoryRows.length,
    mandatoryConform,
    toCheck: rows.filter((r) => r.status === 'received').length,
  };
  if (rows.length === 0) return { state: 'none', ...base };
  // Toutes les pièces obligatoires conformes. Sans aucune pièce obligatoire, toutes les pièces doivent l'être.
  const target = mandatoryRows.length > 0 ? mandatoryRows : rows;
  if (target.every((r) => r.status === 'conform') && !rows.some((r) => isRejected(r.status))) return { state: 'complete', ...base };
  if (rows.some((r) => isRejected(r.status))) return { state: 'incomplete_non_conform', ...base };
  if (target.every((r) => isIn(r.status))) return { state: 'received_to_check', ...base };
  if (base.received > 0) return { state: 'partial', ...base };
  return { state: 'requested', ...base };
}

/** Pièces à citer dans une relance : celles qui manquent ou qui ont été rejetées (§10.3). */
export function missingRows(rows: readonly DocRow[]): DocRow[] {
  return rows.filter((r) => r.status === 'expected' || isRejected(r.status));
}

/** Message de relance prêt à copier : cite exactement les pièces manquantes ou rejetées, avec le motif du rejet. */
export function buildReminderMessage(firstName: string, rows: readonly DocRow[]): string {
  const lines = missingRows(rows).map((r) => {
    const why = r.status !== 'expected' && r.koReason ? ` (${KO_REASON_LABELS[r.koReason].toLowerCase()})` : '';
    return `- ${documentLabel(r.code, r.label)}${why}`;
  });
  const hello = firstName.trim() ? `Bonjour ${firstName.trim()},` : 'Bonjour,';
  if (lines.length === 0) return `${hello}\n\nNous avons bien reçu l'ensemble de vos documents. Merci !`;
  return `${hello}\n\nPour avancer sur votre dossier, il nous manque encore :\n${lines.join('\n')}\n\nVous pouvez nous les renvoyer en répondant à ce message. Merci !`;
}

// ── Cadence des relances (§10.4) ─────────────────────────────────────────────

export interface DocumentRules {
  /** Jours, depuis la demande, des relances successives : J+1, J+3, J+5, J+7 puis la décision à J+14. */
  followUpDays: readonly number[];
  /** Délai avant une nouvelle décision quand on choisit de poursuivre. */
  decisionRepeatDays: number;
  promisedMarginMinutes: number;
  recycleAfterDays: number;
  schedule: ScheduleLike;
}

export const DEFAULT_DOCUMENT_RULES: DocumentRules = {
  followUpDays: [1, 3, 5, 7, 14],
  decisionRepeatDays: 7,
  promisedMarginMinutes: 30,
  recycleAfterDays: 7,
  schedule: { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })) },
};

export type FollowUpKind = 'followup' | 'priority' | 'red_alert' | 'decision';

export interface FollowUpStep {
  /** Numéro d'étape (0 = J+1). */
  index: number;
  kind: FollowUpKind;
  day: number;
  dueAtMs: number;
}

/**
 * Prochaine étape de la cadence. `done` = nombre de relances déjà faites (la décision en compte une).
 * Au-delà de l'échéance finale : une décision se répète tous les `decisionRepeatDays`. Chaque étape est ramenée
 * dans les horaires de travail et laisse au moins un jour après la précédente relance.
 */
export function nextFollowUpStep(args: { requestAtMs: number; lastFollowUpAtMs: number | null; done: number; rules: DocumentRules }): FollowUpStep | null {
  const { requestAtMs, lastFollowUpAtMs, done, rules } = args;
  const days = rules.followUpDays;
  if (days.length === 0) return null;
  const idx = Math.max(0, done);
  const last = days.length - 1;
  const day = idx <= last ? days[idx] : days[last] + (idx - last) * rules.decisionRepeatDays;
  const kind: FollowUpKind = idx >= last ? 'decision' : idx === last - 1 ? 'red_alert' : idx === 2 ? 'priority' : 'followup';
  const natural = requestAtMs + day * DAY;
  const earliest = lastFollowUpAtMs !== null ? lastFollowUpAtMs + DAY : 0;
  const dueAtMs = nextWorkingTime(rules.schedule, Math.max(natural, earliest));
  if (dueAtMs === null) return null;
  return { index: idx, kind, day, dueAtMs };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export interface FileMeta {
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  originalName: string;
}

export const RECEIVE_CHANNELS = { ...DOCUMENT_CHANNELS, upload: 'Dépôt' } as const;
export type ReceiveChannel = keyof typeof RECEIVE_CHANNELS;

export const DECISION_CLOSE_REASONS = { not_interested: 'Plus intéressé', ineligible: 'Inéligible', other: 'Autre motif' } as const;
export type DecisionCloseReason = keyof typeof DECISION_CLOSE_REASONS;

export type DocumentActionInput =
  | { kind: 'receive'; code: string; channel?: ReceiveChannel; file?: FileMeta | null; note?: string }
  | { kind: 'check'; code: string; verdict: 'conform' | 'non_conform'; koReason?: DocumentKoReason; comment?: string }
  | { kind: 'reask'; code: string }
  | { kind: 'follow_up'; channel: keyof typeof DOCUMENT_CHANNELS; note?: string }
  | { kind: 'decide'; decision: 'continue' | 'recycle' | 'close'; closeReason?: DecisionCloseReason; comment?: string }
  | { kind: 'start_building' };

export type DocumentActionKind = DocumentActionInput['kind'];

export interface DocLead {
  id: string;
  status: LeadStatus;
  ownerId: string | null;
  managerIds: readonly string[];
  /** Action ouverte en cours ; null si aucune. */
  nextActionId: string | null;
  lastRequestAtMs: number | null;
  lastFollowUpAtMs: number | null;
  /** Relances déjà faites (décisions comprises). */
  followUpCount: number;
  promisedAtMs: number | null;
}

export interface DocContext {
  lead: DocLead;
  docs: readonly DocRow[];
  actorId: string;
  actorRole: Role;
  nowMs: number;
  requestId: string;
  rules: DocumentRules;
}

export interface DocPatch {
  code: string;
  status: DocumentStatus;
  koReason: DocumentKoReason | null;
  koComment: string | null;
  /** undefined = inchangé. */
  receivedAtMs?: number;
  channel?: string | null;
  file?: FileMeta | null;
  checkedBy?: string | null;
  checkedAtMs?: number | null;
}

/** Pièce manquante ou rejetée, recopiée sur le lead pour l'écran Documents (une carte = une ligne, sans relire les pièces). */
export interface MissingPiece {
  code: string;
  label?: string | null;
  status: DocumentStatus;
  koReason: DocumentKoReason | null;
}

export interface DocPlannedAction {
  id: string;
  type: ActionType;
  priority: PriorityClass;
  dueAtMs: number;
  reason: string;
  dedupeKey: string;
}

export interface DocPlannedEvent {
  key: string;
  type: 'document' | 'status_changed';
  note?: string;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface DocumentPlan {
  action: DocumentActionKind;
  docPatches: DocPatch[];
  summary: DocSummary;
  statusBefore: LeadStatus;
  status: LeadStatus;
  nextAction: DocPlannedAction | null;
  completedActionId: string | null;
  leadDocuments: {
    lastRequestAtMs: number | null;
    lastFollowUpAtMs: number | null;
    followUpCount: number;
    nextFollowUpAtMs: number | null;
    missing: MissingPiece[];
    /** undefined = inchangé. */
    lastReceivedAtMs?: number;
    /** Instant où le dossier est devenu complet ; null = ne l'est plus ; undefined = inchangé. */
    completedAtMs?: number | null;
    /** true : l'heure promise est levée (réception ou relance). */
    clearPromised: boolean;
  };
  loadDelta: Partial<Record<LoadBucket, number>>;
  events: DocPlannedEvent[];
  /** Phrase de confirmation (§25.9). */
  message: string;
}

export type DocumentPlanResult =
  | { ok: true; plan: DocumentPlan }
  | { ok: false; code: 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid'; message: string };

/** Statuts dans lesquels le dossier documentaire se travaille. */
const DOC_STATUSES: readonly LeadStatus[] = ['awaiting_documents', 'missing_info', 'file_ready_to_build'];

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const has = (obj: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

const CLOSE_STATUS: Record<DecisionCloseReason, LeadStatus> = { not_interested: 'not_interested', ineligible: 'ineligible', other: 'not_interested' };

export function planDocumentAction(input: DocumentActionInput, ctx: DocContext): DocumentPlanResult {
  const { lead, nowMs, rules } = ctx;
  const tz = rules.schedule.timezone;
  const fail = (code: 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid', message: string): DocumentPlanResult => ({ ok: false, code, message });

  // Droit : propriétaire, manager du lead, ou administrateur.
  const allowed =
    ctx.actorRole === 'admin' ||
    (ctx.actorRole === 'manager' && lead.managerIds.includes(ctx.actorId)) ||
    (ctx.actorRole === 'telepro' && lead.ownerId === ctx.actorId);
  if (!allowed) return fail('forbidden', "Seul le propriétaire du lead, son manager ou un administrateur peut traiter ses documents.");
  if (CLOSED_LEAD_STATUSES.includes(lead.status)) return fail('lead_closed', 'Ce lead est clôturé : ses documents ne peuvent plus être modifiés.');
  const canBuild = input.kind === 'start_building';
  if (!DOC_STATUSES.includes(lead.status) && !(lead.status === 'file_building' && !canBuild)) {
    return fail('unavailable', "Aucun dossier documentaire n'est en cours pour ce lead.");
  }
  if (ctx.docs.length === 0) return fail('unavailable', "Aucune pièce n'a été demandée pour ce lead.");

  const rows = new Map(ctx.docs.map((d) => [d.code, d]));
  const patches = new Map<string, DocPatch>();
  const events: DocPlannedEvent[] = [];
  let message = '';
  let clearPromised = false;
  let lastFollowUpAtMs = lead.lastFollowUpAtMs;
  let followUpCount = lead.followUpCount;
  const lastRequestAtMs = lead.lastRequestAtMs;
  let forcedStatus: LeadStatus | null = null;
  let forcedAction: DocPlannedAction | null | undefined;
  let closed = false;

  const label = (code: string) => documentLabel(code, rows.get(code)?.label);
  const mkAction = (type: ActionType, priority: PriorityClass, dueAtMs: number, reason: string): DocPlannedAction => ({
    id: `${lead.id}_${type}_${ctx.requestId}`,
    type,
    priority,
    dueAtMs,
    reason,
    dedupeKey: `${lead.id}:${type}:${ctx.requestId}`,
  });
  const current = (code: string): DocRow | null => rows.get(code) ?? null;
  const apply = (p: DocPatch) => {
    patches.set(p.code, p);
    const r = rows.get(p.code)!;
    rows.set(p.code, { ...r, status: p.status, koReason: p.koReason });
  };

  switch (input.kind) {
    case 'receive': {
      const row = current(input.code);
      if (!row) return fail('invalid', 'Cette pièce ne fait pas partie de la liste demandée.');
      if (input.channel !== undefined && !has(RECEIVE_CHANNELS, input.channel)) return fail('invalid', "Canal de réception inconnu.");
      const f = input.file ?? null;
      if (f && (!f.storagePath || !f.storagePath.startsWith(`cl_documents/${lead.id}/${input.code}/`) || f.storagePath.includes('..') || f.sizeBytes <= 0 || f.sizeBytes > 15 * 1024 * 1024)) {
        return fail('invalid', 'Fichier invalide (15 Mo maximum).');
      }
      const replaced = row.status !== 'expected';
      apply({
        code: row.code,
        status: 'received',
        koReason: null,
        koComment: null,
        receivedAtMs: nowMs,
        channel: input.channel ?? (f ? 'upload' : null),
        ...(f ? { file: f } : {}),
        checkedBy: null,
        checkedAtMs: null,
      });
      clearPromised = true;
      events.push({ key: `rcv_${row.code}`, type: 'document', note: `${label(row.code)} ${replaced ? 'remplacé' : 'reçu'}${f ? ` (${f.originalName})` : ''}`, meta: { code: row.code, op: 'received' } });
      message = `${label(row.code)} : ${replaced ? 'pièce remplacée' : 'pièce reçue'}, à contrôler.`;
      break;
    }

    case 'check': {
      const row = current(input.code);
      if (!row) return fail('invalid', 'Cette pièce ne fait pas partie de la liste demandée.');
      if (row.status !== 'received') return fail('invalid', row.status === 'expected' ? "Cette pièce n'a pas encore été reçue : on ne peut pas la contrôler." : 'Cette pièce a déjà été contrôlée.');
      if (input.verdict === 'conform') {
        apply({ code: row.code, status: 'conform', koReason: null, koComment: null, checkedBy: ctx.actorId, checkedAtMs: nowMs });
        events.push({ key: `chk_${row.code}`, type: 'document', note: `${label(row.code)} conforme`, meta: { code: row.code, op: 'conform' } });
        message = `${label(row.code)} : conforme.`;
      } else if (input.verdict === 'non_conform') {
        if (!(DOCUMENT_KO_REASONS as readonly unknown[]).includes(input.koReason)) return fail('invalid', 'Non conforme : choisissez le motif.');
        const comment = text(input.comment, 300);
        if (input.koReason === 'other' && !comment) return fail('invalid', 'Motif « Autre » : précisez-le en commentaire.');
        apply({ code: row.code, status: 'non_conform', koReason: input.koReason as DocumentKoReason, koComment: comment || null, checkedBy: ctx.actorId, checkedAtMs: nowMs });
        events.push({ key: `chk_${row.code}`, type: 'document', note: `${label(row.code)} non conforme : ${KO_REASON_LABELS[input.koReason as DocumentKoReason].toLowerCase()}${comment ? ` — ${comment}` : ''}`, reason: KO_REASON_LABELS[input.koReason as DocumentKoReason], meta: { code: row.code, op: 'non_conform' } });
        message = `${label(row.code)} : non conforme (${KO_REASON_LABELS[input.koReason as DocumentKoReason].toLowerCase()}), à redemander.`;
      } else return fail('invalid', 'Verdict inconnu.');
      break;
    }

    case 'reask': {
      const row = current(input.code);
      if (!row) return fail('invalid', 'Cette pièce ne fait pas partie de la liste demandée.');
      if (row.status !== 'non_conform') return fail('invalid', 'Seule une pièce non conforme peut être redemandée.');
      apply({ code: row.code, status: 'to_reask', koReason: row.koReason ?? null, koComment: patches.get(row.code)?.koComment ?? null });
      events.push({ key: `rsk_${row.code}`, type: 'document', note: `${label(row.code)} à redemander`, meta: { code: row.code, op: 'to_reask' } });
      message = `${label(row.code)} : à redemander au client.`;
      break;
    }

    case 'follow_up': {
      if (!has(DOCUMENT_CHANNELS, input.channel)) return fail('invalid', 'Choisissez le canal utilisé pour la relance.');
      const missing = missingRows([...rows.values()]);
      if (missing.length === 0) return fail('invalid', "Aucune pièce ne manque : il n'y a rien à relancer.");
      followUpCount += 1;
      lastFollowUpAtMs = nowMs;
      clearPromised = true;
      const note = text(input.note, 300);
      events.push({
        key: 'followup',
        type: 'document',
        note: `Relance n°${followUpCount} par ${DOCUMENT_CHANNELS[input.channel]} : ${missing.map((m) => label(m.code)).join(', ')}${note ? ` — ${note}` : ''}`,
        meta: { op: 'follow_up', channel: input.channel, codes: missing.map((m) => m.code), count: followUpCount },
      });
      message = `Relance n°${followUpCount} enregistrée (${missing.length} pièce${missing.length > 1 ? 's' : ''}).`;
      break;
    }

    case 'decide': {
      if (input.decision !== 'continue' && input.decision !== 'recycle' && input.decision !== 'close') return fail('invalid', 'Décision inconnue.');
      const comment = text(input.comment, 500);
      if (input.decision === 'close') {
        if (!has(DECISION_CLOSE_REASONS, input.closeReason)) return fail('invalid', 'Clôture : le motif est obligatoire.');
        if (!comment) return fail('invalid', 'Clôture : le commentaire est obligatoire.');
        forcedStatus = CLOSE_STATUS[input.closeReason as DecisionCloseReason];
        forcedAction = null;
        closed = true;
        events.push({ key: 'decision', type: 'document', note: `Décision documentaire : clôture (${DECISION_CLOSE_REASONS[input.closeReason as DecisionCloseReason].toLowerCase()}) — ${comment}`, reason: DECISION_CLOSE_REASONS[input.closeReason as DecisionCloseReason], meta: { op: 'decide', decision: 'close' } });
        message = `Lead clôturé : ${DECISION_CLOSE_REASONS[input.closeReason as DecisionCloseReason].toLowerCase()}.`;
      } else if (input.decision === 'recycle') {
        const at = nextWorkingTime(rules.schedule, nowMs + rules.recycleAfterDays * DAY);
        if (at === null) return fail('invalid', "Aucun créneau de travail n'est configuré : le recyclage ne peut pas être planifié.");
        forcedStatus = 'recycling';
        forcedAction = mkAction('recycle', 'P4', at, 'Recyclage après documents non reçus');
        closed = true;
        events.push({ key: 'decision', type: 'document', note: `Décision documentaire : recyclage ${formatWhen(at, nowMs, tz)}${comment ? ` — ${comment}` : ''}`, meta: { op: 'decide', decision: 'recycle' } });
        message = `Lead mis en recyclage : reprise ${formatWhen(at, nowMs, tz)}.`;
      } else {
        followUpCount += 1;
        lastFollowUpAtMs = nowMs;
        events.push({ key: 'decision', type: 'document', note: `Décision documentaire : poursuivre${comment ? ` — ${comment}` : ''}`, meta: { op: 'decide', decision: 'continue' } });
        message = 'Le dossier est maintenu : nouvelle échéance de décision planifiée.';
      }
      break;
    }

    case 'start_building': {
      if (lead.status !== 'file_ready_to_build') return fail('unavailable', "Le dossier n'est pas prêt à monter : toutes les pièces obligatoires doivent être conformes.");
      forcedStatus = 'file_building';
      forcedAction = null;
      events.push({ key: 'build', type: 'document', note: 'Passage au montage du dossier', meta: { op: 'start_building' } });
      message = 'Dossier passé au montage.';
      break;
    }

    default:
      return fail('invalid', 'Action inconnue.');
  }

  // ── Recalcul : état général, statut du lead, prochaine action ──
  const finalRows = [...rows.values()];
  const before = summarizeDocuments(ctx.docs);
  const summary = summarizeDocuments(finalRows);
  let status: LeadStatus = lead.status;
  if (forcedStatus) status = forcedStatus;
  else if (summary.state === 'complete' && (lead.status === 'awaiting_documents' || lead.status === 'missing_info')) status = 'file_ready_to_build';
  else if (summary.state !== 'complete' && lead.status === 'file_ready_to_build') status = 'awaiting_documents';

  const requestAtMs = lastRequestAtMs ?? nowMs;
  let nextAction: DocPlannedAction | null = null;
  let nextFollowUpAtMs: number | null = null;
  const promised = clearPromised ? null : lead.promisedAtMs;
  const toCheck = finalRows.filter((r) => r.status === 'received');
  const justFollowed = input.kind === 'follow_up' || input.kind === 'decide';

  if (forcedAction !== undefined) {
    nextAction = forcedAction;
  } else if (status === 'file_ready_to_build') {
    nextAction = mkAction('build_file', 'P3', nowMs, 'Dossier complet : passer au montage');
  } else if (status === 'awaiting_documents' || status === 'missing_info') {
    // Une pièce à contrôler passe avant tout ; puis une pièce rejetée à redemander (sauf si le client vient d'être relancé).
    if (toCheck.length > 0) {
      nextAction = mkAction('document_review', 'P1', nowMs, `${toCheck.length} pièce${toCheck.length > 1 ? 's' : ''} à contrôler`);
    } else if (summary.state === 'incomplete_non_conform' && !justFollowed) {
      const bad = missingRows(finalRows).filter((r) => r.status !== 'expected');
      nextAction = mkAction('document_followup', 'P2', nowMs, `Redemander : ${bad.map((r) => label(r.code)).join(', ')}`);
    } else if (promised !== null && promised + rules.promisedMarginMinutes * MIN > nowMs) {
      nextAction = mkAction('promised_docs_missing', 'P2', promised + rules.promisedMarginMinutes * MIN, 'Documents promis non reçus');
    } else {
      const step = nextFollowUpStep({ requestAtMs, lastFollowUpAtMs, done: followUpCount, rules });
      if (step) {
        nextFollowUpAtMs = step.dueAtMs;
        const miss = missingRows(finalRows);
        nextAction =
          step.kind === 'decision'
            ? mkAction('document_decision', 'P1', step.dueAtMs, `Documents toujours incomplets depuis ${step.day} jours : poursuivre, recycler ou clôturer`)
            : mkAction('document_followup', step.kind === 'followup' ? 'P2' : 'P1', step.dueAtMs,
                step.kind === 'red_alert' ? 'Documents toujours incomplets' : `Relancer : ${miss.map((r) => label(r.code)).join(', ')}`);
      }
    }
  }
  if (nextAction && nextFollowUpAtMs === null && nextAction.type !== 'build_file') nextFollowUpAtMs = nextAction.dueAtMs;
  if (closed || status === 'file_building') nextFollowUpAtMs = null;

  if (status !== lead.status) {
    events.push({
      key: 'status',
      type: 'status_changed',
      before: { status: lead.status },
      after: { status },
      reason: status === 'file_ready_to_build' ? 'Pièces obligatoires conformes' : status === 'awaiting_documents' ? 'Pièce non conforme' : undefined,
    });
  }

  return {
    ok: true,
    plan: {
      action: input.kind,
      docPatches: [...patches.values()],
      summary,
      statusBefore: lead.status,
      status,
      nextAction,
      completedActionId: lead.nextActionId,
      leadDocuments: {
        lastRequestAtMs,
        lastFollowUpAtMs,
        followUpCount,
        nextFollowUpAtMs,
        missing: missingRows(finalRows).map((r) => ({ code: r.code, label: r.label ?? null, status: r.status, koReason: r.koReason ?? null })),
        ...(input.kind === 'receive' ? { lastReceivedAtMs: nowMs } : {}),
        ...(summary.state === 'complete' && before.state !== 'complete' ? { completedAtMs: nowMs } : summary.state !== 'complete' && before.state === 'complete' ? { completedAtMs: null } : {}),
        clearPromised,
      },
      loadDelta: loadDeltaFor(lead.status, status),
      events,
      message,
    },
  };
}
