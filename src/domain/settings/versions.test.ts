import { describe, expect, it } from 'vitest';
import { describeChanges, moduleOf, versionsOf, type AuditRow } from './versions';
import { DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS } from './settings';

const row = (id: string, atMs: number, over: Partial<AuditRow> = {}): AuditRow => ({ id, atMs, actorId: 'adm', action: 'settings.sla.update', entityType: 'settings', entityId: 'sla', before: null, after: null, reason: null, ...over });

describe('moduleOf', () => {
  it('reconnaît les modules versionnés', () => {
    expect(moduleOf({ entityType: 'settings', entityId: 'sla', action: '' })).toBe('sla');
    expect(moduleOf({ entityType: 'settings', entityId: 'rules', action: '' })).toBe('rules');
    expect(moduleOf({ entityType: 'checklist', entityId: 'pac', action: '' })).toBe('checklist');
    expect(moduleOf({ entityType: 'settings', entityId: 'sla_c1', action: '' })).toBeNull(); // règle propre à une campagne : pas ici
    expect(moduleOf({ entityType: 'profile', entityId: 'u1', action: '' })).toBeNull();
  });
});

describe('describeChanges — SLA et horaires', () => {
  const s = DEFAULT_SLA_SETTINGS;
  it('première version : résumé du contenu', () => {
    const c = describeChanges('sla', null, s);
    expect(c.some((l) => l.startsWith('Première alerte : 5 min'))).toBe(true);
    expect(c.some((l) => l.startsWith('Horaires : Lun.–Ven. : 9h00–19h00'))).toBe(true);
  });
  it('seulement ce qui change, ancienne → nouvelle valeur', () => {
    expect(describeChanges('sla', s, { ...s, firstAlertMin: 8, autoReassign: true })).toEqual(['Première alerte : 5 min → 8 min', 'Réattribution automatique : Désactivée → Activée']);
  });
  it('horaires, jours fermés, comportement hors horaires', () => {
    const c = describeChanges('sla', s, { ...s, outsideHours: 'duty_team', schedule: { ...s.schedule, weekly: [{ day: 6, start: '10:00', end: '16:00' }], closedDates: ['2026-12-25'] } });
    expect(c).toContain("Hors horaires : mettre en attente jusqu'à l'ouverture → affecter à l'équipe de garde");
    expect(c).toContain('Horaires : Sam. : 10h00–16h00');
    expect(c).toContain('Jours fermés : 2026-12-25');
  });
  it('aucune différence : le dit', () => expect(describeChanges('sla', s, { ...s })).toEqual(['Aucun changement de valeur']));
});

describe('describeChanges — cycles NR et documents', () => {
  const r = DEFAULT_RULES_SETTINGS;
  it('matrice NR, cadence documentaire, valeurs simples', () => {
    const c = describeChanges('rules', r, { ...r, nrDelaysMinutes: [60, 1440, 1440, 2880], followUpDays: [2, 4, 9], recycleAfterDays: 10 });
    expect(c).toEqual(['Délai après NR1 : 3 h → 1 h', 'Délai de recyclage : 7 j → 10 j', 'Relances documentaires : J+1, J+3, J+5, J+7, J+14 → J+2, J+4, J+9']);
  });
});

describe('describeChanges — checklists', () => {
  const item = (code: string, label: string, mandatory = false) => ({ code, label, mandatory });
  it('pièces ajoutées, retirées, renommées, devenues obligatoires', () => {
    const before = { items: [item('a', 'Identité', true), item('b', 'RIB'), item('c', 'Taxe')] };
    const after = { items: [item('a', 'Pièce d\'identité', true), item('b', 'RIB', true), item('d', 'Avis', true)] };
    expect(describeChanges('checklist', before, after)).toEqual(["Pièce renommée : Identité → Pièce d'identité", 'RIB : devient obligatoire', 'Pièce ajoutée : Avis (obligatoire)', 'Pièce retirée : Taxe']);
  });
  it('simple réordonnancement, ou création', () => {
    expect(describeChanges('checklist', { items: [item('a', 'A'), item('b', 'B')] }, { items: [item('b', 'B'), item('a', 'A')] })).toEqual(['Ordre des pièces modifié']);
    expect(describeChanges('checklist', null, { items: [item('a', 'A', true)] })).toEqual(['Pièce ajoutée : A (obligatoire)']);
  });
});

describe('versionsOf', () => {
  const rows = [
    row('3', 3000, { before: { firstAlertMin: 8 }, after: { firstAlertMin: 5, updatedAt: 'x', updatedBy: 'adm' }, reason: 'Retour' }),
    row('1', 1000, { action: 'settings.sla.create', before: null, after: { ...DEFAULT_SLA_SETTINGS } }),
    row('2', 2000, { before: { ...DEFAULT_SLA_SETTINGS }, after: { ...DEFAULT_SLA_SETTINGS, firstAlertMin: 8 } }),
    row('x', 2500, { action: 'settings.rules.update', entityId: 'rules', before: {}, after: {} }),
    row('p', 2600, { action: 'profile.update', entityType: 'profile', entityId: 'u1' }),
  ];
  it('numérote chronologiquement, plus récent d\'abord, une seule version en vigueur', () => {
    const v = versionsOf(rows, 'sla');
    expect(v.map((x) => [x.number, x.id, x.current])).toEqual([[3, '3', true], [2, '2', false], [1, '1', false]]);
    expect(v.every((x) => x.module === 'sla')).toBe(true);
  });
  it('valeur de retour sans les champs propres à l\'enregistrement', () => {
    const v = versionsOf(rows, 'sla');
    expect(v[0].payload).toEqual({ firstAlertMin: 5 });
    expect(v[1].payload).toMatchObject({ firstAlertMin: 8, criticalMin: 10 });
    expect('updatedAt' in (v[0].payload as object)).toBe(false);
  });
  it('checklists : une famille à la fois ; une suppression n\'est pas restaurable et rien n\'est « en vigueur » après elle', () => {
    const c = (id: string, at: number, key: string, action: string, after: unknown, before: unknown = null) => row(id, at, { entityType: 'checklist', entityId: key, action, after, before });
    const list = [c('1', 1, 'pac', 'checklist.create', { productCode: 'PAC', items: [{ code: 'a', label: 'A', mandatory: true }] }), c('2', 2, 'ssc', 'checklist.create', { productCode: 'SSC', items: [] }), c('3', 3, 'pac', 'checklist.delete', null, { items: [] })];
    const pac = versionsOf(list, 'checklist', 'pac');
    expect(pac.map((x) => [x.number, x.deleted, x.current, x.payload === null])).toEqual([[2, true, false, true], [1, false, false, false]]);
    expect(pac[0].changes[0]).toMatch(/supprimée/);
    expect(pac[1].payload).toEqual({ productCode: 'PAC', items: [{ code: 'a', label: 'A', mandatory: true }] });
    expect(versionsOf(list, 'checklist', 'ssc')).toHaveLength(1);
    expect(versionsOf(list, 'checklist')).toHaveLength(3);
  });
  it('aucun enregistrement : liste vide', () => expect(versionsOf([], 'rules')).toEqual([]));
});
