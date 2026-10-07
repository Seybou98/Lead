import { describe, expect, it } from 'vitest';
import {
  buildAlertBars,
  callbackLevel,
  EMPTY_ALERT_STATE,
  parseAlertState,
  strongestSound,
  tickAlerts,
  titlePrefix,
  type AlertState,
} from './engine';
import type { LeadListItem } from '../leads/leadList';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const ME = 'u1';

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id,
  fullName: `Lead ${id}`,
  phone: '+33612345678',
  email: null,
  city: 'Lyon',
  postalCode: '69003',
  campaignId: 'c1',
  productCode: 'PAC',
  status: 'interested',
  temperature: null,
  assignmentState: 'assigned',
  bufferReason: null,
  ownerId: ME,
  receivedAtMs: NOW - 60 * MIN,
  slaStartedAtMs: NOW - 60 * MIN,
  slaStoppedAtMs: NOW - 30 * MIN,
  nextAction: null,
  documentsState: 'none',
  duplicate: false,
  excluded: false,
  ...over,
});

const fresh = (id: string, ageMs: number, over: Partial<LeadListItem> = {}) =>
  lead(id, { status: 'new', slaStartedAtMs: NOW - ageMs, slaStoppedAtMs: null, receivedAtMs: NOW - ageMs, ...over });

const callback = (id: string, dueAtMs: number, over: Partial<LeadListItem> = {}) =>
  lead(id, { status: 'callback', nextAction: { type: 'client_callback', dueAtMs, priority: 'P0', reason: 'Rappel promis' }, ...over });

/** Rejoue le temps seconde par seconde et rend toutes les alertes déclenchées. */
function simulate(items: LeadListItem[], from: number, to: number, start: AlertState = EMPTY_ALERT_STATE, stepMs = 1000) {
  let state = start;
  const all: { at: number; kind: string; sound: string | null }[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const r = tickAlerts(state, items, ME, t);
    state = r.state;
    for (const f of r.fires) all.push({ at: t, kind: f.kind, sound: f.sound });
  }
  return { fires: all, state };
}

