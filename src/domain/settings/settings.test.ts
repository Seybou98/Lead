import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_SETTINGS,
  DEFAULT_SLA_SETTINGS,
  effectiveSla,
  formatDelay,
  parseRulesSettings,
  parseSlaOverride,
  parseSlaSettings,
  validateRulesSettings,
  validateSlaSettings,
  type RulesSettings,
  type SlaSettings,
} from './settings';
import { callRulesFrom, documentRulesFrom, schedulerRulesFrom } from './runtime';
import { DEFAULT_CALL_RULES } from '../call/plan';
import { DEFAULT_DOCUMENT_RULES } from '../documents/plan';
import { DEFAULT_SCHEDULER_RULES } from '../scheduler/plan';

const sla = (over: Partial<SlaSettings> = {}): SlaSettings => ({ ...DEFAULT_SLA_SETTINGS, ...over });
const rules = (over: Partial<RulesSettings> = {}): RulesSettings => ({ ...DEFAULT_RULES_SETTINGS, ...over });

describe('parseSlaSettings', () => {
  it('rien ou illisible : les valeurs du cahier', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}]) expect(parseSlaSettings(raw)).toEqual(DEFAULT_SLA_SETTINGS);
  });
  it('valeurs valides prises, invalides ignorées une par une', () => {
    const p = parseSlaSettings({ firstAlertMin: 3, criticalMin: 'x', reassignMin: -5, autoReassign: true, maxReassignments: 99, outsideHours: 'duty_team', suspendOutsideHours: false, fallbackTeamId: 't9' });
    expect(p).toMatchObject({ firstAlertMin: 3, criticalMin: 10, reassignMin: 15, autoReassign: true, maxReassignments: 2, outsideHours: 'duty_team', suspendOutsideHours: false, fallbackTeamId: 't9' });
  });
  it('« autoReassign » seulement si explicitement vrai ; énumération inconnue refusée', () => {
    expect(parseSlaSettings({ autoReassign: 'true' }).autoReassign).toBe(false);
    expect(parseSlaSettings({ outsideHours: 'constructor' }).outsideHours).toBe('hold');
  });
  it('horaires : plages valides gardées, invalides écartées ; sans aucune plage valide, planning par défaut', () => {
    const p = parseSlaSettings({ schedule: { timezone: 'Europe/Paris', weekly: [{ day: 1, start: '09:00', end: '18:00' }, { day: 9, start: '09:00', end: '18:00' }, { day: 2, start: '18:00', end: '09:00' }, { day: 3, start: 'x', end: '10:00' }] } });
    expect(p.schedule.weekly).toEqual([{ day: 1, start: '09:00', end: '18:00' }]);
    expect(parseSlaSettings({ schedule: { weekly: [{ day: 9 }] } }).schedule.weekly).toEqual(DEFAULT_SLA_SETTINGS.schedule.weekly);
  });
  it('fuseau inconnu : défaut ; jours fermés : dates réelles, sans doublon, triées', () => {
    expect(parseSlaSettings({ schedule: { timezone: 'Mars/Olympus', weekly: [] } }).schedule.timezone).toBe('Europe/Paris');
    expect(parseSlaSettings({ schedule: { closedDates: ['2026-12-25', '2026-11-11', '2026-12-25', '2026-02-30', 'noël', 5] } }).schedule.closedDates).toEqual(['2026-11-11', '2026-12-25']);
  });
});

