import { describe, expect, it } from 'vitest';
import { campaignZoneConflicts, coerceProductsInput, defaultRule, parseProductRules, ruleFor, toStoredProducts, validateProductRules, zoneStatus } from './rules';
import { planProductsSave, AdminRuleError } from '../admin/plans';
import { planDraftPublish, planDraftSave } from '../admin/drafts';
import { draftChanges, impactOf, parseDraft, simulateDraft } from '../settings/publication';
import { describeChanges } from '../settings/versions';
import type { LeadListItem } from '../leads/leadList';

const NOW = Date.UTC(2026, 9, 22, 10, 0);
const rule = (over: Partial<ReturnType<typeof defaultRule>> = {}) => ({ ...defaultRule('PAC AIR/AIR'), ...over });
const lead = (id: string, postalCode: string, productCode = 'PAC AIR/AIR'): LeadListItem => ({
  id, fullName: id, phone: null, email: null, city: '', postalCode, campaignId: null, productCode, status: 'interested', temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'u1',
  receivedAtMs: 1, slaStartedAtMs: null, slaStoppedAtMs: 2, nextAction: null, documentsState: 'none', duplicate: false, excluded: false,
});
const refusal = (fn: () => unknown): AdminRuleError => { try { fn(); } catch (e) { return e as AdminRuleError; } throw new Error('pas de refus'); };

