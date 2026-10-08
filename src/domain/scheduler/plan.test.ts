import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULER_RULES, dueForSlaReassign, isEngineBuffered, planEscalations, planRecycling, slaAge, type SchedLead } from './plan';

// Mercredi 7 octobre 2026, 11:00 à Paris.
const NOW = Date.parse('2026-10-07T09:00:00Z');
const MIN = 60_000;
const H = 60 * MIN;

const lead = (id: string, over: Partial<SchedLead> = {}): SchedLead => ({
  id, fullName: `Client ${id}`, status: 'new', assignmentState: 'assigned', ownerId: 'u1', managerIds: ['m1'], receivedAtMs: NOW - H, slaStartedAtMs: null, slaStoppedAtMs: NOW,
  bufferReason: null, nextAction: null, nr: { attempt: 0, cycle: 1, nextAtMs: null }, campaignId: null, productCode: 'PAC', zone: null, reassignCount: 0, lastReassignedAtMs: null, ...over,
});

describe('escalade : rappel client non effectué (+30 min)', () => {
  const cb = (lateMin: number): Partial<SchedLead> => ({ status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW - lateMin * MIN, reason: 'Rappel' } });
  it('à 30 min de retard : le manager est prévenu, sans réattribution', () => {
    const e = planEscalations([lead('a', cb(31))], NOW);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ leadId: 'a', recipientIds: ['m1'], title: 'Rappel client non effectué', sound: 'critical' });
    expect(e[0].id).toBe(`a_esc_cb_${NOW - 31 * MIN}`);
  });
  it('avant 30 min, ou rappel dans le futur : rien', () => {
    expect(planEscalations([lead('a', cb(29)), lead('b', cb(-10))], NOW)).toEqual([]);
  });
  it("un passage ultérieur donne le même identifiant (rien n'est redoublé) ; un nouveau rappel en donne un autre", () => {
    const first = planEscalations([lead('a', cb(31))], NOW)[0].id;
    const later = planEscalations([lead('a', { ...cb(31) })], NOW + 5 * MIN)[0].id;
    expect(later).toBe(first);
    const another = planEscalations([lead('a', { status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW - 90 * MIN, reason: 'Rappel' } })], NOW)[0].id;
    expect(another).not.toBe(first);
  });
});

describe('escalade : lead non attribué', () => {
  const buf = (waitMin: number): Partial<SchedLead> => ({ ownerId: null, assignmentState: 'buffer', bufferReason: 'no_candidate', receivedAtMs: NOW - waitMin * MIN, slaStoppedAtMs: null });
  it('après 15 min : alerte ; après 24 h : anomalie, avec un autre identifiant', () => {
    expect(planEscalations([lead('a', buf(10))], NOW)).toEqual([]);
    expect(planEscalations([lead('a', buf(20))], NOW)[0]).toMatchObject({ id: 'a_esc_buffer_warn', title: 'Lead non attribué' });
    expect(planEscalations([lead('a', buf(25 * 60))], NOW)[0]).toMatchObject({ id: 'a_esc_buffer_anomaly' });
  });
  it('une seule alerte par lead non attribué (pas de double avec le SLA)', () => {
    expect(planEscalations([lead('a', { ...buf(20), slaStartedAtMs: NOW - 20 * MIN })], NOW)).toHaveLength(1);
  });
});

