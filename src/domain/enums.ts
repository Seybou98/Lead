// Valeurs énumérées du domaine. Les libellés affichés vivent dans `labels.ts` ;
// les codes ci-dessous sont stables (stockés en base, utilisés dans les KPI).

// ── Utilisateurs (cahier des charges §2, §20) ────────────────────────────────

export const ROLES = ['admin', 'manager', 'telepro'] as const;
export type Role = (typeof ROLES)[number];

// Le statut du COMPTE (actif / désactivé) est celui du CRM principal : `users/{uid}.status`.
// Le CRM Leads ne le duplique pas.

/** Pilote la distribution des leads. Un compte actif peut être absent ou en pause. */
export const OPERATIONAL_STATUSES = [
  'available',
  'on_call',
  'processing',
  'doc_followup',
  'file_building',
  'in_meeting',
  'paused',
  'absent',
  'disconnected',
  'unavailable',
] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

// ── Lead (§3, §7, §8, §9, §11) ───────────────────────────────────────────────

/**
 * Statut principal du lead (un seul à la fois).
 * Les axes commercial / financier / documentaire sont des champs séparés (§23.9).
 */
export const LEAD_STATUSES = [
  'new', // Nouveau — SLA en cours
  'nr', // NR1..NR5 (numéro dans lead.nr.attempt)
  'unreachable_cycle_end', // Injoignable — fin cycle 1
  'recycling', // en recyclage (période creuse)
  'unreachable_archived', // Injoignable / archivé
  'callback', // À rappeler (engagement client) — inclut « mauvais moment »
  'interested', // Intéressé
  'awaiting_documents', // En attente de documents
  'file_ready_to_build', // Dossier prêt à monter
  'file_building', // Montage en cours
  'missing_info', // Information manquante
  'manager_validation', // Validation manager (exception)
  'file_ready', // Dossier prêt (tous contrôles validés)
  'transmitting', // Transmission en cours vers le CRM principal
  'transmission_error', // Erreur de transmission
  'converted', // Converti
  'not_interested', // Non intéressé (clôture, recyclable selon règle)
  'ineligible', // Inéligible
  'fake_lead', // Faux lead
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Statuts qui sortent le lead de la file active. */
export const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = [
  'unreachable_archived',
  'converted',
  'not_interested',
  'ineligible',
  'fake_lead',
];

/** Statut « de traitement » : seul un passage hors de 'new' arrête l'alerte SLA (RG03/RG04). */
export const SLA_STOPPING_FROM: LeadStatus = 'new';

export const TEMPERATURES = ['hot', 'warm', 'to_work'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const ASSIGNMENT_STATES = ['assigned', 'to_assign', 'buffer'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** Résultats d'appel proposés à la qualification de fin d'appel (§12.1.3, §25.4). */
export const CALL_RESULTS = [
  'no_answer', // NR
  'callback',
  'interested',
  'request_documents',
  'close_now', // Conclure maintenant (vente directe, §23)
  'not_interested',
  'ineligible',
  'fake_lead',
  'bad_moment', // Mauvais moment : rappel court P1, ne compte pas comme NR
] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

// ── File de travail (§6) ─────────────────────────────────────────────────────

export const PRIORITY_CLASSES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const ACTION_TYPES = [
  'take_new_lead', // P0 si proche/au-delà du SLA, sinon P1
  'client_callback', // P0 à l'échéance
  'short_callback', // « mauvais moment » : P1
  'interested_followup', // P2
  'document_followup', // P2
  'promised_docs_missing', // P2
  'document_review', // à contrôler
  'nr_attempt', // P3
  'build_file', // P3
  'document_decision', // J+14 : poursuivre, recycler ou clôturer
  'recycle', // P4
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATES = ['open', 'done', 'cancelled', 'snoozed'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

// ── Documents (§10) ──────────────────────────────────────────────────────────

/** Statut unitaire d'une pièce. Un document `received` n'est pas conforme (RG10). */
export const DOCUMENT_STATUSES = [
  'expected',
  'received',
  'conform',
  'non_conform',
  'to_reask',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KO_REASONS = [
  'unreadable',
  'incomplete',
  'expired',
  'wrong_document',
  'inconsistent_info',
  'other',
] as const;
export type DocumentKoReason = (typeof DOCUMENT_KO_REASONS)[number];

/** État général du dossier documentaire, recalculé à chaque ajout ou validation. */
export const DOCUMENT_STATES = [
  'none', // pas de workflow documentaire démarré
  'requested', // aucune pièce reçue
  'partial', // au moins une reçue, checklist incomplète
  'received_to_check', // tout reçu, validation non terminée
  'incomplete_non_conform', // au moins une pièce absente ou rejetée
  'complete', // toutes les obligatoires reçues et conformes
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const DOCUMENT_CHANNELS = ['whatsapp', 'email', 'sms', 'upload', 'other'] as const;
export type DocumentChannel = (typeof DOCUMENT_CHANNELS)[number];

// ── Vente et conversion (§11, §23) — modélisées dès maintenant, construites plus tard ──

export const COMMERCIAL_STATES = [
  'none',
  'sale_committed',
  'offer_sent',
  'signed',
  'cancelled',
  'retracted',
] as const;
export type CommercialState = (typeof COMMERCIAL_STATES)[number];

export const FINANCIAL_STATES = [
  'none',
  'deposit_expected',
  'deposit_received',
  'financing_in_progress',
  'financing_accepted',
  'financing_refused',
  'payment_confirmed',
] as const;
export type FinancialState = (typeof FINANCIAL_STATES)[number];

export const CONVERSION_STATES = [
  'pending',
  'sent',
  'client_created',
  'dossier_created',
  'confirmed',
  'failed',
] as const;
export type ConversionState = (typeof CONVERSION_STATES)[number];

// ── Campagnes (§19) ──────────────────────────────────────────────────────────

export const CAMPAIGN_STATUSES = ['draft', 'active', 'suspended', 'ended'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// ── Doublons (§4.3, §24.3) ───────────────────────────────────────────────────

export const DUPLICATE_OUTCOMES = [
  'new_lead',
  'probable_duplicate', // blocage temporaire, décision assistée
  'attached_to_open_lead', // nouvelle interaction rattachée, pas de second compteur SLA
  'known_client', // alerte + rattachement au client
] as const;
export type DuplicateOutcome = (typeof DUPLICATE_OUTCOMES)[number];

// ── Config versionnée (§21) ──────────────────────────────────────────────────

export const CONFIG_MODULES = [
  'schedule', // horaires commerciaux, jours fermés, fuseau
  'sla', // SLA, fréquence des sons, paliers d'escalade
  'assignment', // plafond, équilibrage
  'nr', // matrice NR1..NR5, cycles, recyclage
  'priorities', // règles de file
  'reminders', // rappels + relances documentaires
  'products', // catalogue, qualification, éligibilité
  'documents', // checklists
  'reasons', // motifs et listes
  'conversion', // critères bloquants
  'communications', // modèles SMS / email / notifications
] as const;
export type ConfigModule = (typeof CONFIG_MODULES)[number];

export const CONFIG_VERSION_STATES = ['draft', 'published', 'archived'] as const;
export type ConfigVersionState = (typeof CONFIG_VERSION_STATES)[number];
