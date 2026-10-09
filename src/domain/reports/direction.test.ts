import { describe, expect, it } from 'vitest';
import { buildAlerts, buildDirectionReport, countPeriod, directionRows, previousRange, scopeLeads, stageHits, stagePopulation, type ReportCampaign, type ReportFilters, type ReportSpend } from './direction';
import type { LeadListItem } from '../leads/leadList';

const DAY = 86_400_000;
const T = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const SEP = { fromMs: T(2026, 9, 1) - 12 * 3_600_000, toMs: T(2026, 10, 1) - 12 * 3_600_000 };
const AUG_END = SEP.fromMs;
const F: ReportFilters = { ...SEP, mode: 'event', sourceId: '', campaignId: '', product: '', owner: '' };
const NOW = T(2026, 9, 16);

const docs = (over: Partial<NonNullable<LeadListItem['docs']>> = {}) => ({ expected: 4, received: 4, conform: 4, mandatory: 4, mandatoryConform: 4, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: null, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0, ...over });
const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: id, phone: null, email: null, city: '', postalCode: '', campaignId: 'c1', productCode: 'PAC', status: 'new', temperature: null, assignmentState: 'assigned', bufferReason: null,
  ownerId: 'u1', receivedAtMs: T(2026, 9, 5), slaStartedAtMs: null, slaStoppedAtMs: null, nextAction: null, documentsState: 'none', duplicate: false, excluded: false, ...over,
});
const sold = (id: string, over: Partial<LeadListItem> = {}) => lead(id, { status: 'converted', documentsState: 'complete', commercialState: 'sale_committed', docs: docs({ completedAtMs: T(2026, 9, 8) }), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 9, 10) }, montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: T(2026, 9, 10) }, ...over });
const camps: ReportCampaign[] = [{ id: 'c1', name: 'PAC IDF', sourceId: 'meta', productCode: 'PAC' }, { id: 'c2', name: 'SSC Est', sourceId: 'google', productCode: 'SSC' }];
const spend = (campaignId: string, amountCents: number, atMs: number): ReportSpend => ({ campaignId, amountCents, atMs });
const report = (leads: LeadListItem[], spends: ReportSpend[] = [], f: Partial<ReportFilters> = {}, nowMs = NOW + 20 * DAY) => buildDirectionReport({ leads, spends, campaigns: camps, filters: { ...F, ...f }, nowMs });

describe('étapes d’un lead', () => {
  it('lead valide qui avance : reçu, valide, contacté, intéressé, documents', () => {
    const h = stageHits(lead('a', { status: 'awaiting_documents', documentsState: 'requested', slaStoppedAtMs: T(2026, 9, 6) }));
    expect(h.valid.reached && h.contacted.reached && h.interested.reached && h.docsRequested.reached).toBe(true);
    expect(h.docsComplete.reached).toBe(false);
    expect(h.contacted.atMs).toBe(T(2026, 9, 6));
  });
  it('« pas de réponse » n’est pas un contact', () => expect(stageHits(lead('a', { status: 'nr' })).contacted.reached).toBe(false));
  it('doublon, faux lead, exclu : comptés reçus seulement', () => {
    for (const over of [{ duplicate: true }, { excluded: true }, { status: 'fake_lead' as const }]) {
      const h = stageHits(lead('a', { documentsState: 'complete', ...over }));
      expect(h.received.reached).toBe(true);
      expect([h.valid, h.contacted, h.docsComplete, h.sales].some((x) => x.reached)).toBe(false);
    }
  });
  it('vente nette : annulée ne compte pas', () => {
    expect(stageHits(sold('a')).sales.reached).toBe(true);
    expect(stageHits(sold('b', { commercialState: 'cancelled' })).sales.reached).toBe(false);
    expect(stageHits(sold('c', { mainStatus: { stage: 'cancelled', label: 'x', changedAtMs: null } })).sales.reached).toBe(false);
  });
  it('sans date d’étape : la réception fait foi, jamais une date plus favorable', () => {
    expect(stageHits(lead('a', { documentsState: 'complete', docs: docs() })).docsComplete.atMs).toBe(T(2026, 9, 5));
  });
});

