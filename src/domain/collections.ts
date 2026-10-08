// Noms des collections Firestore du module CRM Leads.
// Préfixe `cl_` obligatoire : la base est partagée avec le CRM principal, qui possède déjà
// `leads`, `users`, `notifications`, `clients`… Ne jamais écrire dans ces collections-là.

export const COL = {
  // Personnes et organisation
  profiles: 'cl_profiles',
  presence: 'cl_presence',
  teams: 'cl_teams',
  absences: 'cl_absences',

  // Cœur métier
  rawLeads: 'cl_rawLeads',
  leads: 'cl_leads',
  actions: 'cl_actions',
  sales: 'cl_sales',
  conversions: 'cl_conversions',

  // Acquisition
  campaigns: 'cl_campaigns',
  sources: 'cl_sources',
  adSpend: 'cl_adSpend',

  // Moteur et traçabilité
  distributionLog: 'cl_distributionLog',
  audit: 'cl_audit',
  notifications: 'cl_notifications',
  integrationLog: 'cl_integrationLog',
  idempotency: 'cl_idempotency',

  // Lots de transferts de portefeuille (propriétaire d'origine, retour des transferts temporaires)
  transfers: 'cl_transfers',
  // Brouillons de transfert de portefeuille (propres à chaque manager)
  transferDrafts: 'cl_transferDrafts',
  // Réglages d'administration (SLA et horaires, cycles NR, relances) : un document par sujet, modifiable par l'administrateur
  settings: 'cl_settings',
  // Paramétrage versionné
  config: 'cl_config',
  // Checklists documentaires, une par famille de produit (identifiant = clé de la famille, « default » pour les autres)
  checklists: 'cl_checklists',
} as const;

/** Sous-collections d'un lead : cl_leads/{leadId}/… */
export const SUB = {
  events: 'events',
  callAttempts: 'callAttempts',
  documents: 'documents',
} as const;

/** Sous-collection de versions d'un module de config : cl_config/{module}/versions/{versionId} */
export const CONFIG_VERSIONS = 'versions';
