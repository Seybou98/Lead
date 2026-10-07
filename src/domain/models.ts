// Modèle de données Firestore du CRM Leads. Voir docs/MODELE_DONNEES.md pour le raisonnement.
// Toutes les dates sont des Timestamp Firestore (UTC) ; l'affichage se fait en Europe/Paris.

import type { Timestamp } from 'firebase/firestore';
import type {
  ActionState,
  ActionType,
  AssignmentState,
  CallResult,
  CampaignStatus,
  CommercialState,
  ConfigModule,
  ConfigVersionState,
  ConversionState,
  DocumentChannel,
  DocumentKoReason,
  DocumentState,
  DocumentStatus,
  DuplicateOutcome,
  FinancialState,
  LeadStatus,
  OperationalStatus,
  PriorityClass,
  Temperature,
} from './enums';

// ═══════════════════════════════════════════════════════════════════════════
// Personnes et organisation
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkSlot {
  /** 0 = dimanche … 6 = samedi */
  day: number;
  /** "HH:mm" dans le fuseau de l'utilisateur */
  start: string;
  end: string;
}

/**
 * cl_profiles/{uid} — données OPÉRATIONNELLES du CRM Leads uniquement.
 * L'identité (nom, email), le rôle et le statut du compte restent dans `users/{uid}` du CRM
 * principal : on ne les duplique pas. Le doc est créé quand un utilisateur est rattaché à une
 * équipe ; sans lui, un télépro peut se connecter mais n'est éligible à aucune attribution.
 */
export interface Profile {
  uid: string;
  /** Fin d'accès programmée : suspension automatique à cette date (§20.2). */
  accessEndsAt?: Timestamp | null;

  primaryTeamId: string | null;
  teamIds: string[];
  /** uid des managers de ses équipes (dénormalisé) : permet à un manager de lister son équipe sous règles Firestore. */
  managerIds: string[];
  /** Périmètre commercial. Tableau vide = aucun accès (jamais « tout »). */
  scope: {
    productCodes: string[];
    zones: string[];
    campaignIds: string[];
    sourceIds: string[];
  };

  capacity: {
    /** Plafond individuel de leads au statut Nouveau. null = valeur par défaut de la configuration (10, §4.2). */
    newLeadsCap: number | null;
    /** Dérogation temporaire : valeur + période + motif, retour automatique au plafond normal. */
    override: {
      value: number;
      from: Timestamp;
      until: Timestamp;
      reason: string;
      grantedBy: string;
    } | null;
  };

  /** Pilote la distribution. Écrit par le serveur et par l'utilisateur via fonction callable. */
  operationalStatus: OperationalStatus;
  operationalStatusSince: Timestamp;
  distributionSuspended: boolean;
  lastUsefulActionAt: Timestamp | null;
  lastAssignedAt: Timestamp | null;

  schedule: {
    timezone: string; // "Europe/Paris"
    weekly: WorkSlot[];
    breaks: WorkSlot[];
  };

