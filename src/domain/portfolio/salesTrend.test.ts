import { describe, expect, it } from 'vitest';
import { salesTrend, saleDateOf } from './salesTrend';
import type { LeadListItem } from '../leads/leadList';

const NOW = new Date(2026, 9, 22, 12).getTime(); // octobre 2026
const at = (y: number, m: number, d = 10) => new Date(y, m - 1, d, 12).getTime();
const sale = (id: string, convertedAtMs: number, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: id, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'converted', temperature: null, assignmentState: 'assigned', bufferReason: null,
  ownerId: 'u1', receivedAtMs: convertedAtMs - 86_400_000, slaStartedAtMs: null, slaStoppedAtMs: null, nextAction: null, documentsState: 'complete', duplicate: false, excluded: false,
  conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs },
  montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 500_000, remainderCents: 0, updatedAtMs: convertedAtMs }, ...over,
});

describe('évolution des ventes d’un télépro', () => {
  it('six mois, du plus ancien au mois en cours', () => {
    const t = salesTrend([], 'u1', NOW);
    expect(t.months.map((m) => m.label)).toEqual(['05/26', '06/26', '07/26', '08/26', '09/26', '10/26']);
    expect(t.current.label).toBe('10/26');
    expect(t.total).toBe(0);
  });
  it('ventes nettes par mois et chiffre d’affaires TTC', () => {
    const t = salesTrend([sale('a', at(2026, 10)), sale('b', at(2026, 10, 3)), sale('c', at(2026, 9)), sale('d', at(2026, 5, 31))], 'u1', NOW);
    expect(t.months.map((m) => m.sales)).toEqual([1, 0, 0, 0, 1, 2]);
    expect(t.current.revenueCents).toBe(1_000_000);
    expect(t.delta).toBe(100);
    expect(t.previous?.sales).toBe(1);
  });
  it('annulée, exclue, doublon, autre télépro, hors fenêtre : pas comptées', () => {
    const t = salesTrend([sale('a', at(2026, 10), { commercialState: 'cancelled' }), sale('b', at(2026, 10), { excluded: true }), sale('c', at(2026, 10), { duplicate: true }), sale('d', at(2026, 10), { ownerId: 'u2' }), sale('e', at(2026, 4, 30)), sale('f', at(2026, 11, 2))], 'u1', NOW);
    expect(t.total).toBe(0);
  });
  it('variation : vide sans vente le mois précédent (jamais de division par zéro)', () => {
    expect(salesTrend([sale('a', at(2026, 10))], 'u1', NOW).delta).toBeNull();
    expect(salesTrend([sale('a', at(2026, 9)), sale('b', at(2026, 10))], 'u1', NOW).delta).toBe(0);
  });
  it('vente sans montant : comptée, sans chiffre d’affaires', () => {
    const t = salesTrend([sale('a', at(2026, 10), { montage: undefined })], 'u1', NOW);
    expect(t.current.sales).toBe(1);
    expect(t.current.revenueCents).toBe(0);
  });
  it('date de la vente : transmission, puis dossier, puis réception', () => {
    expect(saleDateOf(sale('a', 5))).toBe(5);
    expect(saleDateOf(sale('a', 5, { conversion: undefined }))).toBe(5);
    expect(saleDateOf(sale('a', 5, { conversion: undefined, montage: undefined }))).toBe(5 - 86_400_000);
  });
});
