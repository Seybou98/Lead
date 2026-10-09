// Retour des statuts du CRM principal vers le CRM Leads (§11.8, §24.8). Fonctions pures.
//
// Le CRM principal fait avancer le dossier créé par la transmission : contrôle du dossier, validation (qui crée le
// client), chantier, facturation, annulation. Le CRM Leads ne les modifie jamais : il les LIT, en déduit une étape
// commerciale et la répercute sur le lead et la vente, sans jamais rouvrir une étape commerciale clôturée.
// Les valeurs reconnues sont celles du CRM principal (dossier-status.ts, projects.tsx, promote-dossier-to-client.ts),
// copiées ici pour que le CRM Leads se déploie seul. Une valeur inconnue donne l'étape « unknown » : jamais d'invention.

export const MAIN_STAGES = [
  'dossier_incomplete', // dossier créé, pièces ou informations manquantes
  'complement_requested', // le CRM principal demande un complément
  'dossier_complete', // dossier complet, pas encore validé
  'dossier_validated', // contrôle administratif validé : conversion confirmée
  'client_created', // client créé, chantier à programmer
  'scheduled', // chantier planifié (placé, confirmé, préparé, chargé, à décaler)
  'in_progress', // chantier en cours
  'installed', // chantier terminé
  'invoiced', // facturé (MPR, CEE ou les deux)
  'cancelled', // annulé, abandonné ou infaisable
  'unknown',
] as const;
export type MainStage = (typeof MAIN_STAGES)[number];

export const MAIN_STAGE_LABELS: Record<MainStage, string> = {
  dossier_incomplete: 'Dossier incomplet',
  complement_requested: 'Complément demandé',
  dossier_complete: 'Dossier complet',
  dossier_validated: 'Dossier validé',
  client_created: 'Client à programmer',
  scheduled: 'Chantier planifié',
  in_progress: 'Chantier en cours',
  installed: 'Installé',
  invoiced: 'Facturé',
  cancelled: 'Annulé',
  unknown: 'Statut inconnu',
};

/** Rang d'avancement (l'annulation et l'inconnu n'en ont pas) ; sert à reconnaître un recul. */
export const MAIN_STAGE_RANK: Record<MainStage, number> = {
  dossier_incomplete: 0,
  complement_requested: 1,
  dossier_complete: 2,
  dossier_validated: 3,
  client_created: 4,
  scheduled: 5,
  in_progress: 6,
  installed: 7,
  invoiced: 8,
  cancelled: -1,
  unknown: -1,
};

/** Étapes finales : plus rien à surveiller ensuite. */
export const isTerminalStage = (s: MainStage): boolean => s === 'invoiced' || s === 'cancelled';

const norm = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

export interface MainInput {
  /** `dossiers.status` : incomplet, complet, valide, brouillon, complement_demande, complement_traite, abandonner. */
  dossierStatus: unknown;
  /** Le dossier a été promu en client (`clientId` / `promotedClientId`) ou un client existe pour lui. */
  hasClient: boolean;
  /** `clients.status` : aprogrammer, placer, confirmer, preparer, charger, encours, commencer, terminer, facturer_*, annuler… */
  clientStatus: unknown;
  /** `subventions.dossier.statut` : incomplet_a_completer, controle_admin_valider, … */
  subventionStatus: unknown;
}

const SCHEDULED = new Set(['placer', 'confirmer', 'preparer', 'charger', 'adecaler']);
const IN_PROGRESS = new Set(['encours', 'commencer']);

export interface MainResult {
  stage: MainStage;
  label: string;
  /** Valeurs lues, conservées pour comprendre une étape. */
  raw: { dossier: string; client: string; subvention: string };
}

export function resolveMainStage(i: MainInput): MainResult {
  const dossier = norm(i.dossierStatus);
  const client = norm(i.clientStatus);
  const subvention = norm(i.subventionStatus);
  const make = (stage: MainStage): MainResult => ({ stage, label: MAIN_STAGE_LABELS[stage], raw: { dossier, client, subvention } });

  // Annulation : prioritaire sur tout le reste.
  if (dossier === 'abandonner' || dossier === 'abandonne' || client === 'annuler' || client === 'infaisable') return make('cancelled');

  // Le chantier et la facturation ne concernent que les dossiers devenus clients.
  if (i.hasClient) {
    if (client.startsWith('facturer')) return make('invoiced');
    if (client === 'terminer') return make('installed');
    if (IN_PROGRESS.has(client)) return make('in_progress');
    if (SCHEDULED.has(client)) return make('scheduled');
    // Client sans statut de chantier connu : à programmer (statut vide ou ancien « active », comme le CRM principal).
    if (client === '' || client === 'aprogrammer' || client === 'active' || client === 'upcoming') return make('client_created');
    return make('unknown');
  }

  if (dossier === 'valide' || dossier === 'validated' || subvention === 'controle_admin_valider') return make('dossier_validated');
  if (dossier === 'complement_demande') return make('complement_requested');
  if (dossier === 'complet' || dossier === 'complete' || dossier === 'complement_traite') return make('dossier_complete');
  if (dossier === 'incomplet' || dossier === 'brouillon' || dossier === 'draft' || dossier === '' || subvention === 'incomplet_a_completer') return make('dossier_incomplete');
  return make('unknown');
}

/** Ce qu'un changement d'étape déclenche côté CRM Leads (§24.8). */
export interface StageChange {
  /** Phrase pour l'historique du lead. */
  note: string;
  /** Notifier le propriétaire et les managers ; null = pas de notification. */
  notify: { title: string; description: string; sound: 'critical' | null } | null;
  /** La vente est retirée des ventes nettes (annulation côté CRM principal). */
  cancelsSale: boolean;
  /** Indicateur : étape atteinte pour la première fois (dossier validé, installé, facturé). */
  milestone: 'validated' | 'installed' | 'invoiced' | null;
}

export function describeChange(from: MainStage | null, to: MainStage, who: string): StageChange {
  const label = MAIN_STAGE_LABELS[to];
  const note = from ? `CRM principal : ${MAIN_STAGE_LABELS[from]} → ${label}` : `CRM principal : ${label}`;
  const base: StageChange = { note, notify: null, cancelsSale: false, milestone: null };
  switch (to) {
    case 'dossier_incomplete':
    case 'complement_requested':
      // « Dossier incomplet : action documentaire ciblée avec propriétaire et échéance » : seulement quand le dossier
      // recule (il était déjà plus avancé) ou qu'un complément est réclamé ; l'état initial ne prévient personne.
      return from !== null && (to === 'complement_requested' || MAIN_STAGE_RANK[from] > MAIN_STAGE_RANK[to])
        ? { ...base, notify: { title: to === 'complement_requested' ? 'Complément demandé par le CRM principal' : 'Dossier à nouveau incomplet', description: `${who} : pièces ou informations à fournir, à traiter avec le client.`, sound: null } }
        : base;
    case 'dossier_validated':
      return { ...base, milestone: 'validated', notify: { title: 'Dossier validé', description: `${who} : conversion confirmée par le CRM principal.`, sound: null } };
    case 'installed':
      return { ...base, milestone: 'installed' };
    case 'invoiced':
      return { ...base, milestone: 'invoiced' };
    case 'cancelled':
      return { ...base, cancelsSale: true, notify: { title: 'Dossier annulé dans le CRM principal', description: `${who} : la vente est retirée des ventes nettes.`, sound: 'critical' } };
    default:
      return base;
  }
}
