// Détection de doublons (§4.3, §24.3). Résultat explicable, avec niveau de confiance.
// Ne crée rien et ne modifie rien : la décision d'écriture appartient à l'appelant.

import type { DuplicateOutcome, LeadStatus } from '../enums';
import { CLOSED_LEAD_STATUSES } from '../enums';
import { normalizeText } from './normalize';

export interface IncomingLead {
  phone: string | null; // déjà normalisé (E.164)
  email: string | null; // déjà normalisé (minuscules)
  externalId: string | null;
  sourceId: string | null;
  fullName: string;
  addressLine: string;
  postalCode: string | null;
}

export interface ExistingLeadSummary {
  id: string;
  phone: string | null;
  email: string | null;
  externalId: string | null;
  sourceId: string | null;
  fullName: string;
  addressLine: string;
  postalCode: string | null;
  status: LeadStatus;
  ownerId: string | null;
}

export type MatchReason = 'external_id' | 'phone' | 'email' | 'name_and_address';

export interface DuplicateMatch {
  leadId: string;
  reasons: MatchReason[];
  /** 0 à 1 */
  confidence: number;
  status: LeadStatus;
  ownerId: string | null;
}

export interface DuplicateResult {
  outcome: DuplicateOutcome;
  matches: DuplicateMatch[];
  /** Fiche à laquelle rattacher / comparer : la plus fiable, à égalité la plus ouverte. */
  primaryMatchId: string | null;
  /** true si la même donnée a déjà été reçue (relance de la source) : ne rien recréer. */
  isReplay: boolean;
  explanation: string;
}

/** Confiance par motif. Le cumul est plafonné à 1. */
export const CONFIDENCE = {
  external_id: 1,
  phone: 0.9,
  email: 0.9,
  name_and_address: 0.5,
} as const;

/** En dessous : pas considéré comme doublon. */
export const PROBABLE_THRESHOLD = 0.5;
/** À partir de là, la fiche existante est la même personne (téléphone ou email identique). */
export const HIGH_CONFIDENCE = 0.9;

export function findDuplicates(incoming: IncomingLead, existing: readonly ExistingLeadSummary[]): DuplicateResult {
  const matches: DuplicateMatch[] = [];

  for (const e of existing) {
    const reasons: MatchReason[] = [];

    if (incoming.externalId && incoming.sourceId && e.externalId === incoming.externalId && e.sourceId === incoming.sourceId) {
      reasons.push('external_id');
    }
    if (incoming.phone && e.phone === incoming.phone) reasons.push('phone');
    if (incoming.email && e.email === incoming.email) reasons.push('email');

    // Nom + adresse : faible à lui seul (homonymes) ; jamais utilisé s'il manque l'un des deux.
    const sameName = normalizeText(incoming.fullName) !== '' && normalizeText(incoming.fullName) === normalizeText(e.fullName);
    const sameAddress =
      normalizeText(incoming.addressLine) !== '' &&
      normalizeText(incoming.addressLine) === normalizeText(e.addressLine) &&
      !!incoming.postalCode &&
      incoming.postalCode === e.postalCode;
    if (sameName && sameAddress) reasons.push('name_and_address');

    if (reasons.length === 0) continue;
    const confidence = Math.min(1, Math.max(...reasons.map((r) => CONFIDENCE[r])) + 0.05 * (reasons.length - 1));
    if (confidence < PROBABLE_THRESHOLD) continue;

    matches.push({ leadId: e.id, reasons, confidence, status: e.status, ownerId: e.ownerId });
  }

  matches.sort((a, b) => b.confidence - a.confidence || Number(isOpen(b.status)) - Number(isOpen(a.status)) || a.leadId.localeCompare(b.leadId));

  if (matches.length === 0) {
    return { outcome: 'new_lead', matches, primaryMatchId: null, isReplay: false, explanation: 'Aucune fiche existante ne correspond.' };
  }

  const primary = matches[0];
  const isReplay = primary.reasons.includes('external_id');

  if (isReplay) {
    return {
      outcome: 'attached_to_open_lead',
      matches,
      primaryMatchId: primary.leadId,
      isReplay: true,
      explanation: 'Cet identifiant externe a déjà été reçu : relance de la source, rien à recréer.',
    };
  }

  // Un lead déjà converti = un client connu (§24.3 : alerte + rattachement au client).
  const converted = matches.find((m) => m.status === 'converted' && m.confidence >= HIGH_CONFIDENCE);
  if (converted) {
    return {
      outcome: 'known_client',
      matches,
      primaryMatchId: converted.leadId,
      isReplay: false,
      explanation: `Le ${describe(converted.reasons)} correspond à un lead déjà converti en client.`,
    };
  }

  const openStrong = matches.find((m) => m.confidence >= HIGH_CONFIDENCE && isOpen(m.status));
  if (openStrong) {
    return {
      outcome: 'attached_to_open_lead',
      matches,
      primaryMatchId: openStrong.leadId,
      isReplay: false,
      explanation: `Le ${describe(openStrong.reasons)} correspond à un lead encore ouvert : nouvelle interaction rattachée, sans second compteur SLA.`,
    };
  }

  // Correspondance forte mais fiche close, ou correspondance faible : décision humaine.
  return {
    outcome: 'probable_duplicate',
    matches,
    primaryMatchId: primary.leadId,
    isReplay: false,
    explanation:
      primary.confidence >= HIGH_CONFIDENCE
        ? `Le ${describe(primary.reasons)} correspond à un lead clos : décision du manager nécessaire.`
        : 'Même nom et même adresse qu\'une fiche existante, sans téléphone ni email identique : décision nécessaire.',
  };
}

export function isOpen(status: LeadStatus): boolean {
  return !CLOSED_LEAD_STATUSES.includes(status);
}

function describe(reasons: readonly MatchReason[]): string {
  const labels: Record<MatchReason, string> = {
    external_id: 'identifiant externe',
    phone: 'téléphone',
    email: 'email',
    name_and_address: 'nom et adresse',
  };
  return reasons.map((r) => labels[r]).join(' et ');
}
