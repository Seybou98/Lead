// Planificateur de la qualification de fin d'appel (§7, §8, §9, §10.1, §12.1.3). Fonction PURE : elle valide
// la saisie, puis décrit TOUT ce qui doit changer (statut, prochaine action, tentative NR, événements,
// compteurs). La couche serveur (functions/src/qualify.ts) ne fait que l'appliquer en une transaction ;
// le navigateur réutilise `previewNextNr` pour annoncer la prochaine tentative avant validation.

import {
  CLOSED_LEAD_STATUSES,
  type ActionType,
  type LeadStatus,
  type PriorityClass,
  type Role,
  type Temperature,
} from '../enums';
import { nextWorkingTime, type ScheduleLike } from '../engine/schedule';
import {
  BAD_MOMENT_REASONS,
  CALLBACK_REASONS,
  DEFAULT_DOCUMENT_TYPES,
  DOCUMENT_CHANNELS,
  FAKE_LEAD_MOTIVES,
  INELIGIBLE_CATEGORIES,
  INELIGIBLE_MOTIVES,
  INTEREST_NEXT_ACTIONS,
  INTEREST_REASONS,
  OUTCOME_LABELS,
  REFUSAL_MOTIVES,
  type CallOutcomeInput,
  type CallOutcomeKind,
  type DocumentChannelKey,
  type DocumentTypeDef,
} from './outcomes';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const MAX_NR_ATTEMPTS = 5;

export interface CallRules {
  /** Délai avant la tentative suivante, après NR1, NR2, NR3 et NR4 (minutes). */
  nrDelaysMinutes: readonly number[];
  /** Après NR5 : délai avant l'entrée en recyclage (§8.1, exemple métier : 7 jours). */
  recycleAfterDays: number;
  /** Première relance documentaire : J+1 (§10.4). */
  documentFollowUpDays: number;
  /** Marge après une heure promise avant « Documents promis non reçus » (§10.5, exemple : 30 min). */
  promisedMarginMinutes: number;
  schedule: ScheduleLike;
  documentTypes: readonly DocumentTypeDef[];
}

/** Valeurs initiales proposées par le cahier des charges ; elles seront modifiables dans Paramètres. */
export const DEFAULT_CALL_RULES: CallRules = {
  nrDelaysMinutes: [180, 24 * 60, 24 * 60, 48 * 60],
  recycleAfterDays: 7,
  documentFollowUpDays: 1,
  promisedMarginMinutes: 30,
  schedule: {
    timezone: 'Europe/Paris',
    weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })),
  },
  documentTypes: DEFAULT_DOCUMENT_TYPES,
};

export interface QualifyLead {
  id: string;
  status: LeadStatus;
  ownerId: string | null;
  productCode: string | null;
  nr: { attempt: number; cycle: number };
  /** Action ouverte en cours (celle que ce résultat clôt) ; null si aucune. */
  nextActionId: string | null;
}

export interface QualifyContext {
  lead: QualifyLead;
  actorId: string;
  actorRole: Role;
  nowMs: number;
  /** Identifiant d'idempotence fourni par le navigateur (un double clic ne qualifie pas deux fois). */
  requestId: string;
  durationSeconds: number | null;
  rules: CallRules;
}

// ── Sortie ───────────────────────────────────────────────────────────────────