describe('modes événement et cohorte (§22.2)', () => {
  // Reçu le 28 août, vendu le 3 septembre : septembre en événement, août en cohorte.
  const l = sold('x', { receivedAtMs: T(2026, 8, 28), docs: docs({ completedAtMs: T(2026, 9, 2) }), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 9, 3) } });
  const count = (mode: 'event' | 'cohort', from: number, to: number) => countPeriod([l], [], camps, { ...F, mode }, from, to).counts;
  it('événement : la vente est dans septembre, la réception en août', () => {
    expect(count('event', SEP.fromMs, SEP.toMs)).toMatchObject({ sales: 1, received: 0 });
    expect(count('event', AUG_END - 31 * DAY, AUG_END)).toMatchObject({ sales: 0, received: 1 });
  });
  it('cohorte : tout est rattaché à août', () => {
    expect(count('cohort', AUG_END - 31 * DAY, AUG_END)).toMatchObject({ sales: 1, received: 1, docsComplete: 1 });
    expect(count('cohort', SEP.fromMs, SEP.toMs)).toMatchObject({ sales: 0, received: 0 });
  });
});

describe('cartes et comparaison', () => {
  const leads = [
    ...Array.from({ length: 4 }, (_, i) => lead(`n${i}`, { status: 'interested', slaStoppedAtMs: T(2026, 9, 6) })),
    lead('dup', { duplicate: true }),
    sold('s1'),
    sold('s2'),
  ];
  const prevLeads = [lead('p1', { receivedAtMs: T(2026, 8, 10), slaStoppedAtMs: T(2026, 8, 11), status: 'interested' }), sold('ps', { receivedAtMs: T(2026, 8, 12), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 8, 20) }, montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: T(2026, 8, 20) }, docs: docs({ completedAtMs: T(2026, 8, 15) }) })];
  it('reçus, valides, ventes ; doublon à part', () => {
    const r = report(leads);
    expect(r.current.counts).toMatchObject({ received: 7, valid: 6, sales: 2 });
  });
  it('dépenses, coût par lead valide et par vente', () => {
    const r = report(leads, [spend('c1', 60_000, T(2026, 9, 7)), spend('c1', 60_000, T(2026, 9, 14))]);
    expect(r.kpis.spendCents.value).toBe(120_000);
    expect(r.kpis.costPerLeadCents.value).toBe(20_000);
    expect(r.kpis.costPerSaleCents.value).toBe(60_000);
  });
  it('sans dépense : coûts « — » (null), jamais 0', () => {
    const r = report(leads);
    expect([r.kpis.spendCents.value, r.kpis.costPerLeadCents.value, r.kpis.costPerSaleCents.value]).toEqual([null, null, null]);
  });
  it('variation vs période précédente : volumes en %, taux en points', () => {
    const r = report([...leads, ...prevLeads]);
    expect(r.kpis.sales).toMatchObject({ value: 2, previous: 1, delta: 100, deltaUnit: '%' });
    expect(r.kpis.contactRate.deltaUnit).toBe('pts');
    expect(r.kpis.received.previous).toBe(2);
  });
  it('période précédente vide : variation inconnue (null), pas d’infini', () => {
    expect(report(leads).kpis.sales.delta).toBeNull();
  });
  it('période précédente = même durée, juste avant', () => {
    const p = previousRange(SEP);
    expect(p.toMs).toBe(SEP.fromMs);
    expect(p.toMs - p.fromMs).toBe(SEP.toMs - SEP.fromMs);
  });
  it('taux de contact : contactés / valides, avec les volumes', () => {
    const r = report(leads);
    expect(r.current.counts.contacted).toBe(6);
    expect(r.kpis.contactRate.value).toBe(100);
  });
});

