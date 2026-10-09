// Qualification de fin d'appel (§12.1.2-3, §25.4, figs. 5 à 13) : les résultats proposés, leurs motifs et la
// forme des formulaires. Aucune logique ici : la validation et les conséquences sont dans plan.ts.

import type { Temperature } from '../enums';

/** Les six choix visibles (§25.4). « Mauvais moment » est un cas de « À rappeler » (fig. 13). */
export const CALL_CHOICES = ['no_answer', 'callback', 'interested', 'request_documents', 'close_now', 'close'] as const;
export type CallChoice = (typeof CALL_CHOICES)[number];

export const CALL_CHOICE_LABELS: Record<CallChoice, { title: string; hint: string }> = {
  no_answer: { title: 'Pas de réponse', hint: "Le client n'a pas décroché." },
  callback: { title: 'À rappeler', hint: 'Planifier un prochain appel.' },
  interested: { title: 'Intéressé', hint: 'Le client est intéressé par le projet.' },
  request_documents: { title: 'Demander les documents', hint: 'Récupérer les pièces nécessaires.' },
  close_now: { title: 'Conclure maintenant', hint: 'Passer à la signature.' },
  close: { title: 'Clôturer', hint: 'Mettre fin au suivi.' },
};

// ── À rappeler / mauvais moment (figs. 7 et 13) ──────────────────────────────

export const CALLBACK_REASONS = {
  available_after_work: 'Disponible après son travail',
  consult_spouse: 'Doit en parler à son conjoint',
  compare_offers: 'Compare plusieurs offres',
  documents_to_gather: 'Doit rassembler des documents',
  asked_callback: 'A demandé à être rappelé',
  other: 'Autre',
} as const;
/** Code d'un motif : une valeur d'origine ou une valeur ajoutée dans Paramètres (listes modifiables, §21.6). */
export type CallbackReason = string;

export const BAD_MOMENT_REASONS = {
  busy: 'Client occupé',
  at_work: 'Au travail',
  travelling: 'En déplacement',
  meeting: 'En réunion',
  explicit_request: 'Demande explicite',
  other: 'Autre',
} as const;
export type BadMomentReason = string;

/** Délais proposés pour un rappel rapide (fig. 13), en minutes. */
export const BAD_MOMENT_DELAYS = [
  { key: '15', label: 'Dans 15 min', minutes: 15 },
  { key: '30', label: 'Dans 30 min', minutes: 30 },
  { key: '60', label: 'Dans 1 heure', minutes: 60 },
] as const;

// ── Intéressé (fig. 8, §9) ───────────────────────────────────────────────────

export const INTEREST_REASONS = {
  reflection: 'Réflexion en cours',
  consult_spouse: 'Conjoint à consulter',
  planning: 'Planning',
  wants_information: 'Informations souhaitées',
  needs_documents: 'Documents nécessaires',
  comparison: 'Comparaison',
  financing: 'Financement',
  other: 'Autre',
} as const;
export type InterestReason = string;

export const TEMPERATURE_CHOICES: { key: Temperature; title: string; hint: string }[] = [
  { key: 'hot', title: 'Chaud', hint: "Intention claire, proche de l'action" },
  { key: 'warm', title: 'Tiède', hint: 'Intérêt réel, réflexion nécessaire' },
  { key: 'to_work', title: 'À travailler', hint: 'Intérêt faible mais confirmé' },
];

/** Prochaine action d'un prospect intéressé : elle est OBLIGATOIRE (§9.1). */
export const INTEREST_NEXT_ACTIONS = {
  call: 'Rappeler',
  send_information: 'Envoyer des informations',
  send_documents: 'Envoyer les documents',
  visit: 'Planifier une visite',
} as const;
export type InterestNextAction = keyof typeof INTEREST_NEXT_ACTIONS;

// ── Documents (fig. 9, §10.1) ────────────────────────────────────────────────

export const DOCUMENT_CHANNELS = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', other: 'Autre' } as const;
export type DocumentChannelKey = keyof typeof DOCUMENT_CHANNELS;

export interface DocumentTypeDef {
  code: string;
  label: string;
  mandatory: boolean;
}

/**
 * Checklist par défaut, en attendant la configuration des checklists (§21) : pièces habituelles d'un
 * dossier de rénovation énergétique. Les trois premières lignes de la maquette sont obligatoires.
 */
