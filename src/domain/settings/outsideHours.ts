// Comportement hors horaires commerciaux (§19.4, fig. 18) : un lead reçu quand l'entreprise est fermée est mis en attente
// jusqu'à l'ouverture (comportement d'origine), attribué immédiatement, ou confié à l'équipe de garde. Fonction PURE :
// elle adapte la configuration d'attribution du lead qui arrive, sans rien changer d'autre.

import type { AssignmentConfig } from '../engine/assignment';
import { isWithinSchedule } from '../engine/schedule';
import type { CampaignInfo } from '../ingest/plan';
import { scheduleOf } from './runtime';
import type { SlaSettings } from './settings';

export interface OutsideHoursResult {
  config: AssignmentConfig;
  campaign: CampaignInfo | null;
  /** Ce qui a été appliqué, pour l'historique : null quand rien ne change. */
  applied: 'immediate' | 'duty_team' | null;
}

export function applyOutsideHours(args: { config: AssignmentConfig; campaign: CampaignInfo | null; sla: SlaSettings; nowMs: number }): OutsideHoursResult {
  const { config, campaign, sla, nowMs } = args;
  const unchanged: OutsideHoursResult = { config, campaign, applied: null };
  if (sla.outsideHours === 'hold' || isWithinSchedule(scheduleOf(sla), nowMs)) return unchanged;

  // Les horaires propres à chaque télépro ne s'appliquent plus : c'est précisément le choix « attribuer quand même ».
  const open: AssignmentConfig = { ...config, criteria: { ...config.criteria, working_hours: false } };
  if (sla.outsideHours === 'immediate') return { config: open, campaign, applied: 'immediate' };

  // Équipe de garde : seulement l'équipe de secours reçoit le lead. Sans campagne, il n'y a rien à restreindre.
  if (sla.outsideHours === 'duty_team' && sla.fallbackTeamId && campaign) {
    return { config: open, campaign: { ...campaign, eligibleUserIds: [], eligibleTeamIds: [sla.fallbackTeamId], fallbackTeamId: null, autoEligible: false }, applied: 'duty_team' };
  }
  return unchanged;
}
