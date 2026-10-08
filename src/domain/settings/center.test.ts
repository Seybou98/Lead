import { describe, expect, it } from 'vitest';
import { buildConfigAlerts, productCoverage, type CoverageInput } from './center';
import { DEFAULT_SLA_SETTINGS } from './settings';

const list = (label = 'Pièce') => ({ items: [{ code: 'identity', label, mandatory: true }] });
const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  categories: ['PAC', 'SSC', 'CESI'],
  checklists: {},
  teams: [{ id: 't1', name: 'Équipe PAC', active: true, productCodes: ['PAC'] }],
  profiles: [{ uid: 'u1', productCodes: ['PAC'] }, { uid: 'u2', productCodes: ['*'] }],
  campaigns: [{ id: 'c1', name: 'PAC IDF', status: 'active', productCode: 'PAC' }],
  ...over,
});
const ctx = { sla: DEFAULT_SLA_SETTINGS, settingsSaved: { sla: true, rules: true } };
const ids = (a: { id: string }[]) => a.map((x) => x.id);

describe('productCoverage', () => {
  it('checklist propre, par défaut ou d\'origine ; équipes, télépros et campagnes actives par produit', () => {
    const c = productCoverage(base({ checklists: { pac: list(), default: list('D') } }));
    expect(c.find((x) => x.product === 'PAC')).toMatchObject({ checklist: 'own', teams: ['Équipe PAC'], telepros: 2, activeCampaigns: ['PAC IDF'] });
    expect(c.find((x) => x.product === 'SSC')).toMatchObject({ checklist: 'default', teams: [], telepros: 1, activeCampaigns: [] });
    expect(productCoverage(base()).every((x) => x.checklist === 'builtin')).toBe(true);
  });
  it('« * » couvre tous les produits ; casse et accents ignorés ; équipe inactive ou campagne non active ignorées', () => {
    const c = productCoverage(base({ profiles: [{ uid: 'a', productCodes: ['pac'] }], teams: [{ id: 't', name: 'X', active: false, productCodes: ['*'] }], campaigns: [{ id: 'c', name: 'Brouillon', status: 'draft', productCode: 'PAC' }] }));
    expect(c.find((x) => x.product === 'PAC')).toMatchObject({ telepros: 1, teams: [], activeCampaigns: [] });
  });
});

describe('buildConfigAlerts', () => {
  it('configuration saine : aucune alerte', () => {
    const input = base({ checklists: { default: list() }, teams: [{ id: 't', name: 'T', active: true, productCodes: ['*'] }] });
    expect(buildConfigAlerts(input, ctx)).toEqual([]);
  });
  it('produit d\'une campagne active sans checklist : bloquant ; sans campagne : avertissement', () => {
    const a = buildConfigAlerts(base(), ctx);
    expect(a.find((x) => x.id === 'checklist:PAC')).toMatchObject({ level: 'blocking', href: '/parametres/documents?famille=PAC' });
    expect(a.find((x) => x.id === 'checklist:SSC')).toMatchObject({ level: 'warning' });
  });
  it('une checklist par défaut suffit à couvrir les produits', () => {
    expect(ids(buildConfigAlerts(base({ checklists: { default: list() } }), ctx)).some((i) => i.startsWith('checklist:'))).toBe(false);
  });
  it('campagne active sans télépro éligible : bloquant ; sans équipe : avertissement', () => {
    const a = buildConfigAlerts(base({ checklists: { default: list() }, profiles: [{ uid: 'x', productCodes: ['SSC'] }], teams: [] }), ctx);
    expect(a.find((x) => x.id === 'telepros:PAC')).toMatchObject({ level: 'blocking' });
    expect(a.find((x) => x.id === 'team:PAC')).toMatchObject({ level: 'warning' });
  });
  it('campagne sur un produit hors catalogue', () => {
    const a = buildConfigAlerts(base({ checklists: { default: list() }, campaigns: [{ id: 'c9', name: 'Vieille', status: 'active', productCode: 'Pompe inconnue' }] }), ctx);
    expect(a.find((x) => x.id === 'campaign-product:c9')).toMatchObject({ level: 'warning', href: '/campagnes/c9' });
  });
  it('paramètres jamais enregistrés, réattribution sans équipe de secours', () => {
    const a = buildConfigAlerts(base({ checklists: { default: list() }, teams: [{ id: 't', name: 'T', active: true, productCodes: ['*'] }] }), { sla: { ...DEFAULT_SLA_SETTINGS, autoReassign: true }, settingsSaved: { sla: false, rules: false } });
    expect(ids(a).sort()).toEqual(['fallback-missing', 'rules-unsaved', 'sla-unsaved']);
  });
  it('bloquantes d\'abord, puis ordre alphabétique', () => {
    const a = buildConfigAlerts(base(), ctx);
    const firstWarning = a.findIndex((x) => x.level === 'warning');
    expect(a.slice(0, firstWarning).every((x) => x.level === 'blocking')).toBe(true);
    expect(a.slice(firstWarning).every((x) => x.level === 'warning')).toBe(true);
  });
  it('catalogue vide : aucune alerte produit', () => {
    expect(buildConfigAlerts(base({ categories: [], campaigns: [] }), ctx)).toEqual([]);
  });
});