describe('validateSlaSettings', () => {
  it('valeurs du cahier : enregistrable', () => expect(validateSlaSettings(DEFAULT_SLA_SETTINGS)).toEqual([]));
  it('les paliers doivent être croissants', () => {
    expect(validateSlaSettings(sla({ criticalMin: 5 })).join()).toMatch(/retard critique/);
    expect(validateSlaSettings(sla({ reassignMin: 10 })).join()).toMatch(/réattribution/i);
    expect(validateSlaSettings(sla({ firstAlertMin: 0 })).join()).toMatch(/1 minute/);
    expect(validateSlaSettings(sla({ firstAlertMin: 2.5 }))).not.toEqual([]);
  });
  it('plafond de réattributions, équipe de garde', () => {
    expect(validateSlaSettings(sla({ maxReassignments: 11 }))).not.toEqual([]);
    expect(validateSlaSettings(sla({ maxReassignments: 0 }))).toEqual([]);
    expect(validateSlaSettings(sla({ outsideHours: 'duty_team', fallbackTeamId: null })).join()).toMatch(/équipe de secours/);
    expect(validateSlaSettings(sla({ outsideHours: 'duty_team', fallbackTeamId: 't1' }))).toEqual([]);
  });
  it('horaires : au moins une plage, début avant fin, pas de chevauchement, fuseau et dates réels', () => {
    const base = DEFAULT_SLA_SETTINGS.schedule;
    expect(validateSlaSettings(sla({ schedule: { ...base, weekly: [] } })).join()).toMatch(/au moins une plage/);
    expect(validateSlaSettings(sla({ schedule: { ...base, weekly: [{ day: 1, start: '19:00', end: '09:00' }] } })).join()).toMatch(/invalide/);
    expect(validateSlaSettings(sla({ schedule: { ...base, weekly: [{ day: 1, start: '09:00', end: '13:00' }, { day: 1, start: '12:00', end: '18:00' }] } })).join()).toMatch(/chevauchent/);
    expect(validateSlaSettings(sla({ schedule: { ...base, weekly: [{ day: 1, start: '09:00', end: '12:00' }, { day: 1, start: '14:00', end: '18:00' }, { day: 2, start: '09:00', end: '18:00' }] } }))).toEqual([]);
    expect(validateSlaSettings(sla({ schedule: { ...base, timezone: 'Mars/Olympus' } })).join()).toMatch(/Fuseau/);
    expect(validateSlaSettings(sla({ schedule: { ...base, closedDates: ['2026-13-40'] } })).join()).toMatch(/invalide/);
  });
});

