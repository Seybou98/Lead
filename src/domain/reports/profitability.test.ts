import { describe, expect, it } from 'vitest';
import { buildProfitReport, profitabilityRows, profitPopulation } from './profitability';
import { camps, F, lead, sold, T } from './reportsFixtures';
import type { ReportSpend } from './direction';
import type { LeadListItem } from '../leads/leadList';

const cm = [...camps, { id: 'c2', name: 'SSC Est', sourceId: 'google', productCode: 'SSC' }];
const ttc = (id: string, cents: number, over: Partial<LeadListItem> = {}) => sold(id, { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: cents, remainderCents: 0, updatedAtMs: T(2026, 9, 9) }, ...over });
const spend = (campaignId: string, amountCents: number, day = 12): ReportSpend => ({ campaignId, amountCents, atMs: T(2026, 9, day) });
const rep = (leads: LeadListItem[], spends: ReportSpend[] = [], dim: 'campaign' | 'source' | 'product' | 'owner' = 'campaign', f = {}) => buildProfitReport({ leads, spends, campaigns: cm, filters: { ...F, ...f }, dim });

describe('rentabilité : chiffre d’affaires et marge d’acquisition', () => {
  it('CA = montants TTC des ventes nettes ; marge = CA − dépenses ; retour = CA / dépenses', () => {
    const r = rep([ttc('a', 900_000), ttc('b', 600_000), lead('c')], [spend('c1', 300_000)]);
    const row = r.rows[0];
    expect(row.key).toBe('c1');
    expect(row.tally).toMatchObject({ leads: 3, sales: 2, revenueCents: 1_500_000, spendCents: 300_000, withoutAmount: 0 });
    expect(row.marginCents).toBe(1_200_000);
    expect(row.roas).toBe(5);
    expect(row.acquisitionRate).toBe(20);
    expect(row.basketCents).toBe(750_000);
    expect(row.costPerSaleCents).toBe(150_000);
    expect(r.total.marginCents).toBe(1_200_000);
  });
  it('vente annulée : retirée du CA, montrée à part', () => {
    const r = rep([ttc('a', 900_000), ttc('b', 500_000, { commercialState: 'cancelled' })], [spend('c1', 100_000)]);
    expect(r.rows[0].tally).toMatchObject({ sales: 1, cancelled: 1, revenueCents: 900_000, cancelledRevenueCents: 500_000 });
  });
  it('CA sécurisé : signé ET paiement confirmé ou financement accepté', () => {
    const r = rep([ttc('a', 800_000, { commercialState: 'signed', financialState: 'payment_confirmed' }), ttc('b', 200_000, { commercialState: 'signed', financialState: 'pending' })]);
    expect(r.total.tally).toMatchObject({ revenueCents: 1_000_000, securedRevenueCents: 800_000, secured: 1 });
  });
  it('vente sans montant : comptée vente, pas dans le CA ni le panier, et signalée', () => {
    const leads = [ttc('a', 400_000), sold('b', { montage: undefined })];
    const r = rep(leads, [spend('c1', 100_000)]);
    expect(r.total.tally).toMatchObject({ sales: 2, revenueCents: 400_000, withoutAmount: 1 });
    expect(r.total.basketCents).toBe(400_000);
    expect(profitPopulation(leads, cm, F, 'campaign', null, 'noAmount').map((l) => l.id)).toEqual(['b']);
  });
  it('doublons, faux leads et exclus : ni leads ni ventes', () => {
    const r = rep([ttc('a', 100_000), ttc('b', 100_000, { duplicate: true }), ttc('c', 100_000, { excluded: true })]);
    expect(r.total.tally).toMatchObject({ leads: 1, sales: 1, revenueCents: 100_000 });
  });
});