describe('SLA de prise en charge (§5.1)', () => {
  it("à l'arrivée : son fort immédiat, une seule fois", () => {
    const l = fresh('n', 5_000);
    const first = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    expect(first.fires).toHaveLength(1);
    expect(first.fires[0]).toMatchObject({ kind: 'new_lead', sound: 'new_lead' });
    expect(tickAlerts(first.state, [l], ME, NOW).fires).toEqual([]); // idempotent
  });

  it("0 à 5 minutes : une alerte sonore chaque minute", () => {
    const start = NOW - 10_000;
    const l = fresh('n', 10_000);
    // On suit le lead pendant 4 min 30 s depuis son arrivée
    const { fires } = simulate([{ ...l, slaStartedAtMs: start }], NOW, NOW + 4.5 * MIN);
    const sounds = fires.map((f) => f.sound);
    expect(sounds.filter((s) => s === 'sla')).toHaveLength(4);
    expect(fires.filter((f) => f.kind === 'sla_reminder').map((f) => (f.at - NOW) / MIN)).toEqual([1, 2, 3, 4]);
  });

  it("à 5 minutes : un signalement de dépassement distinct (son critique), une seule fois", () => {
    const l = fresh('n', 10_000);
    const { fires } = simulate([l], NOW, NOW + 6 * MIN);
    const breaches = fires.filter((f) => f.kind === 'sla_breached');
    expect(breaches).toHaveLength(1);
    expect(breaches[0].sound).toBe('critical');
    // dépassement à 5 min après l'arrivée = 4 min 50 s après le premier tick
    expect(breaches[0].at - NOW).toBe(5 * MIN - 10_000 + 1000);
  });

  it("après 5 minutes : une alerte toutes les 10 minutes", () => {
    const l = fresh('n', 6 * MIN);
    const first = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    const { fires } = simulate([l], NOW + 1000, NOW + 25 * MIN, first.state);
    const reminders = fires.filter((f) => f.kind === 'sla_reminder').map((f) => Math.round((f.at - NOW) / MIN));
    expect(reminders).toEqual([10, 20]);
  });

  it("un lead déjà ancien à l'ouverture de la page : un seul rappel, pas une alerte « nouveau lead »", () => {
    const r = tickAlerts(EMPTY_ALERT_STATE, [fresh('n', 3 * MIN)], ME, NOW);
    expect(r.fires).toHaveLength(1);
    expect(r.fires[0].kind).toBe('sla_reminder');
    const old = tickAlerts(EMPTY_ALERT_STATE, [fresh('n', 30 * MIN)], ME, NOW);
    expect(old.fires[0]).toMatchObject({ kind: 'sla_breached', sound: 'critical' });
    // et le dépassement n'est pas resignalé ensuite
    expect(tickAlerts(old.state, [fresh('n', 30 * MIN)], ME, NOW + 1000).fires).toEqual([]);
  });

  it("seul un changement de statut arrête les alertes : le lead prend un statut → silence", () => {
    const l = fresh('n', 10_000);
    const first = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    const handled = { ...l, status: 'nr' as const, slaStoppedAtMs: NOW + 1000 };
    const { fires, state } = simulate([handled], NOW + 1000, NOW + 15 * MIN, first.state);
    expect(fires).toEqual([]);
    expect(state.sla).toEqual({}); // l'état est nettoyé
  });

  it("le lead ne s'arrête PAS parce qu'on a ouvert sa fiche ou fermé la notification : seules les données comptent", () => {
    const l = fresh('n', 10_000);
    const first = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    // même lead, mêmes données (toujours Nouveau) : les alertes reprennent à l'échéance
    const { fires } = simulate([l], NOW + 1000, NOW + 2 * MIN, first.state);
    expect(fires.some((f) => f.kind === 'sla_reminder')).toBe(true);
  });

  it("ne concerne que les leads de ce télépro, actifs", () => {
    const items = [fresh('mine', 5000), fresh('other', 5000, { ownerId: 'u2' }), fresh('excl', 5000, { excluded: true }), fresh('buffer', 5000, { ownerId: null })];
    expect(tickAlerts(EMPTY_ALERT_STATE, items, ME, NOW).fires.map((f) => f.leadId)).toEqual(['mine']);
  });

  it("deux leads arrivent ensemble : deux alertes distinctes", () => {
    const r = tickAlerts(EMPTY_ALERT_STATE, [fresh('a', 1000), fresh('b', 2000)], ME, NOW);
    expect(r.fires.map((f) => f.leadId).sort()).toEqual(['a', 'b']);
    expect(new Set(r.fires.map((f) => f.id)).size).toBe(2);
  });

  it("sans compteur (aucune date de départ) : aucune alerte plutôt qu'une alerte fausse", () => {
    expect(tickAlerts(EMPTY_ALERT_STATE, [fresh('n', 1000, { slaStartedAtMs: null })], ME, NOW).fires).toEqual([]);
  });
});