describe('escalade : SLA, documents', () => {
  it('lead Nouveau attribué hors SLA : alerte unique', () => {
    const l = lead('a', { slaStartedAtMs: NOW - 11 * MIN, slaStoppedAtMs: null });
    expect(planEscalations([l], NOW)[0]).toMatchObject({ id: 'a_esc_sla', title: 'Lead hors SLA' });
    expect(planEscalations([lead('b', { slaStartedAtMs: NOW - 4 * MIN, slaStoppedAtMs: null })], NOW)).toEqual([]);
    expect(planEscalations([lead('c', { slaStartedAtMs: NOW - 11 * MIN })], NOW)).toEqual([]); // SLA arrêté : pris en charge
  });
  it('décision à J+14 et alerte rouge J+7 : le manager est prévenu une fois par échéance', () => {
    const dec = lead('d', { status: 'awaiting_documents', nextAction: { type: 'document_decision', dueAtMs: NOW - H, reason: '' } });
    const red = lead('r', { status: 'awaiting_documents', nextAction: { type: 'document_followup', dueAtMs: NOW - H, reason: 'Documents toujours incomplets' } });
    const plain = lead('p', { status: 'awaiting_documents', nextAction: { type: 'document_followup', dueAtMs: NOW - H, reason: 'Relancer : RIB' } });
    const future = lead('f', { status: 'awaiting_documents', nextAction: { type: 'document_decision', dueAtMs: NOW + H, reason: '' } });
    const ids = planEscalations([dec, red, plain, future], NOW).map((e) => e.id);
    expect(ids).toEqual([`d_esc_docs_decision_${NOW - H}`, `r_esc_docs_red_${NOW - H}`]);
  });
  it('sans manager, personne à prévenir : aucune escalade', () => {
    expect(planEscalations([lead('a', { managerIds: [], slaStartedAtMs: NOW - 11 * MIN, slaStoppedAtMs: null })], NOW)).toEqual([]);
  });
  it('toujours les mêmes destinataires, jamais partagés entre leads', () => {
    const a = lead('a', { managerIds: ['m1'], slaStartedAtMs: NOW - 11 * MIN, slaStoppedAtMs: null });
    const b = lead('b', { managerIds: ['m2', 'm3'], slaStartedAtMs: NOW - 11 * MIN, slaStoppedAtMs: null });
    expect(planEscalations([a, b], NOW).map((e) => e.recipientIds)).toEqual([['m1'], ['m2', 'm3']]);
  });
});

describe('recyclage', () => {
  const end = (cycle: number, nextAtMs: number | null): Partial<SchedLead> => ({ status: 'unreachable_cycle_end', nr: { attempt: 5, cycle, nextAtMs } });
  it('délai écoulé : entrée en recyclage, action P4 du cycle suivant, dans les horaires', () => {
    const p = planRecycling(lead('a', end(1, NOW - H)), NOW)!;
    expect(p).toMatchObject({ kind: 'recycle', cycle: 2, action: { id: 'a_recycle_c2', reason: 'Recyclage — cycle 2' } });
    if (p.kind === 'recycle') expect(p.action.dueAtMs).toBeGreaterThanOrEqual(NOW);
  });
  it("la nuit ou le week-end : action reportée à l\'ouverture suivante", () => {
    const saturday = Date.parse('2026-10-10T10:00:00Z');
    const p = planRecycling(lead('a', end(1, saturday - H)), saturday)!;
    expect(p.kind === 'recycle' && p.action.dueAtMs).toBe(Date.parse('2026-10-12T07:00:00Z'));
  });
  it('délai pas encore écoulé, ou pas de date, ou autre statut : rien', () => {
    expect(planRecycling(lead('a', end(1, NOW + H)), NOW)).toBeNull();
    expect(planRecycling(lead('a', end(1, null)), NOW)).toBeNull();
    expect(planRecycling(lead('a', { status: 'recycling', nr: { attempt: 1, cycle: 2, nextAtMs: NOW - H } }), NOW)).toBeNull();
  });
  it('nombre de cycles atteint : archivage (injoignable / archivé)', () => {
    const p = planRecycling(lead('a', end(3, NOW - H)), NOW)!;
    expect(p.kind).toBe('archive');
    expect(planRecycling(lead('a', end(2, NOW - H)), NOW, { ...DEFAULT_SCHEDULER_RULES, maxRecycleCycles: 2 })!.kind).toBe('archive');
  });
  it("identifiant d\'action déterministe : rejouer le passage ne crée pas de doublon", () => {
    const a = planRecycling(lead('a', end(1, NOW - H)), NOW)!;
    const b = planRecycling(lead('a', end(1, NOW - H)), NOW + 5 * MIN)!;
    expect(a.kind === 'recycle' && b.kind === 'recycle' && a.action.id === b.action.id).toBe(true);
  });
});