describe('rentabilité : dépenses', () => {
  it('sans dépense : marge, retour et coût inconnus (jamais 0)', () => {
    const row = rep([ttc('a', 100_000)]).rows[0];
    expect(row).toMatchObject({ marginCents: null, roas: null, acquisitionRate: null, costPerSaleCents: null });
    expect(row.tally.spendCents).toBeNull();
  });
  it('seules les dépenses de la période comptent', () => {
    const r = rep([ttc('a', 100_000)], [spend('c1', 50_000, 12), { campaignId: 'c1', amountCents: 999_000, atMs: T(2026, 8, 12) }]);
    expect(r.rows[0].tally.spendCents).toBe(50_000);
  });
  it('une campagne dépensée sans vente apparaît, en perte', () => {
    const r = rep([ttc('a', 100_000)], [spend('c2', 70_000)]);
    const c2 = r.rows.find((x) => x.key === 'c2')!;
    expect(c2.marginCents).toBe(-70_000);
    expect(c2.roas).toBeNull();
  });
  it('par source et par produit : dépenses regroupées par campagne', () => {
    const leads = [ttc('a', 100_000), ttc('b', 100_000, { campaignId: 'c2', productCode: 'SSC' })];
    const sp = [spend('c1', 10_000), spend('c2', 20_000), spend('c2', 5_000)];
    expect(rep(leads, sp, 'source').rows.find((x) => x.key === 'google')!.tally.spendCents).toBe(25_000);
    expect(rep(leads, sp, 'product').rows.find((x) => x.key === 'PAC')!.tally.spendCents).toBe(10_000);
  });
  it('par télépro : ventes oui, dépenses non attribuables ; le total garde les dépenses', () => {
    const r = rep([ttc('a', 100_000, { ownerId: 'u1' }), ttc('b', 300_000, { ownerId: 'u2' })], [spend('c1', 50_000)], 'owner');
    expect(r.spendUnavailable).toBe(true);
    expect(r.rows.every((x) => x.tally.spendCents === null && x.marginCents === null)).toBe(true);
    expect(r.rows[0].key).toBe('u2');
    expect(r.total.tally.spendCents).toBe(50_000);
  });
  it('filtre télépro : aucun coût', () => {
    expect(rep([ttc('a', 100_000)], [spend('c1', 50_000)], 'campaign', { owner: 'u1' }).total.tally.spendCents).toBeNull();
  });
  it('filtre produit : les dépenses des autres produits sont ignorées', () => {
    expect(rep([ttc('a', 100_000)], [spend('c1', 10_000), spend('c2', 20_000)], 'campaign', { product: 'PAC' }).total.tally.spendCents).toBe(10_000);
  });
});

describe('rentabilité : période et mode de date', () => {
  const late = (id: string) => ttc(id, 100_000, { receivedAtMs: T(2026, 8, 28), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 9, 10) } });
  it('événement : la vente compte à sa date de transmission', () => {
    expect(rep([late('a')]).total.tally).toMatchObject({ sales: 1, leads: 0 });
  });
  it('cohorte : la vente suit la date de réception du lead', () => {
    expect(rep([late('a')], [], 'campaign', { mode: 'cohort' }).total.tally).toMatchObject({ sales: 0, leads: 0 });
  });
});

describe('rentabilité : classement, populations, export', () => {
  it('les plus rentables d’abord, les sans-dépense ensuite par CA', () => {
    const leads = [ttc('a', 100_000), ttc('b', 900_000, { campaignId: 'c2', productCode: 'SSC' })];
    const r = rep(leads, [spend('c1', 20_000)]);
    expect(r.rows.map((x) => x.key)).toEqual(['c1', 'c2']);
  });
  it('population d’un chiffre : ventes, annulées', () => {
    const leads = [ttc('a', 1), ttc('b', 1, { commercialState: 'cancelled' })];
    expect(profitPopulation(leads, cm, F, 'campaign', 'c1', 'sales').map((l) => l.id)).toEqual(['a']);
    expect(profitPopulation(leads, cm, F, 'campaign', 'c1', 'cancelled').map((l) => l.id)).toEqual(['b']);
    expect(profitPopulation(leads, cm, F, 'campaign', 'zz', 'sales')).toEqual([]);
  });
  it('export : euros, ligne Ensemble, cellules vides si inconnu', () => {
    const rows = profitabilityRows(rep([ttc('a', 900_000)], [spend('c1', 300_000)]), (k) => (k === 'c1' ? 'PAC IDF' : k));
    expect(rows[1][0]).toBe('Campagne');
    expect(rows[2]).toEqual(['PAC IDF', 1, 1, 0, 9000, 0, 0, 3000, 6000, 3, 33.3, 9000, 3000, 0]);
    expect(rows[3][0]).toBe('Ensemble');
    expect(profitabilityRows(rep([ttc('a', 100_000)]), (k) => k)[2][7]).toBe('');
  });
});