describe('rappels clients (§8.2)', () => {
  it('callbackLevel : H-5 min, heure exacte, +5 orange, +15 rouge', () => {
    const due = NOW;
    expect(callbackLevel(due, due - 6 * MIN)).toBeNull();
    expect(callbackLevel(due, due - 5 * MIN)).toBe('soon');
    expect(callbackLevel(due, due - 1)).toBe('soon');
    expect(callbackLevel(due, due)).toBe('due');
    expect(callbackLevel(due, due + 4 * MIN + 59_000)).toBe('due');
    expect(callbackLevel(due, due + 5 * MIN)).toBe('orange');
    expect(callbackLevel(due, due + 14 * MIN + 59_000)).toBe('orange');
    expect(callbackLevel(due, due + 15 * MIN)).toBe('red');
    expect(callbackLevel(due, due + 3 * 60 * MIN)).toBe('red');
  });

  it('H-5 : notification sans son ; à l’heure : son « rappel » ; orange et rouge : visuels seulement', () => {
    const l = callback('c', NOW + 10 * MIN);
    const { fires } = simulate([l], NOW, NOW + 40 * MIN, EMPTY_ALERT_STATE, 30_000);
    expect(fires.map((f) => [f.kind, f.sound])).toEqual([
      ['callback_soon', null],
      ['callback_due', 'callback'],
    ]);
    const due = NOW + 10 * MIN;
    expect(fires[0].at).toBe(due - 5 * MIN);
    expect(fires[1].at).toBe(due);
  });

  it('chaque palier ne se déclenche qu’une fois', () => {
    const l = callback('c', NOW);
    const a = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    expect(a.fires).toHaveLength(1);
    expect(tickAlerts(a.state, [l], ME, NOW + 10_000).fires).toEqual([]);
  });

  it('rappel déjà échu à l’ouverture : une seule sonnerie, puis le silence', () => {
    const l = callback('c', NOW - 20 * MIN);
    const a = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW);
    expect(a.fires).toHaveLength(1);
    expect(a.fires[0]).toMatchObject({ kind: 'callback_due', sound: 'callback' });
    expect(tickAlerts(a.state, [l], ME, NOW + MIN).fires).toEqual([]);
  });

  it('onglet gelé : on saute du palier « bientôt » à « orange » sans manquer la sonnerie « dû »', () => {
    const l = callback('c', NOW);
    const a = tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW - 4 * MIN);
    expect(a.fires[0].kind).toBe('callback_soon');
    const b = tickAlerts(a.state, [l], ME, NOW + 6 * MIN);
    expect(b.fires).toHaveLength(1);
    expect(b.fires[0]).toMatchObject({ kind: 'callback_due', sound: 'callback' });
  });

  it('un rappel reprogrammé (nouvelle échéance) redéclenche ses paliers', () => {
    const a = tickAlerts(EMPTY_ALERT_STATE, [callback('c', NOW)], ME, NOW);
    const moved = callback('c', NOW + 30 * MIN);
    expect(tickAlerts(a.state, [moved], ME, NOW + 25 * MIN).fires[0].kind).toBe('callback_soon');
  });

  it('ne concerne que mes rappels : pas ceux des autres, ni une autre action P0', () => {
    const items = [callback('mine', NOW), callback('other', NOW, { ownerId: 'u2' }), lead('doc', { status: 'awaiting_documents', nextAction: { type: 'document_followup', dueAtMs: NOW, priority: 'P2', reason: 'x' } })];
    expect(tickAlerts(EMPTY_ALERT_STATE, items, ME, NOW).fires.map((f) => f.leadId)).toEqual(['mine']);
  });

  it('le « mauvais moment » (rappel court) est aussi un rappel', () => {
    const l = callback('c', NOW, { nextAction: { type: 'short_callback', dueAtMs: NOW, priority: 'P1', reason: 'Mauvais moment' } });
    expect(tickAlerts(EMPTY_ALERT_STATE, [l], ME, NOW).fires[0].kind).toBe('callback_due');
  });

  it('un rappel qui change de statut (traité) disparaît de l’état', () => {
    const a = tickAlerts(EMPTY_ALERT_STATE, [callback('c', NOW)], ME, NOW);
    const done = lead('c', { status: 'interested' });
    expect(tickAlerts(a.state, [done], ME, NOW + MIN).state.cb).toEqual({});
  });
});

