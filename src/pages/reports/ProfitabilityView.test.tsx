import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ProfitabilityView } from './ProfitabilityView';
import { camps, F, NOW, sold, T } from '../../domain/reports/reportsFixtures';
import type { ReportsData } from './useReportsData';

const withAmount = (id: string, cents: number) => sold(id, { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: cents, remainderCents: 0, updatedAtMs: T(2026, 9, 9) } });
const base = { loading: false, error: null, truncated: false, names: { users: new Map(), campaigns: new Map([['c1', 'PAC IDF']]) }, campaigns: [], reportCampaigns: camps, sources: [{ id: 'meta', name: 'Meta' }] };
const html = (over: Partial<ReportsData>) => renderToString(<ProfitabilityView data={{ ...base, leads: [], spends: [], ...over } as unknown as ReportsData} filters={F} now={NOW} />);

describe('écran Rentabilité', () => {
  it('chiffres et définitions : CA, dépenses, marge d’acquisition, retour', () => {
    const h = html({ leads: [withAmount('a', 900_000), withAmount('b', 600_000)], spends: [{ campaignId: 'c1', amountCents: 300_000, atMs: T(2026, 9, 12) }] });
    expect(h).toContain('Chiffre d’affaires TTC');
    expect(h).toContain('PAC IDF');
    expect(h).toContain('× 5');
    expect(h).toContain('pas une marge brute');
    expect(h).not.toContain('sans montant de montage');
  });
  it('sans dépense : tirets, jamais 0 €', () => {
    const h = html({ leads: [withAmount('a', 900_000)] });
    expect(h).toContain('Aucune dépense attribuable');
  });
  it('vente sans montant : signalée', () => {
    expect(html({ leads: [sold('x', { montage: undefined })] })).toContain('sans montant de montage');
  });
  it('période vide : message clair', () => {
    expect(html({})).toContain('Aucune vente ni dépense');
  });
});
