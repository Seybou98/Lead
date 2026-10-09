import { describe, expect, it } from 'vitest';
import { buildQualityReport, dimKey, flagsOf, motifOf, motifPopulation, qualityPopulation, qualityRows, zoneOf } from './quality';
import { camps, docs, F, lead, T } from './reportsFixtures';
import type { LeadListItem } from '../leads/leadList';

const cm = [...camps, { id: 'c2', name: 'SSC Est', sourceId: 'google', productCode: 'SSC' }];
const fake = (id: string, code: string, over: Partial<LeadListItem> = {}) => lead(id, { status: 'fake_lead', excluded: true, excludedReason: code, closure: { kind: 'fake_lead', code, label: code === 'invalid_number' ? 'Numéro invalide' : 'Faux numéro' }, ...over });
const inel = (id: string, category: string, over: Partial<LeadListItem> = {}) => lead(id, { status: 'ineligible', closure: { kind: 'ineligible', code: 'x', label: 'Surface insuffisante', category }, ...over });
const rep = (leads: LeadListItem[], dim: 'source' | 'campaign' | 'product' | 'zone' | 'owner' = 'source', f = {}) => buildQualityReport({ leads, campaigns: cm, filters: { ...F, ...f }, dim });

describe('drapeaux de qualité', () => {
  it('lead sain : aucun drapeau', () => expect(Object.values(flagsOf(lead('a'))).some(Boolean)).toBe(false));
  it('doublon', () => expect(flagsOf(lead('a', { duplicate: true })).duplicate).toBe(true));
  it('faux lead : coordonnées invalides seulement pour les motifs de coordonnées', () => {
    expect(flagsOf(fake('a', 'invalid_number'))).toMatchObject({ fake: true, invalidContact: true });
    expect(flagsOf(fake('b', 'spam'))).toMatchObject({ fake: true, invalidContact: false });
  });
  it('un doublon n’est pas aussi compté faux lead', () => expect(flagsOf(fake('a', 'spam', { duplicate: true }))).toMatchObject({ duplicate: true, fake: false }));
  it('inéligible hors zone', () => {
    expect(flagsOf(inel('a', 'zone'))).toMatchObject({ ineligible: true, outOfZone: true });
    expect(flagsOf(inel('b', 'technical'))).toMatchObject({ ineligible: true, outOfZone: false });
  });
  it('opposition et non-intérêt', () => {
    const l = lead('a', { status: 'not_interested', closure: { kind: 'not_interested', code: 'no_more_contact', label: 'Ne souhaite plus', opposition: true } });
    expect(flagsOf(l)).toMatchObject({ notInterested: true, opposition: true });
  });
  it('abandon documentaire : pièces demandées, jamais complet, lead clos sans vente', () => {
    expect(flagsOf(lead('a', { status: 'not_interested', documentsState: 'partial', docs: docs() })).docAbandon).toBe(true);
    expect(flagsOf(lead('b', { status: 'awaiting_documents', documentsState: 'partial' })).docAbandon).toBe(false);
    expect(flagsOf(lead('c', { status: 'not_interested', documentsState: 'complete' })).docAbandon).toBe(false);
  });
  it('injoignable archivé', () => expect(flagsOf(lead('a', { status: 'unreachable_archived' })).unreachable).toBe(true));
});

describe('zone', () => {
  it('département, outre-mer sur 3 chiffres, inconnue sinon', () => {
    expect(zoneOf('75011')).toBe('75');
    expect(zoneOf('97400')).toBe('974');
    expect(zoneOf('7501')).toBe('Inconnue');
    expect(zoneOf('')).toBe('Inconnue');
  });
});

