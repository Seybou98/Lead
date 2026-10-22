import { describe, expect, it } from 'vitest';
import { cockpitKpiAlerts } from './kpiAlerts';
import { NO_COCKPIT_FILTERS } from './filters';
import { camps, lead, NOW, sold, T } from '../reports/reportsFixtures';
import type { AlertRule } from '../reports/targets';

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({ id: 'a_1', metric: 'contactRate', mode: 'value', op: 'lt', threshold: 50, minVolume: 3, days: 0, level: 'critical', active: true, ...over } as AlertRule);
// 5 leads reçus il y a 3 jours, aucun contacté (statut « Nouveau »).
const cold = Array.from({ length: 5 }, (_, i) => lead(`n${i}`, { status: 'new', receivedAtMs: NOW - 3 * 86_400_000, slaStartedAtMs: NOW - 3 * 86_400_000, slaStoppedAtMs: null }));
const run = (over: Partial<Parameters<typeof cockpitKpiAlerts>[0]> = {}) => cockpitKpiAlerts({ rules: [rule()], leads: cold, spends: [], campaigns: camps, filters: NO_COCKPIT_FILTERS, period: 'today', nowMs: NOW, slaMs: 300_000, ...over });

describe('alertes KPI du cockpit', () => {
  it('une règle dépassée avec assez de volume remonte, critique', () => {
    const r = run();
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ id: 'a_1', level: 'critical', metric: 'contactRate' });
    expect(r.alerts[0].title).toContain('Taux de contact');
  });
  it('volume insuffisant : jamais d’alerte', () => {
    expect(run({ rules: [rule({ minVolume: 10 })] }).alerts).toEqual([]);
  });
  it('règle inactive : ignorée ; « aucune alerte » n’est pas une alerte de cockpit', () => {
    expect(run({ rules: [rule({ active: false })] }).alerts).toEqual([]);
    expect(run({ rules: [] }).alerts).toEqual([]);
  });
  it('critiques avant avertissements', () => {
    const r = run({ rules: [rule({ id: 'a_w', level: 'warning' }), rule({ id: 'a_c', level: 'critical', metric: 'excludedRate', op: 'gte', threshold: 0, minVolume: 1 })] });
    expect(r.alerts.map((a) => a.level)).toEqual([...r.alerts.map((a) => a.level)].sort((a, b) => Number(b === 'critical') - Number(a === 'critical')));
  });
  it('fenêtre : 7 jours (aujourd’hui, semaine), 30 jours (mois)', () => {
    expect(run({ period: 'today' }).windowDays).toBe(7);
    expect(run({ period: 'week' }).windowDays).toBe(7);
    expect(run({ period: 'month' }).windowDays).toBe(30);
    // Des leads vieux de 10 jours sortent de la fenêtre de 7 jours mais restent dans celle de 30.
    const old = cold.map((l) => ({ ...l, receivedAtMs: NOW - 10 * 86_400_000, slaStartedAtMs: NOW - 10 * 86_400_000 }));
    expect(run({ leads: old, period: 'today' }).alerts).toEqual([]);
    expect(run({ leads: old, period: 'month' }).alerts).toHaveLength(1);
  });
  it('coût par vente : évalué avec les dépenses de la fenêtre', () => {
    const sales = [sold('s1', { conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: NOW - 86_400_000 } }), sold('s2', { conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: NOW - 86_400_000 } })];
    const costRule = rule({ metric: 'costPerSale', op: 'gt', threshold: 100, minVolume: 2, id: 'a_cost' });
    const spends = [{ campaignId: 'c1', amountCents: 100_000, atMs: NOW - 2 * 86_400_000 }];
    expect(run({ rules: [costRule], leads: sales, spends }).alerts.map((a) => a.id)).toEqual(['a_cost']);
    expect(run({ rules: [costRule], leads: sales, spends: [] }).alerts).toEqual([]);
  });
  it('filtre d’équipe ou de zone : dépenses non attribuables, règles de coût muettes (dit à l’écran)', () => {
    const sales = [sold('s1', { conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: NOW - 86_400_000 } }), sold('s2', { conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: NOW - 86_400_000 } })];
    const costRule = rule({ metric: 'costPerSale', op: 'gt', threshold: 100, minVolume: 2, id: 'a_cost' });
    const spends = [{ campaignId: 'c1', amountCents: 100_000, atMs: NOW - 2 * 86_400_000 }];
    const r = run({ rules: [costRule], leads: sales, spends, filters: { ...NO_COCKPIT_FILTERS, team: 't1' } });
    expect(r.alerts).toEqual([]);
    expect(r.spendUnavailable).toBe(true);
    expect(run({ rules: [costRule], leads: sales, spends, filters: { ...NO_COCKPIT_FILTERS, product: 'PAC' } }).spendUnavailable).toBe(false);
  });
  it('une date de test cohérente avec les fixtures', () => expect(NOW).toBe(T(2026, 9, 20)));
});
