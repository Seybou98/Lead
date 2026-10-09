import { describe, expect, it } from 'vitest';
import { buildTeleproReport, ratiosOf, teleproPopulation, teleproRows } from './telepros';
import { camps, F, lead, NOW, sold, T } from './reportsFixtures';

const SLA = 5 * 60_000;
const rep = (leads: ReturnType<typeof lead>[], f = {}) => buildTeleproReport({ leads, campaigns: camps, filters: { ...F, ...f }, nowMs: NOW, slaMs: SLA });

describe('ratios (§22.6)', () => {
  it('chaque taux se calcule sur son dénominateur, « — » si nul', () => {
    const r = ratiosOf({ received: 10, valid: 8, contacted: 4, interested: 3, docsRequested: 2, docsComplete: 1, mounted: 1, sales: 1 });
    expect(r).toEqual({ contact: 50, contactToDocs: 50, docsToComplete: 50, completeToSale: 100, leadToSale: 12.5 });
    expect(ratiosOf({ received: 0, valid: 0, contacted: 0, interested: 0, docsRequested: 0, docsComplete: 0, mounted: 0, sales: 0 })).toEqual({ contact: null, contactToDocs: null, docsToComplete: null, completeToSale: null, leadToSale: null });
  });
});

describe('comparaison des télépros', () => {
  const leads = [
    sold('s1', { ownerId: 'u1' }), sold('s2', { ownerId: 'u1' }),
    lead('n1', { ownerId: 'u1', status: 'nr' }), lead('d1', { ownerId: 'u1', duplicate: true }),
    sold('s3', { ownerId: 'u2' }), lead('i1', { ownerId: 'u2', status: 'interested', slaStoppedAtMs: T(2026, 9, 5) + 60 * 60_000 }),
    lead('free', { ownerId: null }),
  ];
  const r = rep(leads);
  it('une ligne par télépro, classées par ventes', () => {
    expect(r.rows.map((x) => x.ownerId)).toEqual(['u1', 'u2']);
    expect(r.rows[0].counts.sales).toBe(2);
    expect(r.rows[1].counts.sales).toBe(1);
  });
  it('les leads sans télépro ne sont attribués à personne', () => {
    expect(r.total.counts.received).toBe(6);
  });
  it('doublons exclus des leads attribués mais vus dans les reçus', () => {
    expect(r.rows[0].counts.received).toBe(4);
    expect(r.rows[0].attributed).toBe(3);
  });
  it('lead → vente = ventes / leads valides attribués', () => {
    expect(r.rows[0].ratios.leadToSale).toBeCloseTo(66.7, 1);
  });
  it('le total est la somme des lignes', () => {
    expect(r.total.counts.sales).toBe(r.rows.reduce((a, x) => a + x.counts.sales, 0));
    expect(r.total.attributed).toBe(r.rows.reduce((a, x) => a + x.attributed, 0));
  });
  it('volume faible signalé (comparaison équitable)', () => expect(r.rows.every((x) => x.lowVolume)).toBe(true));
  it('SLA : traité dans le délai, hors délai, non traité mais dépassé', () => {
    // u1 : s1, s2 traités à +1 min (ok) ; n1 non traité depuis le 5 (dépassé) ; u2 : s3 ok, i1 traité à +1 h (manqué).
    expect(r.rows[0]).toMatchObject({ slaMeasured: 3, slaRespected: 2 });
    expect(r.rows[1]).toMatchObject({ slaMeasured: 2, slaRespected: 1, slaRate: 50 });
  });
  it('un lead récent encore dans le délai n’est pas mesuré', () => {
    const fresh = lead('f', { receivedAtMs: NOW - 60_000, slaStartedAtMs: NOW - 60_000 });
    const out = rep([fresh], { fromMs: NOW - DAYMS, toMs: NOW + DAYMS }).rows[0];
    expect(out.slaMeasured).toBe(0);
    expect(out.slaRate).toBeNull();
  });
  it('heures non ouvrées : le temps écoulé injecté remplace l’écart brut', () => {
    const slow = lead('slow', { slaStoppedAtMs: T(2026, 9, 5) + 3 * 3_600_000 });
    const raw = buildTeleproReport({ leads: [slow], campaigns: camps, filters: F, nowMs: NOW, slaMs: SLA });
    const adj = buildTeleproReport({ leads: [slow], campaigns: camps, filters: F, nowMs: NOW, slaMs: SLA, elapsed: () => 60_000 });
    expect(raw.rows[0].slaRespected).toBe(0);
    expect(adj.rows[0].slaRespected).toBe(1);
  });
  it('filtre télépro : une seule ligne', () => expect(rep(leads, { owner: 'u2' }).rows.map((x) => x.ownerId)).toEqual(['u2']));
  it('télépro sans activité sur la période : pas de ligne', () => {
    const old = sold('old', { receivedAtMs: T(2026, 6, 1), slaStartedAtMs: T(2026, 6, 1), slaStoppedAtMs: T(2026, 6, 1) + 1000, docs: undefined, conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 6, 3) }, montage: undefined, documentsState: 'none' });
    expect(rep([old]).rows).toEqual([]);
  });
});

describe('population et export', () => {
  const leads = [sold('s1'), sold('s2'), lead('n1', { status: 'nr' })];
  it('la liste ouverte au clic a exactement le total du chiffre (§22.12)', () => {
    const r = rep(leads);
    for (const stage of ['received', 'valid', 'contacted', 'docsComplete', 'sales'] as const) {
      expect(teleproPopulation(leads, camps, F, 'u1', stage)).toHaveLength(r.rows[0].counts[stage]);
    }
  });
  it('CSV : mode de date, une ligne par télépro et l’ensemble', () => {
    const rows = teleproRows(rep(leads), (id) => `Nom ${id}`, 'Date d’événement');
    expect(rows[0]).toEqual(['Mode de date', 'Date d’événement']);
    expect(rows.map((x) => x[0])).toEqual(expect.arrayContaining(['Nom u1', 'Ensemble']));
  });
});

const DAYMS = 86_400_000;
