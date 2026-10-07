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

  // Paramétrage versionné
  config: 'cl_config',
} as const;

/** Sous-collections d'un lead : cl_leads/{leadId}/… */
export const SUB = {
  events: 'events',
  callAttempts: 'callAttempts',
  documents: 'documents',
} as const;

/** Sous-collection de versions d'un module de config : cl_config/{module}/versions/{versionId} */
export const CONFIG_VERSIONS = 'versions';
