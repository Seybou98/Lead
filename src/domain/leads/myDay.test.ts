import { describe, expect, it } from 'vitest';
import { buildDayActions, buildDayQueue, buildDayStats, dueTone, firstName, sortDayActions, UPCOMING_LIMIT } from './myDay';
import type { LeadListItem } from './leadList';

const NOW = new Date(2026, 9, 7, 14, 40).getTime();
const MIN = 60_000;
const ME = 'u1';

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id,
  fullName: `Lead ${id}`,
  phone: '+33612345678',
  email: null,
  city: 'Lyon',
  postalCode: '69003',
  campaignId: 'c1',
  productCode: 'pac',
  status: 'interested',
  temperature: null,
  assignmentState: 'assigned',
  bufferReason: null,
  ownerId: ME,
  receivedAtMs: NOW - 60 * MIN,
  slaStartedAtMs: NOW - 60 * MIN,
  slaStoppedAtMs: NOW - 30 * MIN,
  nextAction: { type: 'interested_followup', dueAtMs: NOW + 60 * MIN, priority: 'P2', reason: 'x' },
  documentsState: 'none',
  duplicate: false,
  excluded: false,
  ...over,
});

const newLead = (id: string, ageMin: number, over: Partial<LeadListItem> = {}) =>
  lead(id, {
    status: 'new',
    slaStartedAtMs: NOW - ageMin * MIN,
    slaStoppedAtMs: null,
    receivedAtMs: NOW - ageMin * MIN,
    nextAction: { type: 'take_new_lead', dueAtMs: NOW - ageMin * MIN + 5 * MIN, priority: 'P1', reason: 'x' },
    ...over,
  });

describe("buildDayActions", () => {
  it("ne garde que les leads actifs du télépro", () => {
    const items = [
      lead('mine'),
      lead('other', { ownerId: 'u2' }),
      lead('closed', { status: 'not_interested' }),
      lead('excluded', { excluded: true }),
      lead('buffer', { ownerId: null }),
    ];
    expect(buildDayActions(items, ME, NOW).map((a) => a.lead.id)).toEqual(['mine']);
  });

  it("un lead Nouveau sans action planifiée devient une prise en charge P1", () => {
    const a = buildDayActions([newLead('n', 2, { nextAction: null })], ME, NOW)[0];
    expect(a.priority).toBe('P1');
    expect(a.title).toBe('Prendre en charge le nouveau lead');
    expect(a.isNewLead).toBe(true);
  });

  it("un lead actif sans action et déjà traité n'apparaît pas (RG02 est signalée ailleurs)", () => {
    expect(buildDayActions([lead('x', { nextAction: null })], ME, NOW)).toEqual([]);
  });

  it("marque en retard une échéance dépassée, pas une échéance future", () => {
    const late = lead('late', { nextAction: { type: 'client_callback', dueAtMs: NOW - MIN, priority: 'P0', reason: 'x' } });
    const ok = lead('ok');
    const acts = buildDayActions([late, ok], ME, NOW);
    expect(acts.find((a) => a.lead.id === 'late')?.late).toBe(true);
    expect(acts.find((a) => a.lead.id === 'ok')?.late).toBe(false);
  });

  it("garde le type d'action inconnu tel quel plutôt que de le masquer", () => {
    const a = buildDayActions([lead('f', { nextAction: { type: 'futur_type', dueAtMs: NOW + MIN, priority: 'P3', reason: 'x' } })], ME, NOW)[0];
    expect(a.title).toBe('futur_type');
  });
});

