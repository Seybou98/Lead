import { describe, expect, it } from 'vitest';
import { buildDirectionReport, compareRange, scopeLeads, spendAttributable, yearAgoRange } from './direction';
import { buildProfitReport } from './profitability';
import { camps, F, lead, sold, T } from './reportsFixtures';
import { zoneOf } from './zone';
import { filterSummary } from './exports';
import type { LeadListItem } from '../leads/leadList';

const base = { sourceId: '', campaignId: '', product: '', owner: '' };
const items: LeadListItem[] = [
  lead('a', { teamId: 't1', postalCode: '75011', adId: 'ad1', formId: 'f1' }),
  lead('b', { teamId: 't2', postalCode: '69003', adId: 'ad2', formId: 'f1' }),
  lead('c', { postalCode: '' }),
];

describe('filtres de périmètre : équipe, zone, publicité, formulaire', () => {
  const ids = (f: Partial<Parameters<typeof scopeLeads>[1]>) => scopeLeads(items, { ...base, ...f }, camps).map((l) => l.id);
  it('chaque filtre retient les leads qui correspondent', () => {
    expect(ids({ team: 't1' })).toEqual(['a']);
    expect(ids({ zone: '69' })).toEqual(['b']);
    expect(ids({ ad: 'ad2' })).toEqual(['b']);
    expect(ids({ form: 'f1' })).toEqual(['a', 'b']);
  });
  it('cumulés : tous doivent correspondre ; sans filtre, tout passe', () => {
    expect(ids({ form: 'f1', zone: '75' })).toEqual(['a']);
    expect(ids({ form: 'f1', zone: '75', team: 't2' })).toEqual([]);
    expect(ids({})).toEqual(['a', 'b', 'c']);
  });
  it('la zone vient du code postal (outre-mer sur 3 chiffres)', () => {
    expect(zoneOf('97400')).toBe('974');
    expect(zoneOf('')).toBe('Inconnue');
  });
});

describe('dépenses non attribuables', () => {
  it('télépro, équipe, zone, publicité ou formulaire : le coût n’est pas calculé', () => {
    expect(spendAttributable(base)).toBe(true);
    for (const k of ['owner', 'team', 'zone', 'ad', 'form'] as const) expect(spendAttributable({ ...base, [k]: 'x' })).toBe(false);
  });
  it('le rapport Direction et la rentabilité n’inventent pas de coût sous ces filtres', () => {
    const spends = [{ campaignId: 'c1', amountCents: 100_000, atMs: T(2026, 9, 12) }];
    const f = { ...F, zone: '75' };
    expect(buildDirectionReport({ leads: items, spends, campaigns: camps, filters: f, nowMs: F.toMs }).current.spendCents).toBeNull();
    expect(buildDirectionReport({ leads: items, spends, campaigns: camps, filters: F, nowMs: F.toMs }).current.spendCents).toBe(100_000);
    expect(buildProfitReport({ leads: items, spends, campaigns: camps, filters: f, dim: 'campaign' }).total.tally.spendCents).toBeNull();
  });
  it('le résumé d’un export ne ment pas sur ce qui est filtré', () => {
    const s = filterSummary({ ...F, team: 't1', zone: '75' }, { names: { users: new Map(), campaigns: new Map(), sources: new Map() }, reportCampaigns: camps }, false);
    expect(s.find((x) => x.label === 'Équipe')?.value).toBe('t1');
    expect(s.find((x) => x.label === 'Zone')?.value).toBe('Département 75');
    expect(filterSummary(F, { names: { users: new Map(), campaigns: new Map(), sources: new Map() }, reportCampaigns: camps }, false).some((x) => x.label === 'Zone')).toBe(false);
  });
});

describe('comparaison avec l’année précédente', () => {
  it('mêmes dates un an plus tôt ; 29 février ramené au 28', () => {
    const r = yearAgoRange({ fromMs: T(2026, 9, 1, 0), toMs: T(2026, 10, 1, 0) });
    expect(r).toEqual({ fromMs: T(2025, 9, 1, 0), toMs: T(2025, 10, 1, 0) });
    expect(yearAgoRange({ fromMs: T(2028, 2, 29, 0), toMs: T(2028, 3, 1, 0) }).fromMs).toBe(T(2027, 2, 28, 0));
  });
  it('mode précédente = juste avant, même durée', () => {
    expect(compareRange(F, 'previous')).toEqual({ fromMs: F.fromMs - (F.toMs - F.fromMs), toMs: F.fromMs });
    expect(compareRange(F, 'year').fromMs).toBe(T(2025, 9, 1, 0));
  });
  it('les variations comparent bien aux ventes de l’an passé', () => {
    const lastYear = sold('ly', { receivedAtMs: T(2025, 9, 5), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2025, 9, 10) }, montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: T(2025, 9, 9) } });
    const thisYear = [sold('t1'), sold('t2')];
    const r = buildDirectionReport({ leads: [lastYear, ...thisYear], spends: [], campaigns: camps, filters: F, nowMs: F.toMs, compare: 'year' });
    expect(r.kpis.sales.value).toBe(2);
    expect(r.kpis.sales.previous).toBe(1);
    expect(r.kpis.sales.delta).toBe(100);
    expect(r.previousRange).toEqual(yearAgoRange(F));
    // Par défaut : la période précédente (août), où il n'y a aucune vente.
    expect(buildDirectionReport({ leads: [lastYear, ...thisYear], spends: [], campaigns: camps, filters: F, nowMs: F.toMs }).kpis.sales.previous).toBe(0);
  });
});

describe('granularité de la série', () => {
  const run = (granularity: 'day' | 'week' | 'month') => buildDirectionReport({ leads: [sold('s1')], spends: [], campaigns: camps, filters: F, nowMs: F.toMs, granularity });
  it('jour : un point par jour ; mois : un point ; semaine : par défaut', () => {
    expect(run('day').weeks).toHaveLength(30);
    expect(run('month').weeks).toHaveLength(1);
    expect(run('week').weeks.length).toBeGreaterThanOrEqual(5);
    expect(buildDirectionReport({ leads: [], spends: [], campaigns: camps, filters: F, nowMs: F.toMs }).granularity).toBe('week');
  });
  it('les ventes se retrouvent dans la série, quel que soit le pas', () => {
    for (const g of ['day', 'week', 'month'] as const) expect(run(g).weeks.reduce((n, w) => n + w.sales, 0)).toBe(1);
  });
});
