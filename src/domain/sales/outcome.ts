// Issue commerciale d'un lead (§11.8, §22, §24.8) : UNE seule définition, partagée par les tableaux de campagne et de
// télépro, le cockpit et les rapports, pour qu'un même chiffre ne se calcule jamais de deux façons.
//
//   vendu      une vente existe (statut « Converti », « Transmission en cours » ou en erreur, ou axe commercial renseigné) ;
//   annulé     vente annulée ou rétractée côté CRM Leads, ou dossier annulé / abandonné dans le CRM principal ;
//   net        vendu et non annulé : c'est ce qu'on appelle « ventes » dans les tableaux (retrait des ventes nettes) ;
//   sécurisé   net, signé ET paiement confirmé ou financement accepté ;
//   validé     le CRM principal a validé le dossier ; installé / facturé : étapes de chantier atteintes (annulé : aucune).

import { MAIN_STAGE_RANK, type MainStage } from '../mainSync/mainStatus';

export interface OutcomeInput {
  status: string;
  commercialState?: string | null;
  financialState?: string | null;
  /** Étape du dossier dans le CRM principal (retour des statuts) ; absente tant qu'aucune lecture n'a eu lieu. */
  mainStage?: string | null;
}

/** Un lead de la liste (LeadListItem) vu comme entrée du classement. */
export const toOutcomeInput = (l: { status: string; commercialState?: string; financialState?: string; mainStatus?: { stage: string } }): OutcomeInput => ({
  status: l.status,
  commercialState: l.commercialState ?? null,
  financialState: l.financialState ?? null,
  mainStage: l.mainStatus?.stage ?? null,
});

export interface Outcome {
  sold: boolean;
  cancelled: boolean;
  /** Vendu et non annulé. */
  net: boolean;
  secured: boolean;
  validated: boolean;
  installed: boolean;
  invoiced: boolean;
}

const SALE_STATUSES = ['converted', 'transmitting', 'transmission_error'];
const rankOf = (stage: string | null | undefined): number => (stage && stage in MAIN_STAGE_RANK ? MAIN_STAGE_RANK[stage as MainStage] : -1);

export function outcomeOf(l: OutcomeInput): Outcome {
  const commercial = l.commercialState && l.commercialState !== 'none' ? l.commercialState : null;
  const sold = SALE_STATUSES.includes(l.status) || commercial !== null;
  const cancelled = sold && (commercial === 'cancelled' || commercial === 'retracted' || l.mainStage === 'cancelled');
  const net = sold && !cancelled;
  const rank = rankOf(l.mainStage);
  return {
    sold,
    cancelled,
    net,
    secured: net && commercial === 'signed' && (l.financialState === 'payment_confirmed' || l.financialState === 'financing_accepted'),
    validated: net && rank >= MAIN_STAGE_RANK.dossier_validated,
    installed: net && rank >= MAIN_STAGE_RANK.installed,
    invoiced: net && rank >= MAIN_STAGE_RANK.invoiced,
  };
}

export interface OutcomeCounts {
  sold: number;
  cancelled: number;
  net: number;
  secured: number;
  validated: number;
  installed: number;
  invoiced: number;
}

export const EMPTY_OUTCOME_COUNTS: OutcomeCounts = { sold: 0, cancelled: 0, net: 0, secured: 0, validated: 0, installed: 0, invoiced: 0 };

export function countOutcomes(leads: readonly OutcomeInput[]): OutcomeCounts {
  const c = { ...EMPTY_OUTCOME_COUNTS };
  for (const l of leads) {
    const o = outcomeOf(l);
    for (const k of Object.keys(c) as (keyof OutcomeCounts)[]) if (o[k]) c[k] += 1;
  }
  return c;
}

/** Taux en pourcentage à une décimale ; null si le dénominateur est nul (« — », jamais 0 ni NaN, §22.12). */
export const ratePct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