describe('rapport par dimension', () => {
  const leads = [
    lead('a1', { campaignId: 'c1' }), lead('a2', { campaignId: 'c1' }), lead('a3', { campaignId: 'c1', duplicate: true }), fake('a4', 'invalid_number', { campaignId: 'c1' }),
    lead('b1', { campaignId: 'c2' }), inel('b2', 'zone', { campaignId: 'c2' }),
  ];
  const r = rep(leads, 'source');
  it('brut, valide et exclu par source', () => {
    const meta = r.rows.find((x) => x.key === 'meta')!;
    expect(meta.tally).toMatchObject({ received: 4, valid: 2, excluded: 2 });
    expect(meta.tally.flags).toMatchObject({ duplicate: 1, fake: 1, invalidContact: 1 });
    expect(meta.tally.lowQualityRate).toBe(50);
  });
  it('corrigé = brut − exclus ; l’ensemble est la somme des lignes', () => {
    expect(r.total.valid).toBe(r.total.received - r.total.excluded);
    expect(r.total.received).toBe(r.rows.reduce((a, x) => a + x.tally.received, 0));
  });
  it('lignes classées par mauvaise qualité décroissante', () => expect(r.rows.map((x) => x.key)).toEqual(['meta', 'google']));
  it('autres dimensions', () => {
    expect(rep(leads, 'campaign').rows).toHaveLength(2);
    expect(rep(leads, 'product').rows.map((x) => x.key)).toEqual(['PAC']);
    expect(rep(leads, 'owner').rows.map((x) => x.key)).toEqual(['u1']);
    expect(dimKey(lead('z', { campaignId: null }), 'source', cm)).toBe('—');
  });
  it('seuls les leads reçus pendant la période comptent', () => {
    expect(rep([lead('old', { receivedAtMs: T(2026, 6, 1) })]).total.received).toBe(0);
  });
  it('période vide : taux null, pas de division par zéro', () => expect(rep([]).total.lowQualityRate).toBeNull());
  it('liste ouverte au clic = chiffre affiché (§22.12)', () => {
    for (const w of ['received', 'valid', 'excluded', 'lowQuality', 'duplicate', 'fake', 'ineligible'] as const) {
      const want = w === 'received' ? r.total.received : w === 'valid' ? r.total.valid : w === 'excluded' ? r.total.excluded : w === 'lowQuality' ? r.total.lowQuality : r.total.flags[w];
      expect(qualityPopulation(leads, cm, F, 'source', null, w)).toHaveLength(want);
    }
    expect(qualityPopulation(leads, cm, F, 'source', 'meta', 'excluded')).toHaveLength(2);
  });
  it('un faux lead reste dans la donnée brute, hors donnée corrigée (§22.12)', () => {
    const raw = qualityPopulation(leads, cm, F, 'source', null, 'received').map((l) => l.id);
    const valid = qualityPopulation(leads, cm, F, 'source', null, 'valid').map((l) => l.id);
    expect(raw).toContain('a4');
    expect(valid).not.toContain('a4');
  });
});

describe('motifs', () => {
  it('un motif principal par lead : doublon, puis clôture', () => {
    expect(motifOf(lead('a', { duplicate: true, closure: { kind: 'fake_lead', code: 'spam', label: 'Spam' } }))?.family).toBe('Doublon');
    expect(motifOf(inel('a', 'financial'))).toMatchObject({ family: 'Inéligibilité — financière', label: 'Surface insuffisante' });
    expect(motifOf(lead('a'))).toBeNull();
  });
  it('lead clos avant l’enregistrement du motif : « Motif non renseigné »', () => {
    expect(motifOf(lead('a', { status: 'not_interested' }))?.label).toBe('Motif non renseigné');
    expect(motifOf(lead('a', { status: 'fake_lead', excluded: true, excludedReason: 'spam' }))?.label).toBe('Test / spam');
    expect(motifOf(lead('a', { status: 'fake_lead', excluded: true }))?.label).toBe('Motif non renseigné');
  });
  it('tableau des motifs : volumes, parts, tri', () => {
    const leads = [fake('a', 'spam'), fake('b', 'spam'), fake('c', 'invalid_number'), lead('d', { duplicate: true }), lead('ok')];
    const r = rep(leads);
    expect(r.motifs[0]).toMatchObject({ key: 'fake:spam', count: 2, share: 50 });
    expect(r.motifs.reduce((a, m) => a + m.count, 0)).toBe(4);
    expect(motifPopulation(leads, cm, F, 'fake:spam')).toHaveLength(2);
  });
});

describe('alertes (§22.8)', () => {
  const many = (n: number, mk: (i: number) => LeadListItem) => Array.from({ length: n }, (_, i) => mk(i));
  it('source de mauvaise qualité avec assez de volume : alerte', () => {
    const leads = [...many(8, (i) => fake(`f${i}`, 'spam', { campaignId: 'c2' })), ...many(4, (i) => lead(`g${i}`, { campaignId: 'c2' })), ...many(20, (i) => lead(`h${i}`, { campaignId: 'c1' }))];
    const a = rep(leads, 'source').alerts;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ key: 'google', level: 'critical' });
  });
  it('volume insuffisant : pas d’alerte, même à 100 %', () => {
    expect(rep(many(5, (i) => fake(`f${i}`, 'spam', { campaignId: 'c2' })), 'source').alerts).toEqual([]);
  });
});

describe('export', () => {
  it('CSV : lecture, lignes, ensemble et motifs', () => {
    const rows = qualityRows(rep([fake('a', 'spam'), lead('b')]), (k) => `Nom ${k}`);
    expect(rows[0][0]).toBe('Lecture');
    expect(rows.map((x) => x[0])).toEqual(expect.arrayContaining(['Nom meta', 'Ensemble', 'Famille']));
  });
});
