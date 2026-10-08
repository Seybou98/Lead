import { describe, expect, it } from 'vitest';
import { agoShort, buildBoard, checkCard, columnOf, completeCard, dayAt, NO_BOARD_FILTERS, productsOf, relaunchCard, type LeadDocsInfo } from './board';
import type { LeadListItem } from '../leads/leadList';

// Mercredi 7 octobre 2026, 10:00 à Paris.
const NOW = new Date(2026, 9, 7, 10, 0, 0).getTime();
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const docs = (over: Partial<LeadDocsInfo> = {}): LeadDocsInfo => ({
  expected: 4, received: 0, conform: 0, mandatory: 3, mandatoryConform: 0, toCheck: 0,
  missing: [{ code: 'identity', status: 'expected', koReason: null }, { code: 'tax_notice', status: 'expected', koReason: null }],
  lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: NOW - 3 * DAY, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0,
  ...over,
});

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'awaiting_documents',
  temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 10 * DAY, slaStartedAtMs: null, slaStoppedAtMs: null,
  nextAction: null, documentsState: 'requested', docs: docs(), duplicate: false, excluded: false,
  ...over,
});

describe('columnOf', () => {
  it('rien reçu ou partiel : à relancer', () => {
    expect(columnOf(lead('a'), NOW)).toBe('relaunch');
    expect(columnOf(lead('a', { documentsState: 'partial', docs: docs({ received: 1, conform: 1 }) }), NOW)).toBe('relaunch');
  });
  it('une pièce en attente de contrôle : à contrôler, même si d\'autres manquent', () => {
    expect(columnOf(lead('a', { documentsState: 'partial', docs: docs({ toCheck: 1 }) }), NOW)).toBe('check');
  });
  it('pièce rejetée, rien à contrôler : à relancer (à redemander)', () => {
    expect(columnOf(lead('a', { documentsState: 'incomplete_non_conform', docs: docs({ missing: [{ code: 'identity', status: 'non_conform', koReason: 'unreadable' }] }) }), NOW)).toBe('relaunch');
  });
  it('dossier complet : complets ; au montage, seulement le jour où il est devenu complet', () => {
    const complete = { documentsState: 'complete' as const, docs: docs({ completedAtMs: NOW - H, missing: [] }) };
    expect(columnOf(lead('a', { ...complete, status: 'file_ready_to_build' }), NOW)).toBe('complete');
    expect(columnOf(lead('a', { ...complete, status: 'file_building' }), NOW)).toBe('complete');
    expect(columnOf(lead('a', { ...complete, status: 'file_building', docs: docs({ completedAtMs: NOW - 2 * DAY, missing: [] }) }), NOW)).toBeNull();
  });
  it('clôturé, hors du flux documentaire ou sans document demandé : absent', () => {
    expect(columnOf(lead('a', { status: 'not_interested' }), NOW)).toBeNull();
    expect(columnOf(lead('a', { status: 'interested' }), NOW)).toBeNull();
    expect(columnOf(lead('a', { documentsState: 'none', docs: undefined }), NOW)).toBeNull();
    expect(columnOf(lead('a', { docs: undefined }), NOW)).toBeNull();
  });
});

