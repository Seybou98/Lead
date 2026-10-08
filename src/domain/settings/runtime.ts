// Du paramétrage (settings.ts) aux règles que lisent la qualification d'appel, les documents et le planificateur.
// Une seule direction : l'écran d'administration écrit des réglages, ces fonctions les traduisent, et les moteurs
// n'ont jamais de valeur « en dur » à côté. Fonctions pures.

import { DEFAULT_CALL_RULES, type CallRules } from '../call/plan';
import type { DocumentRules } from '../documents/plan';
import type { SchedulerRules } from '../scheduler/plan';
import type { ScheduleLike } from '../engine/schedule';
import type { RulesSettings, SlaSettings } from './settings';

const MIN = 60_000;

/** Planning commercial (horaires et jours fermés) tel que le lisent les moteurs. */
export const scheduleOf = (sla: SlaSettings): ScheduleLike => ({ timezone: sla.schedule.timezone, weekly: sla.schedule.weekly, closedDates: sla.schedule.closedDates });

export function callRulesFrom(rules: RulesSettings, sla: SlaSettings): CallRules {
  return {
    ...DEFAULT_CALL_RULES,
    nrDelaysMinutes: rules.nrDelaysMinutes,
    recycleAfterDays: rules.recycleAfterDays,
    // La première relance documentaire est la première échéance de la cadence (J+1 par défaut).
    documentFollowUpDays: rules.followUpDays[0],
    promisedMarginMinutes: rules.promisedMarginMinutes,
    schedule: scheduleOf(sla),
  };
}

export function documentRulesFrom(rules: RulesSettings, sla: SlaSettings): DocumentRules {
  return {
    followUpDays: rules.followUpDays,
    decisionRepeatDays: rules.decisionRepeatDays,
    promisedMarginMinutes: rules.promisedMarginMinutes,
    recycleAfterDays: rules.recycleAfterDays,
    schedule: scheduleOf(sla),
  };
}

export function schedulerRulesFrom(rules: RulesSettings, sla: SlaSettings): SchedulerRules {
  return {
    callbackEscalationMin: rules.callbackEscalationMin,
    slaMs: sla.firstAlertMin * MIN,
    criticalMs: sla.criticalMin * MIN,
    suspendOutsideHours: sla.suspendOutsideHours,
    bufferWarnMin: rules.bufferWarnMin,
    bufferAnomalyHours: rules.bufferAnomalyHours,
    maxRecycleCycles: rules.maxRecycleCycles,
    schedule: scheduleOf(sla),
  };
}