describe("sortDayActions / buildDayQueue", () => {
  it("la priorité métier passe avant l'heure", () => {
    const early = lead('early', { nextAction: { type: 'interested_followup', dueAtMs: NOW + MIN, priority: 'P3', reason: 'x' } });
    const urgent = lead('urgent', { nextAction: { type: 'client_callback', dueAtMs: NOW + 120 * MIN, priority: 'P0', reason: 'x' } });
    expect(buildDayQueue([early, urgent], ME, NOW).current?.lead.id).toBe('urgent');
  });

  it("une action P0 pas encore due ne passe pas devant un lead qui attend ni devant une action échue", () => {
    const future = lead('future', { nextAction: { type: 'client_callback', dueAtMs: NOW + 50 * MIN, priority: 'P0', reason: 'x' } });
    const due = lead('due', { nextAction: { type: 'interested_followup', dueAtMs: NOW - 5 * MIN, priority: 'P3', reason: 'x' } });
    expect(sortDayActions(buildDayActions([future, due, newLead('n', 1)], ME, NOW)).map((x) => x.lead.id)).toEqual(['n', 'due', 'future']);
  });

  it("à priorité égale, le lead Nouveau passe avant, puis l'échéance la plus proche", () => {
    const a = lead('a', { nextAction: { type: 'interested_followup', dueAtMs: NOW + 30 * MIN, priority: 'P1', reason: 'x' } });
    const b = lead('b', { nextAction: { type: 'interested_followup', dueAtMs: NOW + 10 * MIN, priority: 'P1', reason: 'x' } });
    const n = newLead('n', 1);
    expect(sortDayActions(buildDayActions([a, b, n], ME, NOW)).map((x) => x.lead.id)).toEqual(['n', 'b', 'a']);
  });

  it("parmi plusieurs leads Nouveaux, le plus ancien (le plus en retard) d'abord", () => {
    const q = buildDayQueue([newLead('young', 1), newLead('old', 4)], ME, NOW);
    expect(q.current?.lead.id).toBe('old');
    expect(q.upcoming.map((x) => x.lead.id)).toEqual(['young']);
  });

  it("l'ordre est stable : l'identifiant départage les égalités", () => {
    const mk = (id: string) => lead(id, { nextAction: { type: 'interested_followup', dueAtMs: NOW + MIN, priority: 'P2', reason: 'x' }, receivedAtMs: NOW - 5 * MIN });
    expect(sortDayActions(buildDayActions([mk('b'), mk('a'), mk('c')], ME, NOW)).map((x) => x.lead.id)).toEqual(['a', 'b', 'c']);
  });

  it("limite « Ensuite » à quatre actions et compte le total", () => {
    const items = Array.from({ length: 9 }, (_, i) => lead(`l${i}`, { nextAction: { type: 'interested_followup', dueAtMs: NOW + (i + 1) * MIN, priority: 'P2', reason: 'x' } }));
    const q = buildDayQueue(items, ME, NOW);
    expect(q.upcoming).toHaveLength(UPCOMING_LIMIT);
    expect(q.total).toBe(9);
    expect(q.current?.lead.id).toBe('l0');
  });

  it("sans action, il n'y a pas de carte courante", () => {
    expect(buildDayQueue([], ME, NOW)).toEqual({ current: null, upcoming: [], total: 0 });
  });

  it("ne modifie pas le tableau reçu", () => {
    const acts = buildDayActions([lead('b'), lead('a')], ME, NOW);
    const copy = [...acts];
    sortDayActions(acts);
    expect(acts).toEqual(copy);
  });
});

describe("buildDayStats", () => {
  it("compte uniquement le portefeuille du télépro", () => {
    const s = buildDayStats([newLead('n1', 1), newLead('n2', 2), lead('o', { ownerId: 'u2', status: 'new' })], ME, NOW);
    expect(s.newLeads).toBe(2);
  });

  it("reçus aujourd'hui : seulement depuis minuit", () => {
    const midnight = new Date(2026, 9, 7, 0, 0).getTime();
    const s = buildDayStats([lead('today', { receivedAtMs: midnight + MIN }), lead('yesterday', { receivedAtMs: midnight - MIN })], ME, NOW);
    expect(s.receivedToday).toBe(1);
  });

  it("documents en cours et convertis", () => {
    const s = buildDayStats(
      [lead('d1', { status: 'awaiting_documents' }), lead('d2', { status: 'missing_info' }), lead('c', { status: 'converted', nextAction: null })],
      ME,
      NOW
    );
    expect(s.documentsInProgress).toBe(2);
    expect(s.converted).toBe(1);
  });

  it("actions en retard : hors leads Nouveaux (leur retard est le compteur SLA)", () => {
    const late = lead('late', { nextAction: { type: 'client_callback', dueAtMs: NOW - 20 * MIN, priority: 'P0', reason: 'x' } });
    const s = buildDayStats([late, newLead('n', 9), lead('future')], ME, NOW);
    expect(s.lateActions).toBe(1);
  });
});

describe("firstName / dueTone", () => {
  it("prénom d'un nom complet, jamais d'un email", () => {
    expect(firstName("Sarah Martin")).toBe("Sarah");
    expect(firstName("  ")).toBe("");
    expect(firstName("sarah@exemple.fr")).toBe("");
  });

  it("voyant d'échéance : retard, dans l'heure, plus tard", () => {
    expect(dueTone({ late: true, dueAtMs: NOW - MIN }, NOW)).toBe('late');
    expect(dueTone({ late: false, dueAtMs: NOW + 30 * MIN }, NOW)).toBe('soon');
    expect(dueTone({ late: false, dueAtMs: NOW + 90 * MIN }, NOW)).toBe('later');
    expect(dueTone({ late: false, dueAtMs: null }, NOW)).toBe('later');
  });
});
