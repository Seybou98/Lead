import { describe, expect, it } from 'vitest';
import { buildTxBoard, monthRange, NO_TX_FILTERS, txDateOf, txStatusOf, txSteps } from './board';
import type { LeadRow } from '../leads/leadList';

const NOW = new Date(2026, 9, 9, 12, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;
const docs = (mandatory: number, conform: number) => ({ expected: mandatory, received: mandatory, conform, mandatory, mandatoryConform: conform, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: null, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0 });
const row = (id: string, over: Partial<LeadRow> = {}): LeadRow => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'file_ready', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 5 * DAY, slaStartedAtMs: null, slaStoppedAtMs: null, nextAction: null,
  documentsState: 'complete', duplicate: false, excluded: false, ownerName: 'Sarah', campaignName: '—', docs: docs(6, 6), ...over,
});
const montage = (blocking: number, updatedAtMs = NOW - H) => ({ validationState: 'none', blocking, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs });
const done = (convertedAtMs: number) => ({ status: 'converted' as const, conversion: { state: 'confirmed', clientId: '2612345', dossierId: 'cl_x', convertedAtMs } });
const MONTH = monthRange(NOW);
const board = (rows: LeadRow[], f = NO_TX_FILTERS) => buildTxBoard(rows, f, MONTH);

describe('statut d’une ligne', () => {
  it('prêt, bloqué, en attente, transmis', () => {
    expect(txStatusOf(row('a', { status: 'file_ready' }))).toBe('ready');
    expect(txStatusOf(row('b', { status: 'transmission_error' }))).toBe('blocked');
    expect(txStatusOf(row('c', { status: 'transmitting' }))).toBe('pending');
    expect(txStatusOf(row('d', { status: 'manager_validation' }))).toBe('pending');
    expect(txStatusOf(row('e', done(NOW)))).toBe('done');
  });
  it('montage : contrôle bloquant = bloqué ; sans blocage = en attente', () => {
    expect(txStatusOf(row('a', { status: 'file_building', montage: montage(2) }))).toBe('blocked');
    expect(txStatusOf(row('b', { status: 'file_building', montage: montage(0) }))).toBe('pending');
    expect(txStatusOf(row('c', { status: 'file_building' }))).toBe('pending');
  });
  it('lead converti sans transmission confirmée : en attente ; sans conversion : hors écran', () => {
    expect(txStatusOf(row('a', { status: 'converted', conversion: { state: 'pending', clientId: null, dossierId: null } }))).toBe('pending');
    expect(txStatusOf(row('b', { status: 'converted' }))).toBeNull();
  });
  it('autres statuts : hors écran', () => {
    for (const s of ['new', 'callback', 'interested', 'awaiting_documents', 'file_ready_to_build', 'not_interested'] as const) expect(txStatusOf(row('x', { status: s }))).toBeNull();
  });
});

describe('cartes de synthèse', () => {
  const rows = [
    row('d1', done(NOW - 2 * DAY)),
    row('d2', done(NOW - DAY)),
    row('d-old', done(NOW - 40 * DAY)),
    row('err', { status: 'transmission_error', montage: montage(0, NOW - 3 * H) }),
    row('wait', { status: 'transmitting' }),
    row('valid', { status: 'manager_validation' }),
    row('block', { status: 'file_building', montage: montage(1) }),
    row('ready', { status: 'file_ready' }),
  ];
  it('transmis ce mois, en attente, bloqué', () => {
    const k = board(rows).kpis;
    expect(k.done).toBe(2);
    expect(k.pending).toBe(2);
    expect(k.blocked).toBe(2);
  });
  it('taux de réussite = transmis / (transmis + en erreur) sur la période', () => {
    expect(board(rows).kpis.successRate).toBe(66.7);
  });
  it('aucune tentative : pas de taux inventé', () => {
    expect(board([row('r', { status: 'file_ready' })]).kpis.successRate).toBeNull();
  });
  it('un lead exclu n’est jamais compté', () => {
    expect(board([row('x', { ...done(NOW), excluded: true })]).kpis.done).toBe(0);
  });
  it('les chiffres des cartes viennent des mêmes lignes que le tableau', () => {
    const b = board(rows, { ...NO_TX_FILTERS, status: 'pending' });
    expect(b.filtered).toHaveLength(b.kpis.pending);
  });
});