export interface PlannedEvent {
  /** Clé stable dans la demande : l'identifiant d'événement est `${requestId}_${key}`. */
  key: 'call_result' | 'status_changed' | 'note';
  type: 'call_result' | 'status_changed' | 'note';
  reason?: string;
  note?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface PlannedAction {
  id: string;
  type: ActionType;
  priority: PriorityClass;
  dueAtMs: number;
  reason: string;
  dedupeKey: string;
}

export type LoadBucket = 'newLeads' | 'callbacks' | 'interested' | 'documents' | 'filesToBuild' | 'recycling';

export interface QualificationPlan {
  outcome: CallOutcomeKind;
  statusBefore: LeadStatus;
  status: LeadStatus;
  subStatus: string | null;
  /** Renseignée seulement quand le résultat la fixe. */
  temperature?: Temperature;
  nr?: { attempt: number; cycle: number; lastAtMs: number; nextAtMs: number | null };
  nextAction: PlannedAction | null;
  completedActionId: string | null;
  /** Instant d'arrêt du compteur SLA ; null = il n'était plus en cours. */
  slaStopAtMs: number | null;
  lastNote: string | null;
  documents?: {
    types: DocumentTypeDef[];
    channel: DocumentChannelKey;
    promisedAtMs: number | null;
    nextFollowUpAtMs: number | null;
  };
  quality?: { excluded: true; reason: string };
  /** Variation des compteurs du profil du télépro propriétaire. */
  loadDelta: Partial<Record<LoadBucket, number>>;
  callAttempt: {
    result: string;
    nrNumber: number | null;
    durationSeconds: number | null;
    note: string | null;
    nextAttemptAtMs: number | null;
  };
  events: PlannedEvent[];
  notifyManagers: { title: string; body: string } | null;
  /** Phrase de confirmation affichée au télépro (§25.9). */
  summary: string;
}

export type PlanResult =
  | { ok: true; plan: QualificationPlan }
  | { ok: false; code: 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid'; message: string; errors: Record<string, string> };

// ── Aides ────────────────────────────────────────────────────────────────────

/** Clé propre uniquement : « constructor » ou « __proto__ » ne sont jamais un motif valide. */
const has = (obj: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const BUCKET_OF: Partial<Record<LeadStatus, LoadBucket>> = {
  new: 'newLeads',
  callback: 'callbacks',
  interested: 'interested',
  awaiting_documents: 'documents',
  missing_info: 'documents',
  file_ready_to_build: 'filesToBuild',
  recycling: 'recycling',
};

/** Compteur de charge du profil auquel un statut est rattaché (absent : le statut ne compte pas dans la charge). */
export const bucketOf = (status: LeadStatus): LoadBucket | undefined => BUCKET_OF[status];

/** Variation des compteurs quand un lead passe d'un statut à un autre. */
export function loadDeltaFor(before: LeadStatus, after: LeadStatus): Partial<Record<LoadBucket, number>> {
  const b = BUCKET_OF[before];
  const a = BUCKET_OF[after];
  if (b === a) return {};
  const out: Partial<Record<LoadBucket, number>> = {};
  if (b) out[b] = -1;
  if (a) out[a] = (out[a] ?? 0) + 1;
  return out;
}

/** « aujourd'hui à 15:30 », « demain à 10:00 », « lundi 12/10 à 09:00 » (dans le fuseau du planning). */
export function formatWhen(atMs: number, nowMs: number, timezone: string): string {
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const hm = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(atMs));
  const diffDays = Math.round((Date.parse(day(atMs)) - Date.parse(day(nowMs))) / DAY);
  if (diffDays === 0) return `aujourd'hui à ${hm}`;
  if (diffDays === 1) return `demain à ${hm}`;
  const label = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, weekday: 'long', day: '2-digit', month: '2-digit' }).format(new Date(atMs));
  return `${label} à ${hm}`;
}

/**
 * Prochaine tentative NR après la tentative `attempt` (1 à 4) : le délai de la matrice, ramené à l'ouverture
 * du prochain créneau de travail (jamais hors horaires, §8.1). null = pas de tentative suivante (NR5) ou
 * aucun créneau de travail configuré.
 */
export function nextNrAttemptAt(attempt: number, nowMs: number, rules: CallRules): number | null {
  if (attempt >= MAX_NR_ATTEMPTS) return null;
  const delay = rules.nrDelaysMinutes[attempt - 1] ?? rules.nrDelaysMinutes[rules.nrDelaysMinutes.length - 1] ?? 24 * 60;
  return nextWorkingTime(rules.schedule, nowMs + delay * MIN);
}

