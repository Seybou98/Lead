// Simulation d'attribution (fig. 17, §19.7). Elle appelle EXACTEMENT les mêmes fonctions que
// l'ingestion réelle (buildCandidates puis decideAssignment) : à données identiques, la simulation
// et l'attribution réelle donnent la même décision. Rien n'est écrit.

import {
  decideAssignment,
  type AssignmentConfig,
  type AssignmentDecision,
  type Evaluation,
  type ExclusionCode,
} from '../engine/assignment';
import {
  buildCandidates,
  type AbsenceInput,
  type PresenceInput,
  type ProfileInput,
  type UserInput,
} from '../ingest/candidates';
import type { CampaignInfo } from '../ingest/plan';

export interface SimulationInput {
  /** Lead fictif : produit et zone, comme dans « Lead entrant » de la maquette. */
  lead: { productCode: string | null; zone: string | null };
  campaign: CampaignInfo | null;
  profiles: readonly ProfileInput[];
  users: Readonly<Record<string, UserInput | undefined>>;
  presence: Readonly<Record<string, PresenceInput | undefined>>;
  absences: readonly AbsenceInput[];
  nowMs: number;
  config: AssignmentConfig;
  /**
   * Identifiant du lead. Il ne sert qu'à départager deux télépros parfaitement à égalité (hash
   * stable) : une simulation et une attribution réelle ne peuvent différer que dans ce cas précis.
   */
  leadId?: string;
}

export interface SimulationRow {
  uid: string;
  name: string;
  eligible: boolean;
  recommended: boolean;
  exclusions: ExclusionCode[];
  newLeads: number;
  cap: number;
}

export interface SimulationResult {
  decision: AssignmentDecision;
  /** Éligibles du meilleur au moins bon, puis exclus par nom. */
  rows: SimulationRow[];
  recommendedUid: string | null;
  recommendedName: string | null;
}

export const SIMULATION_LEAD_ID = 'simulation';

export function simulateAssignment(input: SimulationInput): SimulationResult {
  const { candidates } = buildCandidates({
    profiles: input.profiles,
    users: input.users,
    presence: input.presence,
    absences: input.absences,
    nowMs: input.nowMs,
  });

  const decision = decideAssignment(
    { id: input.leadId ?? SIMULATION_LEAD_ID, productCode: input.lead.productCode, zone: input.lead.zone, campaignId: input.campaign?.id ?? null },
    input.campaign,
    candidates,
    input.nowMs,
    input.config
  );

  const byUid = new Map(decision.evaluations.map((e) => [e.uid, e]));
  const toRow = (e: Evaluation): SimulationRow => ({
    uid: e.uid,
    name: e.name,
    eligible: e.eligible,
    recommended: e.uid === decision.chosenUid,
    exclusions: e.exclusions,
    newLeads: e.newLeads,
    cap: e.effectiveCap,
  });

  const rankIndex = new Map(decision.ranking.map((uid, i) => [uid, i]));
  const rows = decision.evaluations
    .map(toRow)
    .sort((a, b) => {
      const ra = rankIndex.get(a.uid);
      const rb = rankIndex.get(b.uid);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.name.localeCompare(b.name, 'fr');
    });

  return {
    decision,
    rows,
    recommendedUid: decision.chosenUid,
    recommendedName: decision.chosenUid ? (byUid.get(decision.chosenUid)?.name ?? null) : null,
  };
}