describe('filtres de périmètre', () => {
  const leads = [lead('a'), lead('b', { campaignId: 'c2', productCode: 'SSC' }), lead('c', { ownerId: 'u2' }), lead('d', { campaignId: null })];
  it('source, campagne, produit, télépro', () => {
    const ids = (f: Partial<ReportFilters>) => scopeLeads(leads, { sourceId: '', campaignId: '', product: '', owner: '', ...f }, camps).map((l) => l.id);
    expect(ids({ sourceId: 'meta' })).toEqual(['a', 'c']);
    expect(ids({ sourceId: 'google' })).toEqual(['b']);
    expect(ids({ campaignId: 'c2' })).toEqual(['b']);
    expect(ids({ product: 'PAC' })).toEqual(['a', 'c', 'd']);
    expect(ids({ owner: 'u2' })).toEqual(['c']);
  });
  it('dépenses : suivent source, campagne et produit ; non attribuables à un télépro', () => {
    const sp = [spend('c1', 100, T(2026, 9, 3)), spend('c2', 200, T(2026, 9, 3)), spend('zz', 50, T(2026, 9, 3)), spend('c1', 999, T(2026, 7, 3))];
    expect(report([], sp).kpis.spendCents.value).toBe(350);
    expect(report([], sp, { sourceId: 'google' }).kpis.spendCents.value).toBe(200);
    expect(report([], sp, { product: 'PAC' }).kpis.spendCents.value).toBe(100);
    expect(report([], sp, { owner: 'u1' }).kpis.spendCents.value).toBeNull();
  });
});

describe('entonnoir', () => {
  const leads = [
    ...Array.from({ length: 10 }, (_, i) => lead(`l${i}`, { status: i < 8 ? 'interested' : 'new', slaStoppedAtMs: T(2026, 9, 6) })),
    lead('d', { duplicate: true }),
  ];
  it('volumes absolus et taux (reçus et passage)', () => {
    const f = report(leads).funnel;
    expect(f.map((s) => s.count)).toEqual([11, 10, 8, 8, 0, 0, 0, 0]);
    expect(f[0]).toMatchObject({ label: 'Leads reçus', rateOfReceived: 100, passage: null });
    expect(f[1]).toMatchObject({ rateOfReceived: 90.9, passage: 90.9 });
    expect(f[2]).toMatchObject({ passage: 80 });
  });
  it('dénominateur nul : taux null, jamais NaN', () => {
    const f = report([]).funnel;
    expect(f.every((s) => s.rateOfReceived === null && (s.passage === null))).toBe(true);
  });
});

describe('série hebdomadaire', () => {
  it('une entrée par semaine de la période, dépenses et ventes à leur date', () => {
    const r = report([sold('s1')], [spend('c1', 5000, T(2026, 9, 10)), spend('c1', 7000, T(2026, 9, 24))]);
    expect(r.weeks.length).toBeGreaterThanOrEqual(4);
    expect(r.weeks.reduce((s, w) => s + w.spendCents, 0)).toBe(12_000);
    expect(r.weeks.reduce((s, w) => s + w.sales, 0)).toBe(1);
  });
});

