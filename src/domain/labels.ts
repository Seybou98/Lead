// Libellés affichés (vocabulaire opérationnel Label Énergie, §25.9).
import type { LeadStatus, OperationalStatus, Role } from './enums';
import type { DistributionState } from './admin/userRows';
import type { EligibilityCriterion, ExclusionCode, RankingCriterion } from './engine/assignment';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Manager',
  telepro: 'Télépro-commercial',
};

export const OPERATIONAL_STATUS_LABELS: Record<OperationalStatus, string> = {
  available: 'Disponible',
  on_call: 'En appel',
  processing: 'En traitement',
  doc_followup: 'Relance documentaire',
  file_building: 'Montage dossier',
  in_meeting: 'En rendez-vous',
  paused: 'En pause',
  absent: 'Absent',
  disconnected: 'Déconnecté',
  unavailable: 'Indisponible',
};

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Nouveau',
  nr: 'Ne répond pas',
  unreachable_cycle_end: 'Injoignable — fin cycle 1',
  recycling: 'Recyclage',
  unreachable_archived: 'Injoignable / archivé',
  callback: 'À rappeler',
  interested: 'Intéressé',
  awaiting_documents: 'En attente de documents',
  file_ready_to_build: 'Dossier prêt à monter',
  file_building: 'Montage en cours',
  missing_info: 'Information manquante',
  manager_validation: 'Validation manager',
  file_ready: 'Dossier prêt',
  transmitting: 'Transmission en cours',
  transmission_error: 'Erreur de transmission',
  converted: 'Converti',
  not_interested: 'Non intéressé',
  ineligible: 'Inéligible',
  fake_lead: 'Faux lead',
};

export const DISTRIBUTION_LABELS: Record<DistributionState, string> = {
  active: 'Active',
  suspended: 'Suspendue',
  paused: 'En pause',
  full: 'Plafond atteint',
  no_profile: 'Non configuré',
  not_applicable: '—',
};

/** Pourquoi un télépro est exclu d'une attribution (journal, simulation). */
export const EXCLUSION_LABELS: Record<ExclusionCode, string> = {
  account_inactive: 'Compte inactif',
  access_expired: 'Accès expiré',
  not_connected: 'Non connecté',
  distribution_suspended: 'Distribution suspendue',
  status_paused: 'En pause',
  status_absent: 'Absent',
  status_unavailable: 'Indisponible',
  status_disconnected: 'Déconnecté',
  status_in_meeting: 'En rendez-vous',
  absent: 'Absence déclarée',
  product_not_allowed: 'Produit non autorisé',
  zone_not_allowed: 'Zone non autorisée',
  team_not_allowed: 'Hors équipe éligible',
  outside_hours: 'Hors horaires de travail',
  capacity_reached: 'Plafond atteint',
};

/** Critères d'éligibilité, tels que libellés sur la maquette (fig. 17). */
export const ELIGIBILITY_CRITERION_LABELS: Record<EligibilityCriterion, string> = {
  active_connected: 'Télépro actif et connecté',
  product: 'Produit autorisé',
  zone: 'Zone autorisée',
  team: 'Équipe',
  working_hours: 'Horaires de travail',
  capacity: 'Capacité disponible',
  exclude_in_meeting: 'Exclure le statut En rendez-vous',
};

/** Ordre de priorité (fig. 17). */
export const RANKING_CRITERION_LABELS: Record<RankingCriterion, string> = {
  lowest_active_load: 'Charge active la plus faible',
  fewest_new_leads: 'Moins de nouveaux leads reçus',
  oldest_last_assignment: 'Ancienneté depuis la dernière attribution',
};

/** Motifs écrits dans `reason` du journal par le moteur (hors motifs libres saisis par un manager). */
export const ENGINE_REASON_LABELS: Record<string, string> = {
  ...RANKING_CRITERION_LABELS,
  only_candidate: 'Seul télépro éligible',
  stable_hash: 'Départage stable (égalité parfaite)',
  campaign_not_active: 'Campagne non active',
  duplicate_review: 'Doublon à examiner par un manager',
  auto_distribution_off: 'Distribution automatique désactivée',
  no_candidate: 'Aucun télépro disponible',
  ...EXCLUSION_LABELS,
};

export const DISTRIBUTION_EVENT_LABELS: Record<string, string> = {
  assign: 'Attribution automatique',
  reassign: 'Réattribution',
  buffer: 'File tampon',
  manual: 'Attribution manuelle',
  bulk_transfer: 'Transfert de portefeuille',
  simulation: 'Simulation',
};

export const TEMPERATURE_LABELS = { hot: 'Chaud', warm: 'Tiède', to_work: 'À travailler' } as const;

export const DOCUMENT_STATE_LABELS: Record<string, string> = {
  none: 'Aucun document demandé',
  requested: 'Documents demandés',
  partial: 'Documents partiels',
  received_to_check: 'Documents à contrôler',
  incomplete_non_conform: 'Documents non conformes',
  complete: 'Documents complets',
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  take_new_lead: 'Prendre en charge le nouveau lead',
  client_callback: 'Rappeler le client',
  short_callback: 'Rappel rapide',
  interested_followup: 'Relancer le prospect intéressé',
  document_followup: 'Relancer les documents manquants',
  promised_docs_missing: 'Documents promis non reçus',
  document_review: 'Contrôler les documents reçus',
  nr_attempt: 'Nouvelle tentative d’appel',
  build_file: 'Monter le dossier',
  document_decision: 'Décider : poursuivre, recycler ou clôturer',
  recycle: 'Recontacter (recyclage)',
};

export const ASSIGNMENT_STATE_LABELS = { assigned: 'Attribué', to_assign: 'À attribuer', buffer: 'File tampon' } as const;
