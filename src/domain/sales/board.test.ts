import { describe, expect, it } from 'vitest';
import { buildSaleBoard, FINANCIAL_STATES, saleColumn, saleProducts, SIGNATURE_STATES } from './board';
import type { LeadRow } from '../leads/leadList';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 8, 12, 0);

const row = (id: string, over: Partial<LeadRow> = {}): LeadRow => ({
  id, fullName: `Client ${id}`, phone: '+33612345678', email: null, city: 'Lyon', postalCode: '69003', campaignId: null, productCode: 'PAC', status: 'converted', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 48 * H, slaStartedAtMs: null, slaStoppedAtMs: null, nextAction: null, documentsState: 'complete',
  duplicate: false, excluded: false, ownerName: 'Sarah', campaignName: 'PAC IDF',
  commercialState: 'sale_committed', financialState: 'none',
  conversion: { state: 'confirmed', clientId: '2612345', dossierId: `cl_${id}` },
  montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1_599_000, remainderCents: 349_000, updatedAtMs: NOW - 5 * H },
  ...over,
});
const F = { search: '', product: '', mineOnly: false, uid: 'u1', nowMs: NOW };
const ids = (rows: LeadRow[]) => rows.map((r) => r.id);

describe('colonne d’une vente (§25.7)', () => {
  it('non signée : à signer, quelle que soit la phase de la vente', () => {
    for (const commercialState of ['none', 'sale_committed', 'offer_sent']) expect(saleColumn(row('a', { commercialState }))).toBe('to_sign');
  });
  it('signée sans paiement ni financement confirmé : à sécuriser', () => {
    for (const financialState of ['none', 'deposit_expected', 'deposit_received', 'financing_in_progress', 'financing_refused']) expect(saleColumn(row('a', { commercialState: 'signed', financialState }))).toBe('to_secure');
  });
  it('signée ET paiement confirmé ou financement accepté : sécurisée', () => {
    expect(saleColumn(row('a', { commercialState: 'signed', financialState: 'payment_confirmed' }))).toBe('secured');
    expect(saleColumn(row('b', { commercialState: 'signed', financialState: 'financing_accepted' }))).toBe('secured');
  });
  it('un paiement confirmé sans signature ne sécurise rien', () => expect(saleColumn(row('a', { commercialState: 'offer_sent', financialState: 'payment_confirmed' }))).toBe('to_sign'));
  it('annulée, rétractée, exclue ou sans vente : dans aucune colonne', () => {
    expect(saleColumn(row('a', { commercialState: 'cancelled' }))).toBeNull();
    expect(saleColumn(row('b', { commercialState: 'retracted' }))).toBeNull();
    expect(saleColumn(row('c', { excluded: true }))).toBeNull();
    expect(saleColumn(row('d', { conversion: undefined }))).toBeNull();
  });
  it('un lead « Converti » ou « Transmission en cours » a bien une vente', () => {
    expect(saleColumn(row('a', { status: 'transmitting', conversion: { state: 'pending', clientId: null, dossierId: null } }))).toBe('to_sign');
  });
});

describe('tableau des ventes', () => {
  const rows = [
    row('old', { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 72 * H } }),
    row('new', { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - H } }),
    row('sig-pay', { commercialState: 'signed', financialState: 'deposit_expected' }),
    row('sig-fin', { commercialState: 'signed', financialState: 'financing_in_progress' }),
    row('sig-ref', { commercialState: 'signed', financialState: 'financing_refused' }),
    row('sec1', { commercialState: 'signed', financialState: 'payment_confirmed', montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 10 * H } }),
    row('sec2', { commercialState: 'signed', financialState: 'financing_accepted', montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 2 * H } }),
    row('gone', { commercialState: 'cancelled' }),
    row('nosale', { conversion: undefined, status: 'file_building' }),
  ];
  it('répartit les ventes dans les trois colonnes', () => {
    const b = buildSaleBoard(rows, F);
    expect(ids(b.columns.to_sign).sort()).toEqual(['new', 'old']);
    expect(ids(b.columns.to_secure).sort()).toEqual(['sig-fin', 'sig-pay', 'sig-ref']);
    expect(ids(b.columns.secured).sort()).toEqual(['sec1', 'sec2']);
  });
  it('à traiter : la plus ancienne d’abord ; sécurisées : la plus récente d’abord', () => {
    const b = buildSaleBoard(rows, F);
    expect(ids(b.columns.to_sign)).toEqual(['old', 'new']);
    expect(ids(b.columns.secured)).toEqual(['sec2', 'sec1']);
  });
  it('les chiffres des cartes sont ceux des colonnes', () => {
    const { kpis, columns } = buildSaleBoard(rows, F);
    expect(kpis.toSign).toBe(columns.to_sign.length);
    expect(kpis.secured).toBe(columns.secured.length);
    expect(kpis.financingInProgress).toBe(1);
    // Paiements en attente : signées, hors financement en cours ou refusé.
    expect(kpis.paymentsPending).toBe(1);
  });
  it('« Mes ventes uniquement »', () => {
    const mixed = [row('mine'), row('other', { ownerId: 'u2' })];
    expect(ids(buildSaleBoard(mixed, { ...F, mineOnly: true }).columns.to_sign)).toEqual(['mine']);
    expect(ids(buildSaleBoard(mixed, F).columns.to_sign).sort()).toEqual(['mine', 'other']);
  });
  it('filtre par produit', () => {
    const mixed = [row('pac'), row('ssc', { productCode: 'SSC' })];
    expect(ids(buildSaleBoard(mixed, { ...F, product: 'SSC' }).columns.to_sign)).toEqual(['ssc']);
    expect(saleProducts(mixed)).toEqual(['PAC', 'SSC']);
  });
  it('recherche : nom (accents ignorés), ville, numéro de dossier, téléphone', () => {
    const mixed = [row('a', { fullName: 'Éloïse Martin', city: 'Brest' }), row('b', { fullName: 'Paul', phone: '+33699887766', conversion: { state: 'confirmed', clientId: '2699999', dossierId: 'x' } })];
    expect(ids(buildSaleBoard(mixed, { ...F, search: 'eloise' }).columns.to_sign)).toEqual(['a']);
    expect(ids(buildSaleBoard(mixed, { ...F, search: 'brest' }).columns.to_sign)).toEqual(['a']);
    expect(ids(buildSaleBoard(mixed, { ...F, search: '2699999' }).columns.to_sign)).toEqual(['b']);
    expect(ids(buildSaleBoard(mixed, { ...F, search: '0699 88' }).columns.to_sign)).toEqual([]); // 0699… ≠ +33699…
    expect(ids(buildSaleBoard(mixed, { ...F, search: '699887' }).columns.to_sign)).toEqual(['b']);
  });
  it('aucune vente : colonnes vides, chiffres à zéro', () => {
    expect(buildSaleBoard([], F)).toEqual({ columns: { to_sign: [], to_secure: [], secured: [] }, kpis: { toSign: 0, paymentsPending: 0, financingInProgress: 0, secured: 0 } });
  });
});

