import { describe, expect, it } from 'vitest';
import { AdminRuleError, planChecklistSave, planRulesSave, planSlaOverrideSave, planSlaSave } from './plans';
import { versionsOf, type AuditRow } from '../settings/versions';
import { DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS } from '../settings/settings';

const NOW = Date.UTC(2026, 9, 8, 10, 0);
const refusal = (fn: () => unknown): AdminRuleError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AdminRuleError) return e;
    throw e;
  }
  throw new Error('un refus était attendu');
};
const sla = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_SLA_SETTINGS, ...over });

describe('planSlaSave', () => {
  it('enregistre, trace l\'auteur et l\'ancienne valeur', () => {
    const before = { firstAlertMin: 5 };
    const p = planSlaSave({ input: sla({ firstAlertMin: 4, reason: 'Test' }), before, actorId: 'adm', nowMs: NOW });
    expect(p.doc).toMatchObject({ firstAlertMin: 4, criticalMin: 10, updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.sla.update', entityType: 'settings', entityId: 'sla', before, reason: 'Test' });
    expect(planSlaSave({ input: sla(), before: null, actorId: 'adm', nowMs: NOW }).audit.action).toBe('settings.sla.create');
  });
  it('saisie texte d\'un formulaire acceptée (« 5 » → 5) ; texte non numérique refusé', () => {
    expect(planSlaSave({ input: sla({ firstAlertMin: '6' }), before: null, actorId: 'a', nowMs: NOW }).doc.firstAlertMin).toBe(6);
    expect(refusal(() => planSlaSave({ input: sla({ firstAlertMin: 'abc' }), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
    expect(refusal(() => planSlaSave({ input: sla({ criticalMin: '' }), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
  it('jamais corrigé en silence : paliers non croissants, plage inversée, fuseau inconnu, plages qui se chevauchent', () => {
    const bad: Record<string, unknown>[] = [
      { criticalMin: 3 },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, weekly: [{ day: 1, start: '19:00', end: '09:00' }] } },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, timezone: 'Mars/Olympus' } },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, weekly: [{ day: 1, start: '09:00', end: '13:00' }, { day: 1, start: '12:00', end: '18:00' }] } },
      { outsideHours: 'bogus' },
      { outsideHours: 'duty_team', fallbackTeamId: null },
    ];
    for (const b of bad) expect(refusal(() => planSlaSave({ input: sla(b), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
  it('jours fermés dédoublonnés et triés', () => {
    const p = planSlaSave({ input: sla({ schedule: { ...DEFAULT_SLA_SETTINGS.schedule, closedDates: ['2026-12-25', '2026-11-11', '2026-12-25'] } }), before: null, actorId: 'a', nowMs: NOW });
    expect((p.doc.schedule as { closedDates: string[] }).closedDates).toEqual(['2026-11-11', '2026-12-25']);
  });
});

describe('planSlaOverrideSave', () => {
  const run = (input: unknown, general = DEFAULT_SLA_SETTINGS) => planSlaOverrideSave({ campaignId: 'c1', input, general, before: null, actorId: 'adm', nowMs: NOW });
  it('enregistre seulement la réattribution de la campagne', () => {
    const p = run({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2', firstAlertMin: 1 });
    expect(p.doc).toMatchObject({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2', campaignId: 'c1', updatedBy: 'adm' });
    expect('firstAlertMin' in p.doc).toBe(false);
    expect(p.audit).toMatchObject({ action: 'settings.sla.campaign.create', entityId: 'sla_c1' });
  });
  it('valeurs hors bornes refusées avec un message, pas ignorées', () => {
    expect(refusal(() => run({ reassignMin: 5000 })).message).toMatch(/960/);
    expect(refusal(() => run({ maxReassignments: 30 })).message).toMatch(/0 à 10/);
  });
  it('équipe de garde exigée par les réglages généraux : une campagne ne peut pas retirer l\'équipe de secours', () => {
    const general = { ...DEFAULT_SLA_SETTINGS, outsideHours: 'duty_team' as const, fallbackTeamId: 't1' };
    expect(refusal(() => run({ fallbackTeamId: null }, general)).code).toBe('invalid-argument');
  });
});

describe('planRulesSave', () => {
  const rules = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_RULES_SETTINGS, ...over });
  it('enregistre la matrice NR et les délais', () => {
    const p = planRulesSave({ input: rules({ nrDelaysMinutes: [60, 120, 180, 240], followUpDays: [2, 4, 9] }), before: null, actorId: 'adm', nowMs: NOW });
    expect(p.doc).toMatchObject({ nrDelaysMinutes: [60, 120, 180, 240], followUpDays: [2, 4, 9], updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.rules.create', entityId: 'rules' });
  });
  it('refus : délai NR invalide, cycles, échéances décroissantes, matrice incomplète', () => {
    const bad: Record<string, unknown>[] = [{ nrDelaysMinutes: [0, 1, 1, 1] }, { nrDelaysMinutes: [60, 60] }, { maxRecycleCycles: 0 }, { followUpDays: [5, 3] }, { followUpDays: [1] }, { recycleAfterDays: 'x' }];
    for (const b of bad) expect(refusal(() => planRulesSave({ input: rules(b), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
});

describe('retour arrière : une version rétablie repasse par la validation et recrée la même valeur', () => {
  // Le journal d'audit stocke les documents après un aller-retour JSON (dates en texte) : on rejoue exactement cela.
  const audited = (a: { audit: { before: unknown; after: unknown; action: string; entityType: string; entityId: string; reason: string | null } }, id: string, atMs: number): AuditRow => ({ id, atMs, actorId: 'adm', ...a.audit, before: JSON.parse(JSON.stringify(a.audit.before)), after: JSON.parse(JSON.stringify(a.audit.after)) } as AuditRow);

  it('SLA et horaires', () => {
    const v1 = planSlaSave({ input: sla({ firstAlertMin: 5 }), before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planSlaSave({ input: sla({ firstAlertMin: 9, criticalMin: 20, reassignMin: 40 }), before: v1.doc, actorId: 'adm', nowMs: NOW + 1000 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'sla');
    expect(versions[0]).toMatchObject({ number: 2, current: true });
    const back = planSlaSave({ input: { ...versions[1].payload, reason: 'Retour à la version v1' }, before: v2.doc, actorId: 'adm', nowMs: NOW + 2000 });
    expect(back.doc).toMatchObject({ firstAlertMin: 5, criticalMin: 10, reassignMin: 15 });
    expect(back.audit.reason).toBe('Retour à la version v1');
    expect(back.audit.action).toBe('settings.sla.update'); // une nouvelle version, pas une suppression de l'ancienne
  });
  it('cycles NR', () => {
    const v1 = planRulesSave({ input: { ...DEFAULT_RULES_SETTINGS, recycleAfterDays: 7 }, before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planRulesSave({ input: { ...DEFAULT_RULES_SETTINGS, recycleAfterDays: 12, followUpDays: [2, 4, 9] }, before: v1.doc, actorId: 'adm', nowMs: NOW + 1 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'rules');
    const back = planRulesSave({ input: versions[1].payload, before: v2.doc, actorId: 'adm', nowMs: NOW + 2 });
    expect(back.doc).toMatchObject({ recycleAfterDays: 7, followUpDays: [1, 3, 5, 7, 14] });
  });
  it('checklist', () => {
    const v1 = planChecklistSave({ input: { productCode: 'PAC', items: [{ label: 'Identité', mandatory: true }] }, before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planChecklistSave({ input: { productCode: 'PAC', items: [{ code: 'identite', label: 'Identité', mandatory: true }, { label: 'RIB', mandatory: false }] }, before: v1.doc, actorId: 'adm', nowMs: NOW + 1 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'checklist', 'pac');
    const back = planChecklistSave({ input: versions[1].payload, before: v2.doc, actorId: 'adm', nowMs: NOW + 2 });
    expect((back.doc.items as { label: string }[]).map((i) => i.label)).toEqual(['Identité']);
  });
});
