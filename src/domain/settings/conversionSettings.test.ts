import { describe, expect, it } from 'vitest';
import { coerceConversionInput, DEFAULT_CONVERSION_SETTINGS, parseConversionSettings, validateConversionSettings } from './settings';
import { planConversionSave } from '../admin/plans';
import { describeChanges, moduleOf, versionsOf } from './versions';

describe('lecture des verrous de conversion', () => {
  it('rien d’enregistré : les valeurs du cahier', () => {
    expect(parseConversionSettings(undefined)).toEqual({ maxDiscountPct: 5, requireEligibility: true, requireRge: true, requireConsent: true });
    expect(parseConversionSettings(null)).toEqual(DEFAULT_CONVERSION_SETTINGS);
  });
  it('valeurs valides reprises telles quelles', () => {
    expect(parseConversionSettings({ maxDiscountPct: 12.5, requireEligibility: false, requireRge: false, requireConsent: false })).toEqual({ maxDiscountPct: 12.5, requireEligibility: false, requireRge: false, requireConsent: false });
  });
  it('valeur hors bornes ou de mauvais type : repli sur le défaut, jamais une valeur dangereuse', () => {
    expect(parseConversionSettings({ maxDiscountPct: -3, requireRge: 'oui' })).toEqual(DEFAULT_CONVERSION_SETTINGS);
    expect(parseConversionSettings({ maxDiscountPct: 500 }).maxDiscountPct).toBe(5);
    expect(parseConversionSettings({ maxDiscountPct: Number.NaN }).maxDiscountPct).toBe(5);
    expect(parseConversionSettings('texte')).toEqual(DEFAULT_CONVERSION_SETTINGS);
  });
});

describe('validation et saisie', () => {
  it('remise entre 0 et 100 %', () => {
    expect(validateConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS, maxDiscountPct: 0 })).toEqual([]);
    expect(validateConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS, maxDiscountPct: 100 })).toEqual([]);
    expect(validateConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS, maxDiscountPct: -1 })).toHaveLength(1);
    expect(validateConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS, maxDiscountPct: 101 })).toHaveLength(1);
    expect(validateConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS, maxDiscountPct: Number.NaN })).toHaveLength(1);
  });
  it('la saisie n’est jamais corrigée en silence : une erreur de frappe se voit', () => {
    expect(coerceConversionInput({ maxDiscountPct: 'abc' }).maxDiscountPct).toBeNaN();
    expect(coerceConversionInput({ maxDiscountPct: '7,5' }).maxDiscountPct).toBeNaN();
    expect(coerceConversionInput({ maxDiscountPct: '8' }).maxDiscountPct).toBe(8);
    expect(coerceConversionInput({}).requireRge).toBe(false);
  });
});

describe('enregistrement (plan)', () => {
  const plan = (input: unknown, before: Record<string, unknown> | null = null) => planConversionSave({ input, before, actorId: 'adm', nowMs: 1000 });
  const valid = { maxDiscountPct: 8, requireEligibility: true, requireRge: false, requireConsent: true };
  it('création puis modification : action d’audit, auteur, date', () => {
    const c = plan(valid);
    expect(c.doc).toMatchObject({ ...valid, updatedBy: 'adm' });
    expect(c.audit).toMatchObject({ action: 'settings.conversion.create', entityType: 'settings', entityId: 'conversion', before: null });
    expect(plan(valid, { maxDiscountPct: 5 }).audit.action).toBe('settings.conversion.update');
  });
  it('le motif de l’enregistrement est conservé', () => {
    expect(plan({ ...valid, reason: 'Politique commerciale 2026' }).audit.reason).toBe('Politique commerciale 2026');
  });
  it('valeur invalide refusée avec un message', () => {
    expect(() => plan({ ...valid, maxDiscountPct: 150 })).toThrow(/entre 0 et 100/);
    expect(() => plan({ ...valid, maxDiscountPct: 'x' })).toThrow();
  });
});

describe('versions et retour arrière', () => {
  const row = (id: string, atMs: number, before: unknown, after: unknown) => ({ id, atMs, actorId: 'adm', action: 'settings.conversion.update', entityType: 'settings', entityId: 'conversion', before, after, reason: null });
  it('reconnu comme module à part', () => {
    expect(moduleOf({ entityType: 'settings', entityId: 'conversion', action: 'x' })).toBe('conversion');
    expect(moduleOf({ entityType: 'settings', entityId: 'rules', action: 'x' })).toBe('rules');
  });
  it('décrit ce qui a changé, en phrases', () => {
    const lines = describeChanges('conversion', { maxDiscountPct: 5, requireEligibility: true, requireRge: true, requireConsent: true }, { maxDiscountPct: 8, requireEligibility: false, requireRge: true, requireConsent: true });
    expect(lines).toEqual(['Remise maximale sans validation : 5 % → 8 %', 'Éligibilité aux aides : exigée (sinon validation du manager) → non exigée']);
  });
  it('première version : résumé du contenu', () => {
    expect(describeChanges('conversion', null, { maxDiscountPct: 5, requireEligibility: true, requireRge: true, requireConsent: true })[0]).toBe('Remise maximale sans validation : 5 %');
  });
  it('historique numéroté, valeur à rétablir sans champs d’enregistrement', () => {
    const v = versionsOf([row('a', 1, null, { maxDiscountPct: 5, updatedAt: 1, updatedBy: 'x' }), row('b', 2, { maxDiscountPct: 5 }, { maxDiscountPct: 9, updatedAt: 2, updatedBy: 'x' })] as never, 'conversion');
    expect(v.map((x) => x.number)).toEqual([2, 1]);
    expect(v[1].payload).toEqual({ maxDiscountPct: 5 });
  });
});
