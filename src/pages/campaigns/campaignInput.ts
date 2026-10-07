import type { CampaignInput } from '../../lib/adminApi';
import type { CampaignRecord } from './useCampaignsData';

/** Reprend une campagne existante en entrée de la fonction d'enregistrement, avec des champs modifiés. */
export function campaignToInput(c: CampaignRecord, over: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: c.id,
    name: c.name,
    sourceId: c.sourceId,
    externalId: c.externalId,
    productCode: c.productCode,
    zones: [...c.zones],
    status: c.status,
    budgetCents: c.budgetCents,
    startsAtMs: c.startsAtMs,
    endsAtMs: c.endsAtMs,
    eligibleTeamIds: [...c.eligibleTeamIds],
    eligibleUserIds: [...c.eligibleUserIds],
    fallbackTeamId: c.fallbackTeamId,
    maxReassignments: c.maxReassignments,
    autoEligible: c.autoEligible,
    receptionSchedule: c.receptionSchedule,
    ...over,
  };
}