  /** Dénormalisé par le serveur pour l'éligibilité et l'affichage (évite de recompter). */
  load: {
    newLeads: number;
    callbacks: number;
    interested: number;
    documents: number;
    filesToBuild: number;
    recycling: number;
  };

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * cl_presence/{uid} — heartbeat de connexion, séparé du profil car écrit très souvent.
 * Un navigateur ouvert ou un mouvement de souris n'est PAS une activité commerciale (§12.7).
 */
export interface Presence {
  uid: string;
  connected: boolean;
  lastSeenAt: Timestamp;
}

/** cl_teams/{teamId} */
export interface Team {
  id: string;
  name: string;
  managerId: string;
  secondaryManagerId?: string | null;
  memberIds: string[];
  productCodes: string[];
  zones: string[];
  campaignIds: string[];
  fallbackTeamId?: string | null;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** cl_absences/{id} */
export interface Absence {
  id: string;
  userId: string;
  type: 'leave' | 'sick' | 'training' | 'other';
  from: Timestamp;
  to: Timestamp;
  reason: string;
  /** Traitement par famille de charge (§20.6) */
  handling: {
    newLeads: 'reassign_now';
    callbacks: 'transfer';
    interested: 'case_by_case' | 'transfer';
    documents: 'transfer_temporarily' | 'keep';
    filesToBuild: 'reassign' | 'keep';
    recycling: 'suspend' | 'redistribute';
  };
  createdBy: string;
  createdAt: Timestamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lead
// ═══════════════════════════════════════════════════════════════════════════

/**
 * cl_rawLeads/{rawId} — payload d'origine, conservé tel quel (§24.2).
 * Jamais modifié : toute correction se fait sur cl_leads, et est historisée.
 */
export interface RawLead {
  id: string;
  receivedAt: Timestamp;
  channel: 'webhook' | 'import' | 'manual' | 'api';
  sourceId: string | null;
  /**
   * Payload reçu, tel quel, sérialisé en JSON. Une chaîne plutôt qu'un objet : Firestore refuse
   * certaines structures (tableaux imbriqués, clés vides) et on ne doit jamais perdre un lead pour ça.
   */
  payloadJson: string;
  /** Lead créé (ou rattaché) à partir de ce brut. */
  leadId: string | null;
  processingState: 'received' | 'processed' | 'rejected';
  rejectionCode?: string;
  rejectionReason?: string;
}

/** Origine marketing. Posée à la création, jamais réécrite (§19.2, §22.9 : première source connue). */
export interface LeadOrigin {
  sourceId: string | null;
  platform: string | null; // meta, google, site, agence…
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  formId: string | null;
  externalId: string | null;
  costCents: number | null;
  receivedAt: Timestamp;
  rawLeadId: string | null;
}

export interface LeadAddress {
  line: string;
  postalCode: string;
  city: string;
  /** Zone géographique de la config (distribution + éligibilité). */
  zone: string | null;
}

/** cl_leads/{leadId} */
export interface Lead {
  id: string;

  // Identité (normalisée)
  fullName: string;
  firstName: string;
  lastName: string;
  /** Format E.164, clé de déduplication. */
  phone: string | null;
  email: string | null; // en minuscules
  address: LeadAddress;

  origin: LeadOrigin;
  /** Consentement déclaré par la source (RGPD, §24.2) ; null = information absente. */
  consent: boolean | null;

  // Projet
  productCode: string | null;
  /** Réponses de qualification dynamiques, clé = code du champ. */
  qualification: Record<string, unknown>;
  /** Version de config appliquée à ce lead (§21.9). */
  configVersions: Partial<Record<ConfigModule, string>>;

  // Propriétaire (RG01 : exactement un propriétaire actif OU un état explicite)
  assignmentState: AssignmentState;
  ownerId: string | null;
  teamId: string | null;
  /**
   * uid des managers qui voient ce lead (manager principal + secondaire de l'équipe),
   * recopiés à chaque attribution. Sert aux règles Firestore : un filtre sur un champ du document
   * est prouvable, un `get()` croisé vers l'équipe ne l'est pas (la requête de liste serait rejetée).
   */
  managerIds: string[];
  bufferReason: string | null;
  reassignCount: number;

  // Pipeline
  status: LeadStatus;
  subStatus: string | null;
  temperature: Temperature | null;

  /** Prochaine action — dénormalisée depuis cl_actions pour affichage sans jointure (RG02). */
  nextAction: {
    actionId: string;
    type: ActionType;
    dueAt: Timestamp;
    priority: PriorityClass;
    reason: string;
  } | null;

  /** SLA de prise en charge (§5). Le compteur ne s'arrête qu'à un changement de statut valide. */
  sla: {
    startedAt: Timestamp;
    stoppedAt: Timestamp | null;
    nextAlertAt: Timestamp | null;
    alertCount: number;
    breachedAt: Timestamp | null;
    /** Minutes hors horaires commerciales, exclues des KPI de retard (RG17). */
    pausedMinutes: number;
  };

  /** Cycle NR (§8). attempt = 0 tant qu'aucun NR. */
  nr: {
    attempt: 0 | 1 | 2 | 3 | 4 | 5;
    cycle: number;
    lastAt: Timestamp | null;
    nextAt: Timestamp | null;
  };

  /** Résumé documentaire, recalculé par le serveur. */
  documents: {
    state: DocumentState;
    expected: number;
    received: number;
    conform: number;
    mandatory: number;
    mandatoryConform: number;
    lastRequestAt: Timestamp | null;
    nextFollowUpAt: Timestamp | null;
    promisedAt: Timestamp | null;
  };

  // Trois axes d'état indépendants (§23.9) — peu utilisés en Phase 1-2, présents dès le départ
  commercialState: CommercialState;
  financialState: FinancialState;
  saleId: string | null;