describe('réglages propres à une campagne', () => {
  it('lecture tolérante : seulement les champs valides', () => {
    expect(parseSlaOverride({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2', firstAlertMin: 1 })).toEqual({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2' });
    expect(parseSlaOverride({ reassignMin: 0, maxReassignments: 2.5, autoReassign: 'oui' })).toEqual({});
    expect(parseSlaOverride(null)).toEqual({});
    expect(parseSlaOverride({ fallbackTeamId: '' })).toEqual({ fallbackTeamId: null });
  });
  it('surcharge uniquement la réattribution ; le reste vient des réglages généraux', () => {
    const e = effectiveSla(sla(), { autoReassign: true, reassignMin: 30, maxReassignments: 1, fallbackTeamId: 't2' });
    expect(e).toMatchObject({ autoReassign: true, reassignMin: 30, maxReassignments: 1, fallbackTeamId: 't2', firstAlertMin: 5, criticalMin: 10 });
    expect(effectiveSla(sla(), null)).toEqual(sla());
    expect(effectiveSla(sla(), {})).toEqual(sla());
  });
  it('un délai de campagne ne peut pas passer avant le retard critique général', () => {
    expect(effectiveSla(sla(), { reassignMin: 3 }).reassignMin).toBe(11);
  });
});

describe('parseRulesSettings / validateRulesSettings', () => {
  it('rien : valeurs du cahier, enregistrables', () => {
    expect(parseRulesSettings(undefined)).toEqual(DEFAULT_RULES_SETTINGS);
    expect(validateRulesSettings(DEFAULT_RULES_SETTINGS)).toEqual([]);
  });
  it('lecture : matrice de 4 délais exigée, échéances croissantes, invalides ignorées', () => {
    expect(parseRulesSettings({ nrDelaysMinutes: [60, 120, 240, 480] }).nrDelaysMinutes).toEqual([60, 120, 240, 480]);
    expect(parseRulesSettings({ nrDelaysMinutes: [60, 120] }).nrDelaysMinutes).toEqual(DEFAULT_RULES_SETTINGS.nrDelaysMinutes);
    expect(parseRulesSettings({ nrDelaysMinutes: [60, 0, 1, 1] }).nrDelaysMinutes).toEqual(DEFAULT_RULES_SETTINGS.nrDelaysMinutes);
    expect(parseRulesSettings({ followUpDays: [2, 4, 9] }).followUpDays).toEqual([2, 4, 9]);
    for (const bad of [[3, 1], [1], [0, 2], [1.5, 3], 'x']) expect(parseRulesSettings({ followUpDays: bad }).followUpDays).toEqual(DEFAULT_RULES_SETTINGS.followUpDays);
    expect(parseRulesSettings({ maxRecycleCycles: 50, recycleAfterDays: 0 })).toMatchObject({ maxRecycleCycles: 3, recycleAfterDays: 7 });
  });
  it('validation : chaque champ avec son message', () => {
    expect(validateRulesSettings(rules({ nrDelaysMinutes: [0, 60, 60, 60] })).join()).toMatch(/NR2/);
    expect(validateRulesSettings(rules({ recycleAfterDays: 0 })).join()).toMatch(/recyclage/);
    expect(validateRulesSettings(rules({ maxRecycleCycles: 11 })).join()).toMatch(/cycles/);
    expect(validateRulesSettings(rules({ followUpDays: [1] })).join()).toMatch(/entre 2 et 8/);
    expect(validateRulesSettings(rules({ followUpDays: [3, 2] })).join()).toMatch(/croissantes/);
    expect(validateRulesSettings(rules({ promisedMarginMinutes: -1 })).join()).toMatch(/promis/);
    expect(validateRulesSettings(rules({ bufferWarnMin: 120, bufferAnomalyHours: 1 })).join()).toMatch(/anomalie/);
  });
});

describe('traduction vers les moteurs', () => {
  it('réglages par défaut = règles par défaut du code (aucun écart silencieux)', () => {
    expect(callRulesFrom(DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS)).toMatchObject({ nrDelaysMinutes: DEFAULT_CALL_RULES.nrDelaysMinutes, recycleAfterDays: DEFAULT_CALL_RULES.recycleAfterDays, documentFollowUpDays: DEFAULT_CALL_RULES.documentFollowUpDays, promisedMarginMinutes: DEFAULT_CALL_RULES.promisedMarginMinutes });
    expect(documentRulesFrom(DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS)).toMatchObject({ followUpDays: DEFAULT_DOCUMENT_RULES.followUpDays, decisionRepeatDays: DEFAULT_DOCUMENT_RULES.decisionRepeatDays });
    expect(schedulerRulesFrom(DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS)).toMatchObject({ callbackEscalationMin: DEFAULT_SCHEDULER_RULES.callbackEscalationMin, slaMs: DEFAULT_SCHEDULER_RULES.slaMs, maxRecycleCycles: DEFAULT_SCHEDULER_RULES.maxRecycleCycles });
  });
  it('les réglages modifiés arrivent aux moteurs : SLA, horaires, jours fermés, cadence documentaire', () => {
    const s = sla({ firstAlertMin: 8, schedule: { timezone: 'Europe/Paris', weekly: [{ day: 6, start: '10:00', end: '16:00' }], closedDates: ['2026-12-25'] } });
    const r = rules({ followUpDays: [2, 4, 9], nrDelaysMinutes: [60, 120, 180, 240] });
    expect(schedulerRulesFrom(r, s).slaMs).toBe(8 * 60_000);
    expect(callRulesFrom(r, s).schedule).toEqual({ timezone: 'Europe/Paris', weekly: [{ day: 6, start: '10:00', end: '16:00' }], closedDates: ['2026-12-25'] });
    expect(callRulesFrom(r, s)).toMatchObject({ documentFollowUpDays: 2, nrDelaysMinutes: [60, 120, 180, 240] });
    expect(documentRulesFrom(r, s).followUpDays).toEqual([2, 4, 9]);
  });
});

describe('formatDelay', () => {
  it('jours, heures, minutes', () => {
    expect(formatDelay(1440)).toBe('1 jour');
    expect(formatDelay(2880)).toBe('2 jours');
    expect(formatDelay(180)).toBe('3 h');
    expect(formatDelay(45)).toBe('45 min');
  });
});