describe('alertes (seuil ET volume minimum, §22.8)', () => {
  const k = (cps: number | null, cpl: number | null = null, contact: number | null = null) => ({ costPerSaleCents: { value: 1, previous: 1, delta: cps, deltaUnit: '%' as const }, costPerLeadCents: { value: 1, previous: 1, delta: cpl, deltaUnit: '%' as const }, contactRate: { value: 1, previous: 1, delta: contact, deltaUnit: 'pts' as const } }) as never;
  const counts = (valid: number, sales: number, extra: Record<string, number> = {}) => ({ counts: { received: valid, valid, contacted: valid, interested: 0, docsRequested: 0, docsComplete: 0, mounted: 0, sales, ...extra }, cancelled: 0, installed: 0, invoiced: 0, spendCents: 1 }) as never;
  it('coût par vente en hausse de 20 % ou plus avec assez de ventes : critique', () => {
    const a = buildAlerts(counts(50, 5), counts(50, 5), k(32));
    expect(a[0]).toMatchObject({ id: 'cost-per-sale', level: 'critical', title: 'Coût par vente +32 %' });
  });
  it('trop peu de ventes : pas d’alerte, même au-delà du seuil', () => {
    expect(buildAlerts(counts(50, 2), counts(50, 2), k(80)).map((x) => x.id)).toEqual(['ok']);
  });
  it('coût par lead et taux de contact : volume minimum de leads valides', () => {
    expect(buildAlerts(counts(20, 0), counts(20, 0), k(null, 40, -15)).map((x) => x.id)).toEqual(['cpl', 'contact']);
    expect(buildAlerts(counts(5, 0), counts(20, 0), k(null, 40, -15)).map((x) => x.id)).toEqual(['ok']);
  });
  it('documents demandés → complets en baisse', () => {
    const a = buildAlerts(counts(20, 0, { docsRequested: 20, docsComplete: 5 }), counts(20, 0, { docsRequested: 20, docsComplete: 15 }), k(null));
    expect(a.map((x) => x.id)).toEqual(['docs']);
  });
  it('ventes annulées élevées', () => {
    const cur = { ...(counts(20, 4) as object), cancelled: 2 } as never;
    expect(buildAlerts(cur, counts(20, 4), k(null)).map((x) => x.id)).toEqual(['cancelled']);
  });
  it('rien à signaler : une ligne verte', () => {
    expect(buildAlerts(counts(20, 5), counts(20, 5), k(0, 0, 0))[0]).toMatchObject({ id: 'ok', level: 'ok' });
  });
});

describe('projection mensuelle', () => {
  it('estimation au rythme observé quand la période contient aujourd’hui', () => {
    const r = report([sold('a'), sold('b')], [], {}, T(2026, 9, 10));
    expect(r.projection).toMatchObject({ salesSoFar: 2, elapsedDays: 10, totalDays: 30, projected: 6 });
  });
  it('période passée : pas de projection', () => expect(report([sold('a')]).projection).toBeNull());
});

describe('ventes après la vente et export', () => {
  it('annulées, installées, facturées comptées sur les ventes de la période', () => {
    const r = report([sold('a', { mainStatus: { stage: 'installed', label: 'x', changedAtMs: null } }), sold('b', { mainStatus: { stage: 'invoiced', label: 'x', changedAtMs: null } }), sold('c', { commercialState: 'cancelled' })]);
    expect(r.current).toMatchObject({ installed: 2, invoiced: 1, cancelled: 1 });
    expect(r.current.counts.sales).toBe(2);
  });
  it('le CSV donne le mode de date, les cartes et l’entonnoir', () => {
    const rows = directionRows(report([sold('a')], [spend('c1', 10_000, T(2026, 9, 5))]), 'cohort');
    expect(rows[0]).toEqual(['Mode de date', 'Cohorte d’acquisition']);
    expect(rows.find((r) => r[0] === 'Dépenses (€)')?.[1]).toBe(100);
    expect(rows.some((r) => r[0] === 'Ventes')).toBe(true);
  });
});

describe('population d’un chiffre (§22.12)', () => {
  const leads = [lead('a', { status: 'interested', slaStoppedAtMs: T(2026, 9, 6) }), lead('b'), lead('c', { duplicate: true }), sold('s'), lead('old', { receivedAtMs: T(2026, 7, 1) })];
  it('la liste de chaque étape a exactement le total de l’entonnoir', () => {
    const r = report(leads);
    for (const step of r.funnel) expect(stagePopulation(leads, camps, F, step.stage)).toHaveLength(step.count);
  });
  it('mode cohorte et filtres : toujours égal au chiffre', () => {
    for (const f of [{ mode: 'cohort' as const }, { sourceId: 'meta' }, { product: 'SSC' }, { owner: 'u1' }]) {
      const r = report(leads, [], f);
      for (const step of r.funnel) expect(stagePopulation(leads, camps, { ...F, ...f }, step.stage)).toHaveLength(step.count);
    }
  });
});