  // Conversion (§11.8) : Lead ID → Vente ID → Client ID → Dossier ID
  conversion: {
    state: ConversionState | null;
    clientId: string | null;
    dossierId: string | null;
    convertedAt: Timestamp | null;
  };

  // Qualité des leads (§22.5). Jamais de suppression : exclusion tracée.
  quality: {
    duplicateOf: string | null;
    duplicateOutcome: DuplicateOutcome;
    excluded: boolean;
    excludedReason: string | null;
  };

  /** Dernière note utile (pour la carte d'action). L'historique complet est dans events. */
  lastNote: { text: string; at: Timestamp; authorId: string } | null;

  /** Compteur de version pour détecter les écritures concurrentes. */
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * cl_leads/{leadId}/events/{eventId} — historique immuable (§3.1, §7.2).
 * Création seule : aucune règle n'autorise update ni delete.
 */
export interface LeadEvent {
  id: string;
  type:
    | 'created'
    | 'assigned'
    | 'reassigned'
    | 'status_changed'
    | 'call_result'
    | 'note'
    | 'field_corrected'
    | 'document'
    | 'notification'
    | 'conversion'
    | 'exception'
    | 'alert'
    | 'duplicate_interaction';
  at: Timestamp;
  /** uid, ou 'system' / 'engine' pour une action automatique. */
  actorId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  note?: string;
  meta?: Record<string, unknown>;
}

/** cl_leads/{leadId}/callAttempts/{id} — tentatives d'appel déclarées (§3.2). */
export interface CallAttempt {
  id: string;
  userId: string;
  at: Timestamp;
  result: CallResult;
  /** Renseigné quand result = no_answer : NR1..NR5. */
  nrNumber: 1 | 2 | 3 | 4 | 5 | null;
  durationSeconds: number | null;
  note: string | null;
  nextAttemptAt: Timestamp | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions (file de travail)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * cl_actions/{actionId} — une action à faire pour un lead.
 * Collection racine (pas sous-collection) : la file se requête par propriétaire + échéance,
 * sans passer par chaque lead.
 */
export interface Action {
  id: string;
  leadId: string;
  ownerId: string;
  teamId: string | null;
  /** Copie de lead.managerIds (règles Firestore). */
  managerIds: string[];
  type: ActionType;
  priority: PriorityClass;
  state: ActionState;
  dueAt: Timestamp;
  /** « Pourquoi c'est prioritaire » — affiché sur la carte (§6.1). */
  reason: string;
  result: string | null;
  completedAt: Timestamp | null;
  snoozedUntil: Timestamp | null;
  /**
   * Clé déterministe (ex. `${leadId}:nr_attempt:3`) : empêche de créer deux fois la même action
   * si le moteur rejoue un événement.
   */
  dedupeKey: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Documents
// ═══════════════════════════════════════════════════════════════════════════

/** cl_leads/{leadId}/documents/{docId} — une pièce attendue de la checklist, avec son fichier. */
export interface LeadDocument {
  id: string;
  /** Code du type de pièce (config `documents`). */
  typeCode: string;
  mandatory: boolean;
  status: DocumentStatus;
  koReason: DocumentKoReason | null;
  koComment: string | null;
  file: {
    storagePath: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    originalName: string;
  } | null;
  receivedAt: Timestamp | null;
  channel: DocumentChannel | null;
  checkedBy: string | null;
  checkedAt: Timestamp | null;
  /** Prévu pour l'IA future (§10.3). Vide en V1. */
  ai: {
    result: string | null;
    confidence: number | null;
    anomalies: string[];
    humanValidated: boolean;
  } | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Campagnes et sources
// ═══════════════════════════════════════════════════════════════════════════

/** cl_campaigns/{campaignId} */
export interface Campaign {
  id: string;
  name: string;
  sourceId: string;
  externalId: string | null;
  productCode: string | null;
  zones: string[];
  status: CampaignStatus;
  budgetCents: number | null;
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  eligibleTeamIds: string[];
  eligibleUserIds: string[];
  fallbackTeamId: string | null;
  /** Surcharges par campagne (§19.4). Absent = valeurs de la config globale. */
  slaOverride?: Record<string, unknown>;
  /** Règles d'attribution propres à la campagne (fig. 17) : plafond, critères activés, ordre de priorité. */
  assignmentConfig?: Record<string, unknown>;
  maxReassignments?: number;
  /** « Tous les télépros autorisés pour ce produit » : aucune restriction d'équipe. */
  autoEligible?: boolean;
  /** Horaires de réception des leads (enregistrés, pas encore appliqués par le moteur). */
  receptionSchedule?: { timezone: string; weekly: WorkSlot[] } | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** cl_sources/{sourceId} */
export interface Source {
  id: string;
  name: string;
  kind: 'meta' | 'google' | 'site' | 'agency' | 'import' | 'manual';
  enabled: boolean;
  /** Mapping des champs entrants → champs normalisés. Pas de secret ici. */
  fieldMapping: Record<string, string>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Moteur, audit, conversion
// ═══════════════════════════════════════════════════════════════════════════

/** cl_adSpend/{id} — dépense publicitaire d'une campagne (§19.1, §22.4). Jamais supprimée : corrigée avec motif. */
export interface AdSpend {
  id: string;
  campaignId: string;
  amountCents: number;
  /** Jour de la dépense. */
  date: Timestamp;
  /** Origine : saisie manuelle ; import CSV, API et coût fixe par lead viendront plus tard. */
  kind: 'manual';
  note: string | null;
  createdBy: string;
  createdAt: Timestamp;
  updatedBy: string;
  updatedAt: Timestamp;
}

/** cl_distributionLog/{id} — « Pourquoi ce lead a-t-il été attribué à cette personne ? » (§19.5) */
export interface DistributionLogEntry {
  id: string;
  at: Timestamp;
  leadId: string;
  /** Nom du lead au moment de la décision (affichage du journal sans relire le lead). Absent des anciennes entrées. */
  leadName?: string | null;
  teamId: string | null;
  managerIds: string[];
  campaignId: string | null;
  event: 'assign' | 'reassign' | 'buffer' | 'manual' | 'bulk_transfer' | 'simulation';
  mode: 'real' | 'simulation';
  chosenOwnerId: string | null;
  previousOwnerId: string | null;
  actorId: string; // uid ou 'engine'
  reason: string | null;
  ruleApplied: string;
  /** Valeurs de charge FIGÉES au moment du calcul — nécessaires pour reconstituer la décision. */
  candidates: Array<{
    uid: string;
    eligible: boolean;
    exclusions: string[];
    activeLoad: number;
    newLeads: number;
    /** Plafond de nouveaux leads en vigueur au moment du calcul. Absent des anciennes entrées. */
    cap?: number;
    lastAssignedAt: Timestamp | null;
  }>;
}

/** cl_audit/{id} — journal non modifiable des actions sensibles (§15.2, §20.9, §21.10). */
export interface AuditEntry {
  id: string;
  at: Timestamp;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

/** cl_notifications/{id} — même forme que `notifications` du CRM principal (recipientIds). */
export interface ClNotification {
  id: string;
  type: string;
  title: string;
  description: string;
  leadId: string | null;
  recipientIds: string[];
  /** Un son est joué uniquement pour : nouveau lead, SLA dépassé, rappel dû, alerte critique (§12.11). */
  sound: 'new_lead' | 'sla' | 'callback' | 'critical' | null;
  readBy: string[];
  createdAt: Timestamp;
}

/**
 * cl_conversions/{leadId} — l'id du document EST le leadId : une seule conversion par lead,
 * ce qui rend la création idempotente par construction (§11.3, RG14).
 */
export interface Conversion {
  leadId: string;
  idempotencyKey: string;
  state: ConversionState;
  saleId: string | null;
  clientId: string | null;
  dossierId: string | null;
  attempts: number;
  lastError: { code: string; message: string; at: Timestamp } | null;
  requestedBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Paramétrage versionné
// ═══════════════════════════════════════════════════════════════════════════

/** cl_config/{module} — pointeur vers la version publiée. */
export interface ConfigPointer {
  module: ConfigModule;
  publishedVersionId: string | null;
  updatedAt: Timestamp;
}

/**
 * cl_config/{module}/versions/{versionId}
 * Un brouillon n'affecte aucun lead. Un retour arrière crée une NOUVELLE version
 * équivalente à l'ancienne ; rien n'est jamais détruit (§21.9).
 */
export interface ConfigVersion<TPayload = Record<string, unknown>> {
  id: string;
  module: ConfigModule;
  number: number;
  state: ConfigVersionState;
  payload: TPayload;
  authorId: string;
  justification: string | null;
  createdAt: Timestamp;
  publishedAt: Timestamp | null;
  revertOf: string | null;
}