describe('règles produit : lecture et validation', () => {
  it('sans enregistrement : aucune règle, donc aucune restriction', () => {
    expect(parseProductRules(undefined)).toEqual([]);
    expect(ruleFor([], 'PAC')).toBeNull();
  });
  it('lecture tolérante : départements valides, aides connues, critères nettoyés, doublons de famille ignorés', () => {
    const [r, ...rest] = parseProductRules({ products: [{ code: ' PAC ', zones: ['75', ' 2a ', 'xx', '75'], aids: ['mpr', 'zzz', 'cee'], criteria: ['  Propriétaire  occupant ', ''], note: 'n' }, { code: 'pac' }, { nope: 1 }] });
    expect(r).toMatchObject({ code: 'PAC', zones: ['2A', '75'], aids: ['mpr', 'cee'], criteria: ['Propriétaire occupant'], active: true });
    expect(rest).toEqual([]);
  });
  it('famille retrouvée sans tenir compte de la casse, des accents ni des séparateurs', () => {
    const rules = parseProductRules({ products: [{ code: 'PAC AIR/AIR', zones: ['75'] }] });
    expect(ruleFor(rules, 'pac air air')?.zones).toEqual(['75']);
    expect(ruleFor(rules, 'SSC')).toBeNull();
    expect(ruleFor(rules, null)).toBeNull();
  });
  it('validation : département invalide, doublon, trop de critères, produit en double', () => {
    expect(validateProductRules([rule({ zones: ['75', 'abc'] })]).join(' ')).toContain('département invalide');
    expect(validateProductRules([rule({ zones: ['75', '75'] })]).join(' ')).toContain('en double');
    expect(validateProductRules([rule({ criteria: Array.from({ length: 11 }, (_, i) => `c${i}`) })]).join(' ')).toContain('10 critères au plus');
    expect(validateProductRules([rule(), rule({ code: 'pac air/air' })]).join(' ')).toContain('produit en double');
    expect(validateProductRules([rule({ zones: ['75', '2A', '974'], aids: ['mpr'], criteria: ['Propriétaire'] })])).toEqual([]);
  });
  it('enregistrement : saisie contrôlée, document stocké, audit', () => {
    const p = planProductsSave({ input: { products: [rule({ zones: ['75'], aids: ['cee'] })] }, before: null, actorId: 'adm', nowMs: NOW });
    expect(p.doc).toMatchObject({ products: [{ code: 'PAC AIR/AIR', zones: ['75'], aids: ['cee'] }], updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.products.create', entityId: 'products' });
    expect(refusal(() => planProductsSave({ input: { products: [rule({ zones: ['xx'] })] }, before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
    expect(coerceProductsInput({ products: [{ code: ' X ', zones: [' 75 '] }] })[0]).toMatchObject({ code: 'X', zones: ['75'] });
    expect(toStoredProducts([rule()]).products).toHaveLength(1);
  });
});

describe('zone du lead', () => {
  const r = rule({ zones: ['75', '92'] });
  it('couverte, hors zone, inconnue, ou sans restriction', () => {
    expect(zoneStatus(r, '75011')).toBe('covered');
    expect(zoneStatus(r, '69003')).toBe('outside');
    expect(zoneStatus(r, '')).toBe('unknown');
    expect(zoneStatus(r, '7501')).toBe('unknown');
    expect(zoneStatus(rule(), '69003')).toBe('all');
    expect(zoneStatus(null, '69003')).toBe('all');
  });
  it('campagne dont des départements sortent du périmètre (seuls les départements comptent)', () => {
    expect(campaignZoneConflicts(r, ['75', '69', 'IDF', '2a'])).toEqual(['69', '2A']);
    expect(campaignZoneConflicts(rule(), ['69'])).toEqual([]);
  });
});

describe('cycle de publication des produits', () => {
  const published = { products: [rule({ zones: ['75'] })], updatedAt: new Date(NOW - 1000) };
  const draftOf = (rules: ReturnType<typeof rule>[]) => planDraftSave({ module: 'products', input: { products: rules }, before: published, actorId: 'adm', nowMs: NOW }).doc;
  it('brouillon puis publication : même document et même audit qu’un enregistrement ordinaire', () => {
    const d = draftOf([rule({ zones: ['75', '92'], aids: ['mpr'] })]);
    expect(d).toMatchObject({ module: 'products' });
    const p = planDraftPublish({ module: 'products', draft: d, before: published, actorId: 'adm', nowMs: NOW + 1, reason: 'Ajout du 92' });
    expect(p.id).toBe('products');
    expect(p.audit).toMatchObject({ action: 'settings.products.update', reason: 'Ajout du 92' });
  });
  it('différences lisibles', () => {
    const d = parseDraft(draftOf([rule({ zones: ['75', '92'], aids: ['mpr'], active: false })]))!;
    const c = draftChanges('products', published, d);
    expect(c).toContain('PAC AIR/AIR : suspendu');
    expect(c).toContain('PAC AIR/AIR : périmètre 75 → 75, 92');
    expect(c).toContain('PAC AIR/AIR : aides aucune → MaPrimeRénov’');
    expect(describeChanges('products', { products: [rule()] }, { products: [] })).toContain('Produit retiré de la configuration : PAC AIR/AIR');
  });
  it('simulation : campagne hors périmètre, produit suspendu vendu par une campagne active, aucune aide', () => {
    const s = simulateDraft('products', { products: [rule({ zones: ['75'], active: false })] }, { campaigns: [{ name: 'Campagne Lyon', productCode: 'PAC AIR/AIR', zones: ['69'], status: 'active' }] });
    const text = s.checks.map((c) => c.text).join(' | ');
    expect(text).toContain('suspendu alors que 1 campagne active');
    expect(text).toContain('départements 69 hors du périmètre');
    expect(s.examples[0]).toContain('suspendu');
    expect(simulateDraft('products', { products: [] }).examples[0]).toContain('Aucune restriction');
  });
  it('impact : leads actifs hors périmètre avant et après, produit suspendu, aides modifiées', () => {
    const d = parseDraft(draftOf([rule({ zones: ['75'], aids: ['cee'] })]))!;
    const leads = [lead('a', '75011'), lead('b', '69003'), lead('c', '69100'), lead('d', '69003', 'SSC')];
    const i = impactOf('products', { products: [rule()] }, d, leads, NOW);
    const zone = i.lines.find((l) => l.label.includes('hors périmètre'))!;
    expect(zone.count).toBe(2);
    expect(zone.detail).toContain('0 aujourd’hui → 2 après publication');
    expect(i.lines.some((l) => l.label.includes('aides ou critères modifiés') && l.count === 3)).toBe(true);
    expect(i.strategy).toContain('ne bloquent aucune conversion');
    expect(impactOf('products', published, parseDraft(draftOf([rule({ zones: ['75'] })]))!, leads, NOW).lines[0].label).toBe('Aucun produit modifié');
  });
});