export const DEFAULT_DOCUMENT_TYPES: readonly DocumentTypeDef[] = [
  { code: 'identity', label: "Pièce d'identité", mandatory: true },
  { code: 'tax_notice', label: "Avis d'imposition", mandatory: true },
  { code: 'proof_of_address', label: 'Justificatif de domicile', mandatory: true },
  { code: 'property_tax', label: 'Taxe foncière', mandatory: true },
  { code: 'bank_details', label: 'RIB', mandatory: false },
  { code: 'other', label: 'Autre document', mandatory: false },
];

// ── Clôture (figs. 10 à 12) ──────────────────────────────────────────────────

export const CLOSE_REASONS = {
  not_interested: 'Non intéressé',
  ineligible: 'Inéligible',
  fake_lead: 'Faux lead',
  wrong_number: 'Mauvais numéro',
  other: 'Autre',
} as const;
export type CloseReason = keyof typeof CLOSE_REASONS;

export const REFUSAL_MOTIVES = {
  price: 'Prix',
  not_interested: 'Pas intéressé',
  competitor: 'Concurrent',
  postponed: 'Projet reporté',
  refuses_procedures: 'Refus des démarches',
  no_more_contact: 'Ne souhaite plus être contacté',
  other: 'Autre',
} as const;
export type RefusalMotive = string;

export const REFUSAL_FOLLOW_UPS = {
  close: 'Clôturer définitivement',
  recycle: 'Placer en recyclage à une date',
} as const;
export type RefusalFollowUp = keyof typeof REFUSAL_FOLLOW_UPS;

export const INELIGIBLE_CATEGORIES = {
  technical: 'Technique',
  administrative: 'Administrative',
  financial: 'Financière',
  zone: 'Zone non couverte',
} as const;
export type IneligibleCategory = keyof typeof INELIGIBLE_CATEGORIES;

/** Motifs précis, par catégorie (fig. 11). */
export const INELIGIBLE_MOTIVES: Record<IneligibleCategory, Record<string, string>> = {
  technical: {
    incompatible_housing: 'Configuration du logement incompatible',
    unsuitable_equipment: 'Équipement non adapté',
    insufficient_surface: 'Surface insuffisante',
  },
  administrative: {
    tenant: 'Locataire',
    incompatible_apartment: 'Appartement incompatible',
  },
  financial: {
    income_or_aids: 'Revenus / aides',
  },
  zone: {
    zone_not_covered: 'Zone non couverte',
  },
};

export const FAKE_LEAD_MOTIVES = {
  fake_number: 'Faux numéro',
  invalid_number: 'Numéro invalide',
  usurped_identity: 'Coordonnées usurpées',
  duplicate: 'Doublon',
  out_of_target: 'Hors cible manifeste',
  spam: 'Test / spam',
  other: 'Autre',
} as const;
export type FakeLeadMotive = string;

// ── Entrée envoyée au serveur (une forme par résultat) ───────────────────────

export type CallOutcomeInput =
  | { kind: 'no_answer'; comment?: string; refusedCall?: boolean }
  | { kind: 'callback'; atMs: number; reason: CallbackReason; comment: string; confirmed: boolean }
  | { kind: 'bad_moment'; atMs: number; reason: BadMomentReason; note?: string; confirmed: boolean }
  | {
      kind: 'interested';
      temperature: Temperature;
      reason: InterestReason;
      nextAction: InterestNextAction;
      nextActionAtMs: number;
      comment: string;
    }
  | { kind: 'request_documents'; documents: string[]; channel: DocumentChannelKey; promisedAtMs: number | null; note?: string }
  | { kind: 'close_not_interested'; motive: RefusalMotive; comment: string; followUp: RefusalFollowUp; recycleAtMs?: number | null; opposition: boolean }
  | {
      kind: 'close_ineligible';
      category: IneligibleCategory;
      motive: string;
      product: string;
      justification: string;
      alternativeProduct?: string | null;
    }
  | { kind: 'close_fake_lead'; motive: FakeLeadMotive; comment: string; requestManagerCheck: boolean }
  | { kind: 'close_wrong_number'; comment?: string }
  | { kind: 'close_other'; comment: string };

export type CallOutcomeKind = CallOutcomeInput['kind'];

/** Libellé court d'un résultat, pour l'historique et les confirmations. */
export const OUTCOME_LABELS: Record<CallOutcomeKind, string> = {
  no_answer: 'Pas de réponse',
  callback: 'À rappeler',
  bad_moment: 'Mauvais moment',
  interested: 'Intéressé',
  request_documents: 'Documents demandés',
  close_not_interested: 'Non intéressé',
  close_ineligible: 'Inéligible',
  close_fake_lead: 'Faux lead',
  close_wrong_number: 'Mauvais numéro',
  close_other: 'Clôturé',
};
