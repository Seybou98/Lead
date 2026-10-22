import { describe, expect, it } from 'vitest';
import { activeFilterCount, applyLeadFilters, applyRowFilters, filterOptions, filtersFromParams, NO_COCKPIT_FILTERS, paramsWithFilters } from './filters';
import { buildDocViews, buildPipeline } from './pipeline';
import { buildCockpit } from './cockpit';
import type { LeadListItem } from '../leads/leadList';
import type { UserRow } from '../admin/userRows';

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;
const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '75011', campaignId: 'c1', productCode: 'PAC', status: 'interested', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 2 * H, slaStartedAtMs: null, slaStoppedAtMs: NOW - H, nextAction: null,
  documentsState: 'none', duplicate: false, excluded: false, ...over,
});
const row = (uid: string, over: Partial<UserRow> = {}): UserRow => ({ uid, name: `Télépro ${uid}`, email: '', role: 'telepro', accountActive: true, hasProfile: true, teamIds: [], teamNames: [], products: [], zones: [], newLeads: 0, cap: 10, connected: true, operationalStatus: 'available', distribution: 'active', ...over });
const rows = [row('u1', { teamIds: ['t1'], teamNames: ['Équipe Paris'] }), row('u2', { teamIds: ['t2'], teamNames: ['Équipe Lyon'] })];
const docs = (o: Partial<NonNullable<LeadListItem['docs']>> = {}): NonNullable<LeadListItem['docs']> => ({ expected: 4, received: 1, conform: 1, mandatory: 3, mandatoryConform: 1, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: NOW - 2 * DAY, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0, ...o });

describe('filtres du cockpit', () => {
  const items = [
    lead('a'),
    lead('b', { ownerId: 'u2', productCode: 'SSC', campaignId: 'c2', postalCode: '69003' }),
    lead('buf', { ownerId: null, assignmentState: 'buffer', status: 'new' }),
  ];
  it('aucun filtre : tout passe', () => expect(applyLeadFilters(items, rows, NO_COCKPIT_FILTERS).map((l) => l.id)).toEqual(['a', 'b', 'buf']));
  it('produit, campagne, zone', () => {
    expect(applyLeadFilters(items, rows, { ...NO_COCKPIT_FILTERS, product: 'SSC' }).map((l) => l.id)).toEqual(['b']);
    expect(applyLeadFilters(items, rows, { ...NO_COCKPIT_FILTERS, campaign: 'c1' }).map((l) => l.id)).toEqual(['a', 'buf']);
    expect(applyLeadFilters(items, rows, { ...NO_COCKPIT_FILTERS, zone: '69' }).map((l) => l.id)).toEqual(['b']);
  });
  it('équipe : les leads de ses membres ; la file tampon n’appartient à aucune équipe', () => {
    expect(applyLeadFilters(items, rows, { ...NO_COCKPIT_FILTERS, team: 't1' }).map((l) => l.id)).toEqual(['a']);
  });
  it('filtres cumulés : tous doivent correspondre', () => {
    expect(applyLeadFilters(items, rows, { team: 't1', product: 'SSC', campaign: '', zone: '' })).toEqual([]);
  });
  it('lignes d’équipe : seulement les membres de l’équipe filtrée', () => {
    expect(applyRowFilters(rows, { ...NO_COCKPIT_FILTERS, team: 't2' }).map((r) => r.uid)).toEqual(['u2']);
    expect(applyRowFilters(rows, NO_COCKPIT_FILTERS)).toHaveLength(2);
  });
  it('compteur de filtres actifs', () => expect(activeFilterCount({ team: 't1', product: '', campaign: 'c1', zone: '' })).toBe(2));
  it('adresse : aller-retour, retrait d’un filtre, autres paramètres conservés', () => {
    const f = { team: 't1', product: 'PAC', campaign: '', zone: '75' };
    const p = paramsWithFilters(new URLSearchParams('periode=week'), f);
    expect(filtersFromParams(p)).toEqual(f);
    expect(p.get('periode')).toBe('week');
    const without = paramsWithFilters(p, { ...f, product: '' });
    expect(without.has('product')).toBe(false);
    expect(filtersFromParams(new URLSearchParams('team=' + 'x'.repeat(500))).team).toHaveLength(128);
  });
  it('options : seulement ce qui existe dans le périmètre', () => {
    const o = filterOptions(items, rows, new Map([['c1', 'PAC IDF']]));
    expect(o.teams.map((t) => t.name)).toEqual(['Équipe Lyon', 'Équipe Paris']);
    expect(o.products).toEqual(['PAC', 'SSC']);
    expect(o.campaigns).toEqual([{ id: 'c2', name: 'c2' }, { id: 'c1', name: 'PAC IDF' }].sort((x, y) => x.name.localeCompare(y.name, 'fr')));
    expect(o.zones.map((z) => z.id)).toEqual(['69', '75']);
  });
  it('le cockpit construit sur des leads filtrés ne compte que ces leads', () => {
    const slaLate = (id: string, over: Partial<LeadListItem>) => lead(id, { status: 'new', slaStartedAtMs: NOW - 12 * 60_000, slaStoppedAtMs: null, receivedAtMs: NOW - 12 * 60_000, ...over });
    const all = [slaLate('x', {}), slaLate('y', { productCode: 'SSC', ownerId: 'u2' })];
    expect(buildCockpit({ items: all, rows, nowMs: NOW, period: 'today' }).danger).toHaveLength(2);
    expect(buildCockpit({ items: applyLeadFilters(all, rows, { ...NO_COCKPIT_FILTERS, product: 'SSC' }), rows, nowMs: NOW, period: 'today' }).danger.map((i) => i.lead.id)).toEqual(['y']);
  });
});