describe('file tampon : leads à réévaluer', () => {
  const buffered = (reason: string | null): SchedLead => lead('a', { ownerId: null, assignmentState: 'buffer', bufferReason: reason });
  it('attente technique : réévaluée', () => {
    for (const r of ['no_candidate', 'capacity_reached', 'outside_hours', 'product_not_allowed', null]) expect(isEngineBuffered(buffered(r))).toBe(true);
  });
  it('doublon à examiner, campagne inactive, distribution coupée : décision humaine, jamais contournée', () => {
    for (const r of ['duplicate_review', 'campaign_not_active', 'auto_distribution_off']) expect(isEngineBuffered(buffered(r))).toBe(false);
  });
  it('lead déjà attribué ou plus Nouveau : ignoré', () => {
    expect(isEngineBuffered(lead('a'))).toBe(false);
    expect(isEngineBuffered(lead('a', { ownerId: null, assignmentState: 'buffer', status: 'callback' }))).toBe(false);
    expect(isEngineBuffered(lead('a', { ownerId: null, assignmentState: 'to_assign' }))).toBe(false);
  });
});

describe('réattribution au SLA', () => {
  const rule = { autoReassign: true, reassignMin: 15, maxReassignments: 2 };
  const fresh = (ageMin: number, over: Partial<SchedLead> = {}) => lead('a', { status: 'new', slaStartedAtMs: NOW - ageMin * MIN, slaStoppedAtMs: null, ...over });
  const R = DEFAULT_SCHEDULER_RULES;
  it('délai atteint : réattribué ; avant : non', () => {
    expect(dueForSlaReassign(fresh(16), NOW, rule, R)).toBe(true);
    expect(dueForSlaReassign(fresh(15), NOW, rule, R)).toBe(true);
    expect(dueForSlaReassign(fresh(14), NOW, rule, R)).toBe(false);
  });
  it('règle désactivée, lead pris en charge, sans propriétaire, ou autre statut : jamais', () => {
    expect(dueForSlaReassign(fresh(60), NOW, { ...rule, autoReassign: false }, R)).toBe(false);
    expect(dueForSlaReassign(fresh(60, { slaStoppedAtMs: NOW }), NOW, rule, R)).toBe(false);
    expect(dueForSlaReassign(fresh(60, { ownerId: null }), NOW, rule, R)).toBe(false);
    expect(dueForSlaReassign(fresh(60, { status: 'callback' }), NOW, rule, R)).toBe(false);
  });
  it("un rappel client promis n'est jamais réattribué automatiquement", () => {
    expect(dueForSlaReassign(lead('a', { status: 'callback', slaStartedAtMs: NOW - 99 * MIN, slaStoppedAtMs: null, nextAction: { type: 'client_callback', dueAtMs: NOW - 60 * MIN, reason: '' } }), NOW, rule, R)).toBe(false);
  });
  it('nombre maximal de réattributions respecté, zéro = jamais', () => {
    expect(dueForSlaReassign(fresh(60, { reassignCount: 2 }), NOW, rule, R)).toBe(false);
    expect(dueForSlaReassign(fresh(60, { reassignCount: 1 }), NOW, rule, R)).toBe(true);
    expect(dueForSlaReassign(fresh(60), NOW, { ...rule, maxReassignments: 0 }, R)).toBe(false);
  });
  it('le nouveau propriétaire dispose du même délai : mesuré depuis la dernière réattribution', () => {
    expect(dueForSlaReassign(fresh(60, { reassignCount: 1, lastReassignedAtMs: NOW - 5 * MIN }), NOW, rule, R)).toBe(false);
    expect(dueForSlaReassign(fresh(60, { reassignCount: 1, lastReassignedAtMs: NOW - 16 * MIN }), NOW, rule, R)).toBe(true);
  });
  it('SLA suspendu hors horaires : la nuit ne compte pas', () => {
    const night = Date.parse('2026-10-07T04:00:00Z'); // 06:00 Paris, fermé ; NOW = 11:00 Paris, 2 h ouvrées écoulées
    const l = lead('a', { status: 'new', slaStartedAtMs: night, slaStoppedAtMs: null });
    expect(dueForSlaReassign(l, NOW, { ...rule, reassignMin: 180 }, { ...R, suspendOutsideHours: true })).toBe(false);
    expect(dueForSlaReassign(l, NOW, { ...rule, reassignMin: 180 }, { ...R, suspendOutsideHours: false })).toBe(true);
    expect(slaAge(night, NOW, { ...R, suspendOutsideHours: true })).toBe(120 * MIN);
  });
});