/** Numéro de la tentative NR en cours de saisie, d'après l'état du lead. */
export function currentNrAttempt(lead: Pick<QualifyLead, 'status' | 'nr'>): { attempt: number; cycle: number } {
  const inCycle = lead.status === 'new' || lead.status === 'nr' || lead.status === 'callback' || lead.status === 'interested';
  if (lead.status === 'unreachable_cycle_end' || lead.status === 'recycling') return { attempt: 1, cycle: lead.nr.cycle + 1 };
  const attempt = (inCycle ? lead.nr.attempt : 0) + 1;
  return { attempt: Math.min(attempt, MAX_NR_ATTEMPTS), cycle: Math.max(1, lead.nr.cycle) };
}

const MAX_AHEAD = 365 * DAY;
function checkWhen(errors: Record<string, string>, field: string, atMs: unknown, nowMs: number, label: string, maxAhead = MAX_AHEAD) {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) errors[field] = `${label} : date et heure obligatoires.`;
  else if (atMs < nowMs - MIN) errors[field] = `${label} : la date est déjà passée.`;
  else if (atMs > nowMs + maxAhead) errors[field] = `${label} : date trop lointaine.`;
}

// ── Planificateur ────────────────────────────────────────────────────────────

export function planCallOutcome(input: CallOutcomeInput, ctx: QualifyContext): PlanResult {
  const { lead, nowMs, rules } = ctx;
  const tz = rules.schedule.timezone;

  if (!lead.ownerId) return { ok: false, code: 'unavailable', message: "Ce lead n'a pas de propriétaire : il doit d'abord être attribué.", errors: {} };
  if (ctx.actorRole !== 'admin' && lead.ownerId !== ctx.actorId) {
    return { ok: false, code: 'forbidden', message: "Seul le propriétaire du lead peut qualifier cet appel.", errors: {} };
  }
  if (CLOSED_LEAD_STATUSES.includes(lead.status)) {
    return { ok: false, code: 'lead_closed', message: 'Ce lead est déjà clôturé : aucun résultat ne peut être ajouté.', errors: {} };
  }
  if (lead.status === 'transmitting' || lead.status === 'transmission_error') {
    return { ok: false, code: 'unavailable', message: 'Ce lead est en cours de transmission : il ne peut plus être qualifié ici.', errors: {} };
  }

  const errors: Record<string, string> = {};
  const fail = (): PlanResult => ({ ok: false, code: 'invalid', message: Object.values(errors)[0] ?? 'Saisie invalide.', errors });

  const action = (type: ActionType, priority: PriorityClass, dueAtMs: number, reason: string): PlannedAction => ({
    id: `${lead.id}_${type}_${ctx.requestId}`,
    type,
    priority,
    dueAtMs,
    reason,
    dedupeKey: `${lead.id}:${type}:${ctx.requestId}`,
  });

  let status: LeadStatus;
  let subStatus: string | null = null;
  let temperature: Temperature | undefined;
  let nr: QualificationPlan['nr'];
  let nextAction: PlannedAction | null = null;
  let note: string | null = null;
  let documents: QualificationPlan['documents'];
  let quality: QualificationPlan['quality'];
  let notifyManagers: QualificationPlan['notifyManagers'] = null;
  let nrNumber: number | null = null;
  let reason: string | undefined;
  let summary = '';
  const meta: Record<string, unknown> = { outcome: input.kind };

  switch (input.kind) {
    case 'no_answer': {
      const { attempt, cycle } = currentNrAttempt(lead);
      nrNumber = attempt;
      note = text(input.comment, 500) || null;
      const nextAt = nextNrAttemptAt(attempt, nowMs, rules);
      if (attempt >= MAX_NR_ATTEMPTS) {
        status = 'unreachable_cycle_end';
        const recycleAt = nextWorkingTime(rules.schedule, nowMs + rules.recycleAfterDays * DAY);
        nr = { attempt, cycle, lastAtMs: nowMs, nextAtMs: recycleAt };
        summary = `NR${attempt} enregistré : injoignable, fin du cycle ${cycle}. Le lead sort de votre file et reste consultable.`;
      } else {
        status = 'nr';
        nr = { attempt, cycle, lastAtMs: nowMs, nextAtMs: nextAt };
        if (nextAt === null) {
          errors.schedule = "Aucun créneau de travail n'est configuré : la prochaine tentative ne peut pas être calculée.";
          return fail();
        }
        nextAction = action('nr_attempt', 'P3', nextAt, `NR${attempt + 1} programmée (tentative précédente : NR${attempt})`);
        summary = `NR${attempt} enregistré. Prochaine tentative : NR${attempt + 1} ${formatWhen(nextAt, nowMs, tz)}.`;
      }
      if (input.refusedCall) meta.refusedCall = true;
      meta.nrNumber = attempt;
      break;
    }

    case 'callback': {
      checkWhen(errors, 'atMs', input.atMs, nowMs, 'Rappel');
      if (!has(CALLBACK_REASONS, input.reason)) errors.reason = 'Rappel : le motif est obligatoire.';
      note = text(input.comment, 500);
      if (!note) errors.comment = 'Rappel : le commentaire est obligatoire.';
      if (input.confirmed !== true) errors.confirmed = 'Confirmez que le créneau a été validé avec le client.';
      if (Object.keys(errors).length) return fail();
      status = 'callback';
      nextAction = action('client_callback', 'P0', input.atMs, `Rappel promis : ${CALLBACK_REASONS[input.reason].toLowerCase()}`);
      reason = CALLBACK_REASONS[input.reason];
      meta.reason = input.reason;
      summary = `Rappel programmé ${formatWhen(input.atMs, nowMs, tz)}. Il apparaîtra dans votre file à l'heure prévue.`;
      break;
    }

    case 'bad_moment': {
      checkWhen(errors, 'atMs', input.atMs, nowMs, 'Rappel rapide', 3 * DAY);
      if (!has(BAD_MOMENT_REASONS, input.reason)) errors.reason = 'Rappel rapide : le motif est obligatoire.';
      if (input.confirmed !== true) errors.confirmed = 'Confirmez que le créneau a été validé avec le client.';
      if (Object.keys(errors).length) return fail();
      status = 'callback';
      subStatus = 'bad_moment';
      note = text(input.note, 250) || null;
      nextAction = action('short_callback', 'P1', input.atMs, `Mauvais moment : ${BAD_MOMENT_REASONS[input.reason].toLowerCase()}`);
      reason = BAD_MOMENT_REASONS[input.reason];
      meta.reason = input.reason;
      meta.countsAsNr = false;
      summary = `Rappel rapide programmé ${formatWhen(input.atMs, nowMs, tz)}. Ce résultat ne compte pas comme un NR.`;
      break;
    }

    case 'interested': {
      checkWhen(errors, 'nextActionAtMs', input.nextActionAtMs, nowMs, 'Prochaine action');
      if (!has(INTEREST_REASONS, input.reason)) errors.reason = 'Intéressé : le motif de non-avancement immédiat est obligatoire.';
      if (!has(INTEREST_NEXT_ACTIONS, input.nextAction)) errors.nextAction = 'Un prospect intéressé ne peut pas être enregistré sans prochaine action.';
      if (!['hot', 'warm', 'to_work'].includes(input.temperature)) errors.temperature = 'Choisissez la température du lead.';
      note = text(input.comment, 1000);
      if (!note) errors.comment = 'Intéressé : le commentaire commercial est obligatoire.';
      if (Object.keys(errors).length) return fail();
      status = 'interested';
      temperature = input.temperature;
      nextAction = action('interested_followup', 'P2', input.nextActionAtMs, `${INTEREST_NEXT_ACTIONS[input.nextAction]} — ${INTEREST_REASONS[input.reason].toLowerCase()}`);
      reason = INTEREST_REASONS[input.reason];
      meta.reason = input.reason;
      meta.nextAction = input.nextAction;
      meta.temperature = input.temperature;
      summary = `Prospect intéressé enregistré. Prochaine action : ${INTEREST_NEXT_ACTIONS[input.nextAction].toLowerCase()} ${formatWhen(input.nextActionAtMs, nowMs, tz)}.`;
      break;
    }

    case 'request_documents': {
      const known = new Map(rules.documentTypes.map((d) => [d.code, d]));
      const codes = [...new Set(Array.isArray(input.documents) ? input.documents : [])];
      if (codes.length === 0) errors.documents = 'Sélectionnez au moins une pièce à demander.';
      else if (codes.some((c) => !known.has(c))) errors.documents = 'Une des pièces demandées est inconnue.';
      if (!has(DOCUMENT_CHANNELS, input.channel)) errors.channel = "Choisissez le canal d'envoi convenu avec le client.";
      if (input.promisedAtMs !== null && input.promisedAtMs !== undefined) checkWhen(errors, 'promisedAtMs', input.promisedAtMs, nowMs, 'Date promise', 60 * DAY);
      if (Object.keys(errors).length) return fail();
      status = 'awaiting_documents';
      note = text(input.note, 300) || null;
      const types = codes.map((c) => known.get(c)!);
      const promised = typeof input.promisedAtMs === 'number' ? input.promisedAtMs : null;
      // Une heure promise remplace la relance générique (§10.5) ; sinon première relance à J+1, en horaires.
      const followAt = promised !== null
        ? promised + rules.promisedMarginMinutes * MIN
        : nextWorkingTime(rules.schedule, nowMs + rules.documentFollowUpDays * DAY);
      if (followAt === null) {
        errors.schedule = "Aucun créneau de travail n'est configuré : la relance ne peut pas être calculée.";
        return fail();
      }
      nextAction = promised !== null
        ? action('promised_docs_missing', 'P2', followAt, 'Documents promis non reçus')
        : action('document_followup', 'P2', followAt, `Relancer les ${types.length} pièce(s) demandée(s)`);
      documents = { types, channel: input.channel, promisedAtMs: promised, nextFollowUpAtMs: followAt };
      meta.documents = codes;
      meta.channel = input.channel;
      summary = `${types.length} pièce(s) demandée(s) par ${DOCUMENT_CHANNELS[input.channel]}. ${promised !== null ? `Contrôle ${formatWhen(followAt, nowMs, tz)}` : `Première relance ${formatWhen(followAt, nowMs, tz)}`}.`;
      break;
    }

    case 'close_not_interested': {
      if (!has(REFUSAL_MOTIVES, input.motive)) errors.motive = 'Non intéressé : le motif du refus est obligatoire.';
      note = text(input.comment, 1000);
      if (!note) errors.comment = 'Non intéressé : le commentaire est obligatoire.';
      const opposition = input.opposition === true || input.motive === 'no_more_contact';
      if (opposition && input.followUp === 'recycle') errors.followUp = 'Un lead qui refuse tout contact ne peut pas être recyclé.';
      if (input.followUp === 'recycle') checkWhen(errors, 'recycleAtMs', input.recycleAtMs, nowMs, 'Recyclage', 2 * 365 * DAY);
      if (Object.keys(errors).length) return fail();
      reason = REFUSAL_MOTIVES[input.motive];
      meta.motive = input.motive;
      meta.opposition = opposition;
      if (input.followUp === 'recycle') {
        status = 'recycling';
        const recycleAt = input.recycleAtMs as number;
        nextAction = action('recycle', 'P4', recycleAt, `Recyclage programmé : ${REFUSAL_MOTIVES[input.motive].toLowerCase()}`);
        summary = `Refus enregistré. Recyclage programmé ${formatWhen(recycleAt, nowMs, tz)}.`;
      } else {
        status = 'not_interested';
        summary = `Lead clôturé : ${REFUSAL_MOTIVES[input.motive].toLowerCase()}. Le motif reste visible dans l'historique.`;
      }
      break;
    }

    case 'close_ineligible': {
      const motives = INELIGIBLE_MOTIVES[input.category];
      if (!has(INELIGIBLE_CATEGORIES, input.category) || !motives) errors.category = "Inéligible : la catégorie est obligatoire.";
      else if (!has(motives, input.motive)) errors.motive = 'Inéligible : le motif précis est obligatoire.';
      const product = text(input.product, 100);
      if (!product) errors.product = 'Inéligible : le produit concerné est obligatoire.';
      note = text(input.justification, 500);
      if (!note) errors.justification = 'Inéligible : la justification est obligatoire.';
      if (Object.keys(errors).length) return fail();
      status = 'ineligible';
      reason = INELIGIBLE_MOTIVES[input.category][input.motive];
      meta.category = input.category;
      meta.motive = input.motive;
      meta.product = product;
      const alt = text(input.alternativeProduct, 100);
      if (alt) meta.alternativeProduct = alt;
      summary = `Lead déclaré inéligible (${reason.toLowerCase()}).${alt ? ` Solution alternative proposée : ${alt}.` : ''}`;
      break;
    }

    case 'close_fake_lead': {
      if (!has(FAKE_LEAD_MOTIVES, input.motive)) errors.motive = 'Faux lead : le motif est obligatoire.';
      note = text(input.comment, 1000);
      if (!note) errors.comment = 'Faux lead : le commentaire / constat est obligatoire.';
      if (Object.keys(errors).length) return fail();
      status = 'fake_lead';
      reason = FAKE_LEAD_MOTIVES[input.motive];
      quality = { excluded: true, reason: input.motive };
      meta.motive = input.motive;
      if (input.requestManagerCheck === true) {
        meta.managerCheckRequested = true;
        notifyManagers = { title: 'Faux lead à vérifier', body: `${reason} : ${note}` };
      }
      summary = `Faux lead signalé (${reason.toLowerCase()}). Il est retiré de votre file et conservé pour l'analyse de la campagne.`;
      break;
    }

    case 'close_wrong_number': {
      status = 'fake_lead';
      reason = FAKE_LEAD_MOTIVES.invalid_number;
      note = text(input.comment, 500) || null;
      quality = { excluded: true, reason: 'invalid_number' };
      meta.motive = 'invalid_number';
      summary = 'Mauvais numéro enregistré. Le lead est retiré de votre file et conservé pour l\'analyse de la campagne.';
      break;
    }

    case 'close_other': {
      note = text(input.comment, 1000);
      if (!note) {
        errors.comment = 'Clôture : le commentaire est obligatoire.';
        return fail();
      }
      status = 'not_interested';
      subStatus = 'other';
      reason = 'Autre';
      summary = 'Lead clôturé. Le motif reste visible dans l\'historique.';
      break;
    }

    default: {
      errors.kind = 'Résultat inconnu.';
      return fail();
    }
  }

  const slaStopAtMs = lead.status === 'new' ? nowMs : null;
  const events: PlannedEvent[] = [
    { key: 'call_result', type: 'call_result', reason, note: note ?? undefined, meta },
  ];
  if (status !== lead.status) {
    events.push({ key: 'status_changed', type: 'status_changed', before: { status: lead.status }, after: { status } });
  }

  return {
    ok: true,
    plan: {
      outcome: input.kind,
      statusBefore: lead.status,
      status,
      subStatus,
      temperature,
      nr,
      nextAction,
      completedActionId: lead.nextActionId,
      slaStopAtMs,
      lastNote: note,
      documents,
      quality,
      loadDelta: loadDeltaFor(lead.status, status),
      callAttempt: {
        result: input.kind,
        nrNumber,
        durationSeconds: ctx.durationSeconds,
        note,
        nextAttemptAtMs: nr?.nextAtMs ?? nextAction?.dueAtMs ?? null,
      },
      events,
      notifyManagers,
      summary: summary || `${OUTCOME_LABELS[input.kind]} enregistré.`,
    },
  };
}
