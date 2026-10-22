import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./ManagerNotifications', () => ({ ManagerNotifications: () => null }));
vi.mock('../../lib/conversionApi', () => ({ sendConversionAction: async () => ({ ok: false, message: 'x' }) }));
vi.mock('../../lib/reassignApi', () => ({ sendReassign: async () => ({ ok: false, message: 'x' }) }));
vi.mock('../settings/useSettings', () => ({ useSettings: () => ({ reasons: { lists: {} }, reasonCatalog: {} }) }));
vi.mock('../leads/useLeadsData', () => ({ useLeadFile: () => ({ loading: true, error: null, lead: null, file: null, events: [], names: { users: new Map(), campaigns: new Map() } }) }));

import { CockpitView } from './CockpitPage';
import type { CockpitData } from './useCockpitData';
import type { LeadListItem } from '../../domain/leads/leadList';
import type { UserRow } from '../../domain/admin/userRows';

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const H = 3_600_000;
const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '75011', campaignId: 'c1', productCode: 'PAC', status: 'awaiting_documents', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 5 * H, slaStartedAtMs: null, slaStoppedAtMs: NOW - 4 * H, nextAction: null,
  documentsState: 'requested', duplicate: false, excluded: false,
  docs: { expected: 4, received: 0, conform: 0, mandatory: 3, mandatoryConform: 0, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: NOW - H, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0 }, ...over,
});
const row = (uid: string, team: string): UserRow => ({ uid, name: `Télépro ${uid}`, email: '', role: 'telepro', accountActive: true, hasProfile: true, teamIds: [team], teamNames: [`Équipe ${team}`], products: [], zones: [], newLeads: 1, cap: 10, connected: true, operationalStatus: 'available', distribution: 'active' });
const data: CockpitData = {
  loading: false, error: null, nowMs: NOW, reportCampaigns: [], spends: [], kpiRules: [], scheduler: { lastRunAtMs: null, statusReturn: null }, syncedAtMs: NOW, offline: false, users: [],
  items: [lead('a'), lead('b', { ownerId: 'u2', productCode: 'SSC', postalCode: '69003', campaignId: 'c2' })],
  rows: [row('u1', 't1'), row('u2', 't2')],
  names: { users: new Map([['u1', 'Sarah'], ['u2', 'Mehdi']]), campaigns: new Map([['c1', 'PAC IDF'], ['c2', 'SSC Est']]) },
};
const html = (url = '/cockpit') => renderToString(<MemoryRouter initialEntries={[url]}><CockpitView data={data} role="manager" /></MemoryRouter>);

describe('cockpit manager : filtres, pipeline, documents', () => {
  it('barre de filtres : équipe, produit, campagne, zone', () => {
    const h = html();
    for (const l of ['Équipe', 'Produit', 'Campagne', 'Zone']) expect(h).toContain(`aria-label="${l}"`);
    expect(h).toContain('Équipe t1');
    expect(h).toContain('Département 69');
    expect(h).not.toContain('Réinitialiser les filtres');
  });
  it('pipeline et vues documentaires affichent leurs volumes', () => {
    const h = html();
    expect(h).toContain('Pipeline');
    expect(h).toContain('Cockpit documentaire');
    expect(h).toContain('Documents demandés');
    expect(h).toContain('Prise de contact');
  });
  it('filtre dans l’adresse : puce, réinitialisation, équipe en ligne filtrée', () => {
    const h = html('/cockpit?product=SSC');
    expect(h).toContain('Retirer le filtre Produit');
    expect(h).toMatch(/Réinitialiser les filtres \(<!-- -->1<!-- -->\)/);
    // Le filtre produit réduit les chiffres (un seul lead SSC) sans retirer de télépro de l'équipe affichée.
    expect(h).toMatch(/Documents demandés<\/span><span[^>]*>1</);
  });
  it('filtre d’équipe : message sur la file tampon', () => {
    expect(html('/cockpit?team=t1')).toContain('La file tampon n’appartient à aucune équipe');
  });
  it('alertes KPI : carte avec fenêtre, règle et lien vers le rapport ; absente sans alerte', () => {
    const withRule = { ...data, kpiRules: [{ id: 'a_1', metric: 'excludedRate', mode: 'value', op: 'gte', threshold: 0, minVolume: 1, days: 0, level: 'critical', active: true }] } as unknown as CockpitData;
    const h = renderToString(<MemoryRouter><CockpitView data={withRule} role="manager" /></MemoryRouter>);
    expect(h).toContain('aria-label="Alertes KPI"');
    expect(h).toContain('Évaluées sur les');
    expect(h).toContain('Voir le rapport');
    expect(html()).not.toContain('aria-label="Alertes KPI"');
  });
  it('alerte système : planificateur arrêté depuis plus de 15 minutes, jamais de fausse alerte sans trace', () => {
    const stale = { ...data, scheduler: { lastRunAtMs: NOW - 30 * 60_000, statusReturn: null } } as CockpitData;
    expect(renderToString(<MemoryRouter><CockpitView data={stale} role="manager" /></MemoryRouter>)).toContain('Planificateur serveur arrêté');
    const fresh = { ...data, scheduler: { lastRunAtMs: NOW - 60_000, statusReturn: null } } as CockpitData;
    expect(renderToString(<MemoryRouter><CockpitView data={fresh} role="manager" /></MemoryRouter>)).not.toContain('Planificateur serveur arrêté');
    expect(html()).not.toContain('Planificateur serveur arrêté');
  });
});
