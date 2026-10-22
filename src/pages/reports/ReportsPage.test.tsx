import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'u1', role: 'manager' }, logout: async () => undefined }) }));
vi.mock('../leads/useLeadsData', () => ({ useNow: () => 0 }));
vi.mock('../settings/useSettings', async () => {
  const { DEFAULT_REPORT_SETTINGS } = await import('../../domain/reports/targets');
  return { useSettings: () => ({ reports: DEFAULT_REPORT_SETTINGS }) };
});

import { ReportsView } from './ReportsPage';
import { camps, NOW, sold } from '../../domain/reports/reportsFixtures';
import type { ReportsData } from './useReportsData';

const data = {
  loading: false, error: null, truncated: false, names: { users: new Map(), campaigns: new Map([['c1', 'PAC IDF']]) }, campaigns: [], reportCampaigns: camps, sources: [{ id: 'meta', name: 'Meta' }], spends: [],
  teams: [{ id: 't1', name: 'Équipe Paris' }],
  leads: [sold('s1', { teamId: 't1', postalCode: '75011', adId: 'ad1', formId: 'f1' })],
} as unknown as ReportsData;
const html = (url: string) => renderToString(<MemoryRouter initialEntries={[url]}><ReportsView data={data} nowOverride={NOW} /></MemoryRouter>).replace(/<!-- -->/g, '');

describe('rapports : filtres de périmètre et lien partageable', () => {
  it('filtres proposés : campagne, équipe, zone, publicité, formulaire (selon les données)', () => {
    const h = html('/rapports');
    for (const l of ['Campagne', 'Équipe', 'Zone', 'Publicité', 'Formulaire', 'Produit', 'Télépro']) expect(h).toContain(`aria-label="${l}"`);
    expect(h).toContain('Équipe Paris');
    expect(h).toContain('Département 75');
    expect(h).not.toContain('Réinitialiser les filtres');
  });
  it('filtres, comparaison et pas lus dans l’adresse', () => {
    const h = html('/rapports?zone=75&equipe=t1&comparer=year&pas=month&periode=month');
    expect(h).toContain('Réinitialiser les filtres (2)');
    expect(h).toContain('Même période, année précédente');
    expect(h).toMatch(/<option value="year" selected/);
    expect(h).toMatch(/<option value="month" selected/);
    expect(h).toContain('Dépenses et ventes par mois');
  });
  it('vue lue dans l’adresse ; valeur inconnue : vue par défaut', () => {
    expect(html('/rapports?vue=quality')).toContain('Qualité des leads');
    expect(html('/rapports?vue=zzz')).toContain('Rapport Direction');
  });
  it('par défaut : période précédente et série par semaine', () => {
    const h = html('/rapports');
    expect(h).toContain('Dépenses et ventes par semaine');
    expect(h).toMatch(/période précédente : /);
  });
});