describe('barres persistantes et titre', () => {
  it('lead Nouveau : le plus ancien, le nombre, la couleur progressive', () => {
    const b = buildAlertBars([fresh('young', 30_000), fresh('old', 4 * MIN), fresh('x', 10_000, { ownerId: 'u2' })], ME, NOW);
    expect(b.newLeads).toMatchObject({ count: 2, oldest: { id: 'old', level: 'warning' } });
    expect(buildAlertBars([fresh('l', 6 * MIN)], ME, NOW).newLeads?.oldest.level).toBe('breached');
    expect(buildAlertBars([fresh('l', 10_000)], ME, NOW).newLeads?.oldest.level).toBe('ok');
  });

  it('la barre persiste tant que le statut ne change pas, même « fermée » côté écran', () => {
    const l = fresh('l', 10 * MIN);
    expect(buildAlertBars([l], ME, NOW).total).toBe(1);
    expect(buildAlertBars([l], ME, NOW + 30 * MIN).total).toBe(1);
    expect(buildAlertBars([{ ...l, status: 'nr', slaStoppedAtMs: NOW }], ME, NOW + 30 * MIN).total).toBe(0);
  });

  it('rappels : seulement à moins de 5 min ou échus, triés par échéance', () => {
    const b = buildAlertBars([callback('far', NOW + 20 * MIN), callback('late', NOW - 16 * MIN), callback('soon', NOW + 3 * MIN), callback('due', NOW - MIN)], ME, NOW);
    expect(b.callbacks.map((c) => [c.leadId, c.level])).toEqual([['late', 'red'], ['due', 'due'], ['soon', 'soon']]);
    expect(b.total).toBe(3);
  });

  it('rien à signaler : barres vides', () => {
    expect(buildAlertBars([], ME, NOW)).toEqual({ newLeads: null, callbacks: [], total: 0 });
  });

  it("préfixe de titre d'onglet", () => {
    expect(titlePrefix(buildAlertBars([], ME, NOW))).toBe('');
    expect(titlePrefix(buildAlertBars([fresh('a', 1000), fresh('b', 1000)], ME, NOW))).toBe('(2) Nouveau lead · ');
    expect(titlePrefix(buildAlertBars([callback('c', NOW)], ME, NOW))).toBe('(1) Rappel client · ');
    // un rappel « bientôt » (pas encore dû) ne fait pas clignoter le titre
    expect(titlePrefix(buildAlertBars([callback('c', NOW + 3 * MIN)], ME, NOW))).toBe('');
  });
});

describe('parseAlertState', () => {
  it('relit un état valide', () => {
    const s: AlertState = { sla: { a: { lastAt: 5, breached: true } }, cb: { 'a@1': 2 } };
    expect(parseAlertState(JSON.stringify(s))).toEqual(s);
  });
  it('rejette sans planter tout ce qui est invalide', () => {
    for (const raw of [null, '', '{', 'null', '[]', '"x"', JSON.stringify({ sla: 3, cb: 'x' })]) {
      expect(parseAlertState(raw)).toEqual(EMPTY_ALERT_STATE);
    }
  });
  it('ignore les entrées mal formées et garde les bonnes', () => {
    const raw = JSON.stringify({ sla: { ok: { lastAt: 1 }, bad: { lastAt: 'x' }, nul: null }, cb: { 'a@1': 3, 'b@1': 9, 'c@1': 'x' } });
    expect(parseAlertState(raw)).toEqual({ sla: { ok: { lastAt: 1, breached: false } }, cb: { 'a@1': 3 } });
  });
  it('plafonne la taille (état corrompu ou énorme)', () => {
    const big = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, { lastAt: i, breached: false }]));
    expect(Object.keys(parseAlertState(JSON.stringify({ sla: big, cb: {} })).sla).length).toBeLessThanOrEqual(300);
  });
});

describe('strongestSound', () => {
  it('garde la sonnerie la plus forte, ignore le silence', () => {
    expect(strongestSound(['sla', 'callback'])).toBe('callback');
    expect(strongestSound(['sla', 'new_lead', 'callback'])).toBe('new_lead');
    expect(strongestSound([null, 'sla', 'critical'])).toBe('critical');
    expect(strongestSound([null, undefined])).toBeNull();
    expect(strongestSound([])).toBeNull();
  });
});