describe('tableau', () => {
  const rows = [
    row('ready', { status: 'file_ready', montage: montage(0, NOW - H) }),
    row('block', { status: 'file_building', montage: montage(1, NOW - 5 * H) }),
    row('done', done(NOW - 2 * H)),
    row('wait', { status: 'transmitting', montage: montage(0, NOW - 3 * H) }),
    row('ssc', { status: 'file_ready', productCode: 'SSC', ownerId: 'u2', ownerName: 'Julie' }),
  ];
  it('bloqués d’abord, puis prêts, en attente, transmis ; le plus récent d’abord', () => {
    expect(board(rows).filtered.map((l) => l.id)).toEqual(['block', 'ready', 'ssc', 'wait', 'done']);
  });
  it('filtres statut, produit, télépro', () => {
    expect(board(rows, { ...NO_TX_FILTERS, status: 'ready' }).filtered.map((l) => l.id)).toEqual(['ready', 'ssc']);
    expect(board(rows, { ...NO_TX_FILTERS, product: 'SSC' }).filtered.map((l) => l.id)).toEqual(['ssc']);
    expect(board(rows, { ...NO_TX_FILTERS, owner: 'u2' }).filtered.map((l) => l.id)).toEqual(['ssc']);
  });
  it('filtre de dates : sur la date de transmission ou de dernière mise à jour', () => {
    const f = { ...NO_TX_FILTERS, fromMs: NOW - 4 * H, toMs: NOW };
    expect(board(rows, f).filtered.map((l) => l.id)).toEqual(['ready', 'wait', 'done']);
  });
  it('liste des produits présents, triée', () => {
    expect(board(rows).products).toEqual(['PAC', 'SSC']);
  });
  it('dernière transmission réussie', () => {
    expect(board([row('a', done(NOW - 3 * H)), row('b', done(NOW - H))]).lastDone?.id).toBe('b');
    expect(board([row('r')]).lastDone).toBeNull();
  });
  it('date de référence : transmission, sinon mise à jour du dossier, sinon réception', () => {
    expect(txDateOf(row('a', done(7)))).toBe(7);
    expect(txDateOf(row('b', { montage: montage(0, 9) }))).toBe(9);
    expect(txDateOf(row('c'))).toBe(NOW - 5 * DAY);
  });
});

describe('parcours d’un dossier (fig. 44)', () => {
  const states = (l: Partial<LeadRow>) => txSteps(row('x', l)).map((s) => s.state);
  it('dossier transmis : tout validé', () => expect(states(done(NOW))).toEqual(['done', 'done', 'done', 'done']));
  it('prêt : le client reste à créer', () => expect(states({ status: 'file_ready' })).toEqual(['done', 'done', 'done', 'current']));
  it('documents conformes mais dossier non validé : « Dossier validé » en cours', () => expect(states({ status: 'file_building' })).toEqual(['done', 'done', 'current', 'todo']));
  it('documents incomplets : « Documents complets » en cours', () => expect(states({ status: 'file_building', docs: docs(6, 4) })).toEqual(['done', 'current', 'todo', 'todo']));
  it('libellés', () => {
    const s = txSteps(row('x', { status: 'file_ready' }));
    expect(s.map((x) => x.caption)).toEqual(['Validé', 'Validé', 'Validé', 'En cours']);
    expect(s.map((x) => x.label)).toEqual(['Lead qualifié', 'Documents complets', 'Dossier validé', 'Client créé']);
  });
});

describe('période', () => {
  it('mois courant, bornes incluses', () => {
    const r = monthRange(NOW);
    expect(new Date(r.fromMs).getDate()).toBe(1);
    expect(new Date(r.toMs).getMonth()).toBe(9);
    expect(new Date(r.toMs + 1).getMonth()).toBe(10);
  });
});