describe('pipeline', () => {
  const items = [
    lead('n1', { status: 'new' }), lead('n2', { status: 'new' }),
    lead('i1', { status: 'interested' }),
    lead('d1', { status: 'awaiting_documents' }), lead('d2', { status: 'missing_info' }),
    lead('b1', { status: 'file_building' }),
    lead('s1', { status: 'converted' }),
    lead('x', { status: 'not_interested' }),
    lead('ex', { status: 'new', excluded: true }),
  ];
  it('chaque étape liste ses leads (exclus et clos hors pipeline)', () => {
    const p = buildPipeline(items, new Set(), NOW);
    const by = Object.fromEntries(p.map((s) => [s.key, s.leads.map((l) => l.id)]));
    expect(by.new).toEqual(['n1', 'n2']);
    expect(by.documents).toEqual(['d1', 'd2']);
    expect(by.building).toEqual(['b1']);
    expect(by.sold).toEqual(['s1']);
    expect(p.every((s) => s.count === s.leads.length)).toBe(true);
    expect(JSON.stringify(by)).not.toContain('"x"');
  });
  it('bloqués = leads de l’étape déjà signalés ; ancienneté moyenne', () => {
    const p = buildPipeline(items, new Set(['n1']), NOW);
    expect(p[0].blocked).toBe(1);
    expect(p[0].avgAgeMs).toBe(2 * H);
    expect(p.find((s) => s.key === 'toBuild')!.avgAgeMs).toBeNull();
  });
  it('taux de passage : plancher déduit du statut, vide sans volume', () => {
    const p = buildPipeline(items, new Set(), NOW);
    // atteint « Nouveaux » : 7 (tous les leads du pipeline), atteint « Prise de contact » : 5 (le lead nouveau n'y est pas encore)
    expect(p[0].passage).toBe(Math.round((5 / 7) * 1000) / 10);
    expect(p[p.length - 1].passage).toBeNull();
    expect(buildPipeline([], new Set(), NOW).every((s) => s.passage === null)).toBe(true);
  });
});

describe('cockpit documentaire', () => {
  const v = (items: LeadListItem[]) => buildDocViews(items, NOW);
  it('demandés : aucune pièce reçue', () => {
    const r = v([lead('a', { status: 'awaiting_documents', documentsState: 'requested', docs: docs({ received: 0, followUpCount: 2 }) })]);
    expect(r.requested.map((i) => i.lead.id)).toEqual(['a']);
    expect(r.requested[0].reason).toMatch(/4 pièces attendues, 2 relances/);
    expect(r.partial).toEqual([]);
  });
  it('partiels : reçues et manquantes, plus de 3 jours = élevé', () => {
    const r = v([lead('a', { status: 'awaiting_documents', documentsState: 'partial', docs: docs({ received: 2, lastReceivedAtMs: NOW - 4 * DAY, missing: [{ code: 'rib', status: 'expected', koReason: null }] }) })]);
    expect(r.partial[0].severity).toBe('high');
    expect(r.partial[0].reason).toMatch(/2 reçues, 1 manquante/);
  });
  it('promesses échues', () => {
    const r = v([lead('a', { status: 'awaiting_documents', documentsState: 'requested', docs: docs({ promisedAtMs: NOW - 3 * H }) }), lead('b', { status: 'awaiting_documents', documentsState: 'requested', docs: docs({ promisedAtMs: NOW + H }) })]);
    expect(r.promised.map((i) => i.lead.id)).toEqual(['a']);
    expect(r.promised[0].reason).toBe('Promesse dépassée de 3 h');
  });
  it('à contrôler et non conformes, avec la pièce et le motif', () => {
    const r = v([
      lead('c', { status: 'awaiting_documents', documentsState: 'received_to_check', docs: docs({ toCheck: 2, lastReceivedAtMs: NOW - 2 * DAY }) }),
      lead('k', { status: 'missing_info', documentsState: 'incomplete_non_conform', docs: docs({ missing: [{ code: 'id', label: 'Pièce d’identité', status: 'non_conform', koReason: 'unreadable', koReasonLabel: 'Illisible' }] }) }),
    ]);
    expect(r.toCheck.map((i) => [i.lead.id, i.severity])).toEqual([['c', 'high']]);
    expect(r.nonConform[0].reason).toBe('Pièce d’identité (Illisible)');
  });
  it('prêts à monter : dossiers complets non pris en charge', () => {
    const r = v([lead('p', { status: 'file_ready_to_build', documentsState: 'complete', docs: docs({ mandatoryConform: 3, completedAtMs: NOW - H }) })]);
    expect(r.toBuild.map((i) => i.lead.id)).toEqual(['p']);
    expect(r.requested).toEqual([]);
  });
  it('lead clos, exclu ou sans documents : absent de toutes les vues', () => {
    const r = v([lead('a', { status: 'not_interested', documentsState: 'partial', docs: docs() }), lead('b', { excluded: true, documentsState: 'partial', docs: docs() }), lead('c')]);
    expect(Object.values(r).flat()).toEqual([]);
  });
});
