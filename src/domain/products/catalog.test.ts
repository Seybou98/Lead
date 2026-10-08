import { describe, expect, it } from 'vitest';
import { categoriesOf, resolveProductCode } from './catalog';
import { checklistKey, parseChecklist, resolveChecklist, slugCode, validateChecklist } from '../documents/checklist';
import { DEFAULT_DOCUMENT_TYPES } from '../call/outcomes';

describe('categoriesOf', () => {
  const rows = [
    { category: 'PAC', name: 'Pac 1' }, { category: 'pac', name: 'Pac 2' }, { category: ' SSC ', name: 'Solaire' },
    { category: 'Poêle', name: 'P1' }, { category: '', name: 'sans' }, { name: 'sans famille' }, { category: 42 },
  ];
  it('familles distinctes, casse et accents ignorés, triées, avec leur effectif', () => {
    const c = categoriesOf(rows);
    expect(c.map((x) => x.code)).toEqual(['PAC', 'Poêle', 'SSC']);
    expect(c[0]).toMatchObject({ code: 'PAC', count: 2, samples: ['Pac 1', 'Pac 2'] });
  });
  it('catalogue vide ou sans famille : aucune', () => {
    expect(categoriesOf([])).toEqual([]);
    expect(categoriesOf([{ name: 'x' }])).toEqual([]);
  });
  it('au plus trois exemples par famille', () => {
    expect(categoriesOf(Array.from({ length: 6 }, (_, i) => ({ category: 'BS', name: `n${i}` })))[0].samples).toHaveLength(3);
  });
});

describe('resolveProductCode', () => {
  const cats = ['PAC', 'SSC', 'CESI', 'Poêle'];
  it('correspondance exacte, sans casse ni accent', () => {
    expect(resolveProductCode('pac', cats)).toBe('PAC');
    expect(resolveProductCode(' POELE ', cats)).toBe('Poêle');
  });
  it('un seul mot du texte est une famille : on la retient', () => {
    expect(resolveProductCode('PAC Air/Eau', cats)).toBe('PAC');
    expect(resolveProductCode('Pompe à chaleur PAC', cats)).toBe('PAC');
  });
  it('plusieurs familles ou aucune : le texte est conservé, jamais deviné', () => {
    expect(resolveProductCode('PAC + SSC', cats)).toBe('PAC + SSC');
    expect(resolveProductCode('Climatisation', cats)).toBe('Climatisation');
  });
  it('absent ou vide : null', () => {
    expect(resolveProductCode(null, cats)).toBeNull();
    expect(resolveProductCode('  ', cats)).toBeNull();
    expect(resolveProductCode(undefined, cats)).toBeNull();
  });
  it('catalogue indisponible : texte conservé', () => expect(resolveProductCode('PAC', [])).toBe('PAC'));
});

describe('checklists', () => {
  const pac = { items: [{ code: 'identity', label: "Pièce d'identité", mandatory: true }, { code: 'rib', label: 'RIB', mandatory: false }] };
  it('clé de famille', () => {
    expect(checklistKey('PAC')).toBe('pac');
    expect(checklistKey('Poêle (bois)')).toBe('poele-bois');
    expect(checklistKey(null)).toBe('default');
    expect(checklistKey('  ')).toBe('default');
    expect(checklistKey('default')).toBe('default');
  });
  it('lecture tolérante : entrées invalides ou doublons ignorés, null si rien de valide', () => {
    expect(parseChecklist(pac)).toHaveLength(2);
    expect(parseChecklist({ items: [{ code: 'A B', label: 'x' }, { code: 'ok', label: '  ' }, null, { code: 'ok', label: 'Ok' }, { code: 'ok', label: 'Doublon' }] })).toEqual([{ code: 'ok', label: 'Ok', mandatory: false }]);
    for (const bad of [null, undefined, {}, { items: [] }, { items: 'x' }, { items: [{ code: '../x', label: 'x' }] }]) expect(parseChecklist(bad)).toBeNull();
  });
  it('« obligatoire » seulement si explicitement vrai', () => {
    expect(parseChecklist({ items: [{ code: 'a', label: 'A', mandatory: 'true' }] })![0].mandatory).toBe(false);
  });
  it('résolution : famille, sinon par défaut éditée, sinon liste d\'origine', () => {
    const base = { pac: pac, default: { items: [{ code: 'x', label: 'X', mandatory: true }] } };
    expect(resolveChecklist('PAC Air', base).source).toBe('default');
    expect(resolveChecklist('PAC', base)).toMatchObject({ source: 'product', key: 'pac' });
    expect(resolveChecklist('SSC', base)).toMatchObject({ source: 'default', items: [{ code: 'x' }] });
    expect(resolveChecklist('SSC', {})).toMatchObject({ source: 'builtin', items: DEFAULT_DOCUMENT_TYPES });
    expect(resolveChecklist(null, { pac })).toMatchObject({ source: 'builtin' });
  });
  it('une checklist de famille illisible retombe sur la défaut', () => {
    expect(resolveChecklist('PAC', { pac: { items: [] }, default: pac })).toMatchObject({ source: 'default' });
  });
  it('la liste d\'origine n\'est jamais partagée (copie)', () => {
    const r = resolveChecklist('SSC', {});
    r.items.pop();
    expect(DEFAULT_DOCUMENT_TYPES.length).toBeGreaterThan(r.items.length);
  });
  it('code unique tiré du libellé', () => {
    expect(slugCode("Avis d'imposition", new Set())).toBe('avis-d-imposition');
    expect(slugCode('RIB', new Set(['rib']))).toBe('rib-2');
    expect(slugCode('???', new Set())).toBe('piece');
  });
  it('validation : vide, nom manquant ou trop long, doublon, trop de pièces', () => {
    const it = (label: string, mandatory = false) => ({ code: label, label, mandatory });
    expect(validateChecklist([it('A'), it('B')])).toEqual([]);
    expect(validateChecklist([])).toHaveLength(1);
    expect(validateChecklist([it(' ')])).toContain('Chaque pièce doit avoir un nom.');
    expect(validateChecklist([it('x'.repeat(61))]).join()).toMatch(/60 caractères/);
    expect(validateChecklist([it('RIB'), it('rib')]).join()).toMatch(/en double/);
    expect(validateChecklist(Array.from({ length: 21 }, (_, i) => it(`P${i}`))).join()).toMatch(/20 pièces/);
  });
});