describe('filtres règlement et ancienneté', () => {
  const rows = [
    row('cash', { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 2 * H, financingMode: 'cash' } }),
    row('credit', { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 3 * 24 * H, financingMode: 'credit' } }),
    row('old', { montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 10 * 24 * H } }),
  ];
  it('mode de règlement : comptant (y compris vente ancienne sans mode) ou crédit', () => {
    expect(ids(buildSaleBoard(rows, { ...F, payment: 'credit' }).columns.to_sign)).toEqual(['credit']);
    expect(ids(buildSaleBoard(rows, { ...F, payment: 'cash' }).columns.to_sign).sort()).toEqual(['cash', 'old']);
    expect(ids(buildSaleBoard(rows, { ...F, payment: '' }).columns.to_sign)).toHaveLength(3);
  });
  it('ancienneté : moins d’un jour, 1 à 7 jours, plus de 7 jours', () => {
    expect(ids(buildSaleBoard(rows, { ...F, age: 'day' }).columns.to_sign)).toEqual(['cash']);
    expect(ids(buildSaleBoard(rows, { ...F, age: 'week' }).columns.to_sign)).toEqual(['credit']);
    expect(ids(buildSaleBoard(rows, { ...F, age: 'older' }).columns.to_sign)).toEqual(['old']);
  });
  it('les filtres se cumulent', () => {
    expect(ids(buildSaleBoard(rows, { ...F, payment: 'cash', age: 'older' }).columns.to_sign)).toEqual(['old']);
    expect(ids(buildSaleBoard(rows, { ...F, payment: 'credit', age: 'day' }).columns.to_sign)).toEqual([]);
  });
});

describe('sécurisées ce mois-ci (fig. 39)', () => {
  const secured = (id: string, securedAtMs: number | undefined, updatedAtMs = NOW - 40 * 24 * H) =>
    row(id, { commercialState: 'signed', financialState: 'payment_confirmed', securedAtMs, montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs } });
  it('seules les ventes sécurisées ce mois figurent dans la colonne et le chiffre', () => {
    const b = buildSaleBoard([secured('now', NOW - 2 * H), secured('last-month', NOW - 45 * 24 * H)], F);
    expect(ids(b.columns.secured)).toEqual(['now']);
    expect(b.kpis.secured).toBe(1);
  });
  it('vente ancienne sans date de sécurisation : la date de dernière mise à jour fait foi', () => {
    expect(ids(buildSaleBoard([secured('legacy', undefined, NOW - 3 * H)], F).columns.secured)).toEqual(['legacy']);
    expect(ids(buildSaleBoard([secured('legacy', undefined, NOW - 60 * 24 * H)], F).columns.secured)).toEqual([]);
  });
  it('la plus récemment sécurisée d’abord', () => {
    expect(ids(buildSaleBoard([secured('a', NOW - 5 * H), secured('b', NOW - H)], F).columns.secured)).toEqual(['b', 'a']);
  });
  it('un mois passé reste « sécurisé » mais disparaît du tableau : le suivi se poursuit ailleurs', () => {
    expect(saleColumn(secured('x', NOW - 90 * 24 * H))).toBe('secured');
  });
});

describe('libellés', () => {
  it('couvrent tous les états commerciaux et financiers du modèle', () => {
    for (const k of ['none', 'sale_committed', 'offer_sent', 'signed', 'cancelled', 'retracted']) expect(SIGNATURE_STATES[k]).toBeDefined();
    for (const k of ['none', 'deposit_expected', 'deposit_received', 'financing_in_progress', 'financing_accepted', 'financing_refused', 'payment_confirmed']) expect(FINANCIAL_STATES[k]).toBeDefined();
  });
  it('un financement refusé est rouge, jamais compté comme financé', () => expect(FINANCIAL_STATES.financing_refused.tone).toBe('red'));
});
