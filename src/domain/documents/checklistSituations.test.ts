import { describe, expect, it } from 'vitest';
import { applicableItems, defaultSituations, parseChecklist, resolveChecklist, SITUATIONS, validateChecklist } from './checklist';
import { planChecklistSave } from '../admin/plans';
import { describeChanges, versionsOf, type AuditRow } from '../settings/versions';

const items = [
  { code: 'identity', label: 'Pièce d’identité', mandatory: true },
  { code: 'mpr-notice', label: 'Avis MaPrimeRénov’', mandatory: true, when: ['mpr'] },
  { code: 'financing', label: 'Dossier de financement', mandatory: false, when: ['financing', 'cee'] },
];

describe('checklist conditionnelle', () => {
  it('sans situation : seulement les pièces sans condition', () => {
    expect(applicableItems(items, []).map((i) => i.code)).toEqual(['identity']);
  });
  it('une situation cochée ajoute ses pièces ; l’une des conditions suffit', () => {
    expect(applicableItems(items, ['mpr']).map((i) => i.code)).toEqual(['identity', 'mpr-notice']);
    expect(applicableItems(items, ['cee']).map((i) => i.code)).toEqual(['identity', 'financing']);
    expect(applicableItems(items, ['mpr', 'financing', 'landlord']).map((i) => i.code)).toEqual(['identity', 'mpr-notice', 'financing']);
  });
  it('lecture : conditions valides conservées, inconnues retirées, liste vide = toujours', () => {
    const list = parseChecklist({ items: [{ code: 'a', label: 'A', mandatory: true, when: ['mpr', 'zzz'] }, { code: 'b', label: 'B', mandatory: false, when: [] }, { code: 'c', label: 'C', mandatory: false }] })!;
    expect(list[0].when).toEqual(['mpr']);
    expect('when' in list[1]).toBe(false);
    expect('when' in list[2]).toBe(false);
  });
  it('la checklist résolue d’un lead garde ses conditions', () => {
    const r = resolveChecklist('pac', { pac: { items } });
    expect(r.items[1].when).toEqual(['mpr']);
  });
  it('situations proposées d’après les aides du produit', () => {
    expect(defaultSituations(['mpr', 'cee', 'other'])).toEqual(['mpr', 'cee']);
    expect(defaultSituations([])).toEqual([]);
    expect(SITUATIONS).toHaveLength(5);
  });
  it('validation : situation inconnue refusée', () => {
    expect(validateChecklist([{ code: 'a', label: 'A', mandatory: true, when: ['zzz'] }]).join(' ')).toContain('situation inconnue');
    expect(validateChecklist(items)).toEqual([]);
  });
});

describe('enregistrement et versions', () => {
  const NOW = Date.UTC(2026, 9, 22, 10, 0);
  it('l’enregistrement conserve les conditions et écarte les pièces sans condition vide', () => {
    const p = planChecklistSave({ input: { productCode: 'PAC', items: [{ label: 'Identité', mandatory: true, when: [] }, { label: 'Avis MPR', mandatory: true, when: ['mpr'] }] }, before: null, actorId: 'adm', nowMs: NOW });
    const saved = (p.doc.items as { when?: string[] }[]);
    expect('when' in saved[0]).toBe(false);
    expect(saved[1].when).toEqual(['mpr']);
  });
  it('situation inconnue refusée à l’enregistrement', () => {
    expect(() => planChecklistSave({ input: { productCode: 'PAC', items: [{ label: 'X', mandatory: true, when: ['zzz'] }] }, before: null, actorId: 'adm', nowMs: NOW })).toThrow();
  });
  it('versions : la condition apparaît dans les changements et dans le retour arrière', () => {
    const before = { items: [{ code: 'avis', label: 'Avis', mandatory: true }] };
    const after = { items: [{ code: 'avis', label: 'Avis', mandatory: true, when: ['mpr', 'cee'] }] };
    expect(describeChanges('checklist', before, after)).toContain('Avis : demandée seulement si MaPrimeRénov’ ou Prime CEE');
    expect(describeChanges('checklist', after, before)).toContain('Avis : demandée dans tous les cas');
    const rows: AuditRow[] = [{ id: '1', atMs: 1, actorId: 'a', action: 'checklist.update', entityType: 'checklist', entityId: 'pac', before: null, after: { productCode: 'PAC', ...after }, reason: null }];
    expect(versionsOf(rows, 'checklist')[0].payload).toMatchObject({ items: [{ code: 'avis', when: ['mpr', 'cee'] }] });
  });
});