describe('buildBoard', () => {
  const items = [
    lead('r-old', { docs: docs({ lastRequestAtMs: NOW - 5 * DAY }) }),
    lead('r-new', { docs: docs({ lastRequestAtMs: NOW - DAY }), productCode: 'SSC' }),
    lead('c1', { documentsState: 'received_to_check', docs: docs({ toCheck: 2, lastReceivedAtMs: NOW - 2 * H }), ownerId: 'u2' }),
    lead('c2', { documentsState: 'received_to_check', docs: docs({ toCheck: 1, lastReceivedAtMs: NOW - 10 * MIN }) }),
    lead('ok-today', { documentsState: 'complete', status: 'file_ready_to_build', docs: docs({ completedAtMs: NOW - H, missing: [] }) }),
    lead('ok-building', { documentsState: 'complete', status: 'file_building', docs: docs({ completedAtMs: NOW - 2 * H, missing: [] }) }),
    lead('ok-old', { documentsState: 'complete', status: 'file_ready_to_build', docs: docs({ completedAtMs: NOW - 3 * DAY, missing: [] }) }),
    lead('closed', { status: 'ineligible', docs: docs({ completedAtMs: NOW - H }) }),
  ];
  const ids = (l: LeadListItem[]) => l.map((x) => x.id);

  it('répartit en colonnes ; compte les dossiers complets du jour (y compris au montage, jamais clôturés)', () => {
    const b = buildBoard(items, NO_BOARD_FILTERS, 'u1', NOW);
    expect(ids(b.relaunch)).toEqual(['r-old', 'r-new']);
    expect(ids(b.check)).toEqual(['c1', 'c2']);
    expect(ids(b.complete)).toEqual(['ok-today', 'ok-building', 'ok-old']);
    expect(b.completeToday).toBe(2);
  });
  it('ancienneté : plus anciens d\'abord, ou plus récents', () => {
    expect(ids(buildBoard(items, { ...NO_BOARD_FILTERS, order: 'newest' }, 'u1', NOW).relaunch)).toEqual(['r-new', 'r-old']);
  });
  it('filtre produit, recherche sans accent ni casse, mes dossiers', () => {
    expect(ids(buildBoard(items, { ...NO_BOARD_FILTERS, product: 'SSC' }, 'u1', NOW).relaunch)).toEqual(['r-new']);
    expect(ids(buildBoard(items, { ...NO_BOARD_FILTERS, search: 'CLIENT C1' }, 'u1', NOW).check)).toEqual(['c1']);
    expect(ids(buildBoard(items, { ...NO_BOARD_FILTERS, mineOnly: true }, 'u1', NOW).check)).toEqual(['c2']);
  });
  it('aucun dossier : colonnes vides', () => expect(buildBoard([], NO_BOARD_FILTERS, 'u1', NOW)).toEqual({ relaunch: [], check: [], complete: [], completeToday: 0 }));
  it('produits distincts triés', () => expect(productsOf(items)).toEqual(['PAC', 'SSC']));
});

describe('libellés de carte', () => {
  it('relance : nombre de pièces manquantes en pastilles, ancienneté de la demande', () => {
    const c = relaunchCard(lead('a'), NOW);
    expect(c).toMatchObject({ timing: 'Depuis 3 jours', headline: '2 pièces manquantes', reask: false });
    expect(c.chips).toEqual(["Pièce d'identité", "Avis d'imposition"]);
  });
  it('une seule pièce manquante : nommée', () => {
    expect(relaunchCard(lead('a', { docs: docs({ missing: [{ code: 'tax_notice', status: 'expected', koReason: null }] }) }), NOW).headline).toBe("Avis d'imposition manquant");
  });
  it('pièce rejetée : motif en détail, bouton « redemander »', () => {
    const c = relaunchCard(lead('a', { docs: docs({ missing: [{ code: 'identity', status: 'non_conform', koReason: 'unreadable' }, { code: 'tax_notice', status: 'expected', koReason: null }] }) }), NOW);
    expect(c).toMatchObject({ headline: "Pièce d'identité non conforme", detail: 'Document illisible', reask: true, chips: [] });
  });
  it('heure promise : elle remplace l\'ancienneté', () => {
    expect(relaunchCard(lead('a', { docs: docs({ promisedAtMs: NOW + 6 * H }) }), NOW).timing).toMatch(/^Promis aujourd'hui à 16:00$/);
  });
  it('à contrôler : tout reçu, ou nouvelles pièces', () => {
    expect(checkCard(lead('a', { docs: docs({ received: 4, toCheck: 4, missing: [], lastReceivedAtMs: NOW - 12 * MIN }) }), NOW)).toEqual({ timing: 'Reçus il y a 12 min', headline: '4/4 reçus', allReceived: true });
    expect(checkCard(lead('a', { docs: docs({ received: 3, toCheck: 3, lastReceivedAtMs: NOW - H }) }), NOW)).toMatchObject({ timing: 'Reçus il y a 1 h', headline: '3 nouvelles pièces', allReceived: false });
  });
  it('complet : conformes, prêt à monter', () => {
    expect(completeCard(lead('a', { status: 'file_ready_to_build', docs: docs({ conform: 4, completedAtMs: NOW - 30 * MIN }) }), NOW)).toEqual({ timing: "Aujourd'hui à 09:30", headline: '4/4 conformes', ready: true });
  });
  it('durées : à l\'instant, minutes, heures, jours', () => {
    expect(agoShort(NOW, NOW)).toBe("à l'instant");
    expect(agoShort(NOW - 5 * MIN, NOW)).toBe('il y a 5 min');
    expect(agoShort(NOW - 25 * H, NOW)).toBe('il y a 1 jour');
    expect(agoShort(NOW - 3 * DAY, NOW)).toBe('il y a 3 jours');
    expect(dayAt(NOW - DAY, NOW)).toBe('Hier à 10:00');
  });
});
