import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que runScheduler ÉCRIT, pas le moteur Firestore.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));
// La transmission au CRM principal a ses propres tests (transmission.test.ts) : ici on vérifie QUAND le planificateur la relance.
vi.mock('./transmission', async (orig) => ({ ...(await orig<typeof import('./transmission')>()), transmitConversion: vi.fn() }));

import { parseSchedulerRules, runScheduler, toSchedLead } from './scheduler';
import { DEFAULT_SCHEDULER_RULES } from '../../src/domain/scheduler/plan';
import { transmitConversion } from './transmission';

type Doc = Record<string, unknown>;
const T = (ms: number) => ({ toMillis: () => ms });

class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<T2>(fn: (tx: FakeTx) => Promise<T2>): Promise<T2> {
    return fn(new FakeTx(this));
  }
  async getAll(...refs: FakeRef[]) {
    return refs.map((r) => snap(this, r.path));
  }
}
type Filter = [string, string, unknown];
class FakeCol {
  constructor(public db: FakeDb, public path: string, private filters: Filter[] = [], private max = Infinity) {}
  doc(id: string): FakeRef {
    return new FakeRef(this.db, `${this.path}/${id}`);
  }
  where(f: string, op: string, v: unknown) {
    return new FakeCol(this.db, this.path, [...this.filters, [f, op, v]], this.max);
  }
  limit(n: number) {
    return new FakeCol(this.db, this.path, this.filters, n);
  }
  async get() {
    const docs = [...this.db.data.keys()]
      .filter((k) => k.startsWith(`${this.path}/`) && !k.slice(this.path.length + 1).includes('/'))
      .map((k) => snap(this.db, k))
      .filter((s) =>
        this.filters.every(([f, op, v]) => {
          const x = (s.data() as Doc)[f];
          if (op === '==') return x === v;
          if (op === 'in') return (v as unknown[]).includes(x);
          if (op === '>=') return x instanceof Date || (x as { toMillis?: () => number })?.toMillis ? ((x as { toMillis?: () => number }).toMillis?.() ?? (x as Date).getTime()) >= (v as Date).getTime() : false;
          return false;
        })
      )
      .slice(0, this.max);
    return { docs, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol {
    return this.db.collection(name, `${this.path}/`);
  }
  async get() { return snap(this.db, this.path); }
  async update(patch: Doc) {
    const cur = this.db.data.get(this.path);
    if (!cur) throw new Error(`update d'un document inexistant : ${this.path}`);
    for (const [k, v] of Object.entries(patch)) setDeep(cur, k, v);
  }
  async create(data: Doc) {
    if (this.db.data.has(this.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    this.db.data.set(this.path, { ...data });
  }
  async set(data: Doc) { this.db.data.set(this.path, { ...data }); }
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k], ref: new FakeRef(db, path) };
};
const setDeep = (obj: Doc, key: string, val: unknown) => {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] = (cur[p] && typeof cur[p] === 'object' ? { ...(cur[p] as Doc) } : {})) as Doc;
  const last = parts[parts.length - 1];
  const inc = val as { __inc?: number };
  cur[last] = inc && typeof inc === 'object' && '__inc' in inc ? Number(cur[last] ?? 0) + (inc.__inc as number) : val;
};
class FakeTx {
  private wrote = false;
  constructor(private db: FakeDb) {}
  async get(ref: FakeRef) {
    if (this.wrote) throw new Error('lecture après écriture : interdit dans une transaction Firestore');
    return snap(this.db, ref.path);
  }
  update(ref: FakeRef, patch: Doc) {
    this.wrote = true;
    const cur = this.db.data.get(ref.path);
    if (!cur) throw new Error(`update d'un document inexistant : ${ref.path}`);
    for (const [k, v] of Object.entries(patch)) setDeep(cur, k, v);
  }
  set(ref: FakeRef, data: Doc, opts?: { merge?: boolean }) {
    this.wrote = true;
    const cur = this.db.data.get(ref.path);
    this.db.data.set(ref.path, opts?.merge && cur ? { ...cur, ...data } : { ...data });
  }
}

// Mercredi 7 octobre 2026, 11:00 à Paris.
const NOW = Date.parse('2026-10-07T09:00:00Z');
const MIN = 60_000;
const H = 60 * MIN;
const run = (db: FakeDb) => runScheduler(db as never, NOW);

const lead = (over: Doc = {}): Doc => ({
  fullName: 'Jean Dupont', status: 'new', assignmentState: 'assigned', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], productCode: 'PAC',
  origin: { receivedAt: T(NOW - H), campaignId: null }, sla: { startedAt: T(NOW - H), stoppedAt: T(NOW - 30 * MIN) }, nr: { attempt: 0, cycle: 1, nextAt: null },
  nextAction: null, version: 1, ...over,
});
const profile = (over: Doc = {}): Doc => ({
  uid: 'u2', primaryTeamId: 't1', teamIds: ['t1'], managerIds: ['m1'], scope: { productCodes: ['*'], zones: ['*'] }, capacity: { newLeadsCap: 10 }, operationalStatus: 'available',
  distributionSuspended: false, load: { newLeads: 0, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 },
  schedule: { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })), breaks: [] }, ...over,
});
function withTelepro(db: FakeDb, uid = 'u2', over: Doc = {}) {
  db.data.set(`cl_profiles/${uid}`, profile({ uid, ...over }));
  db.data.set(`users/${uid}`, { name: `Télépro ${uid}`, role: 'telepro commercial', status: 'active' });
  db.data.set(`cl_presence/${uid}`, { connected: true, lastSeenAt: T(NOW - 10_000) });
}
const buffered = (over: Doc = {}) => lead({ status: 'new', ownerId: null, assignmentState: 'buffer', bufferReason: 'no_candidate', managerIds: ['m1'], sla: { startedAt: T(NOW - 3 * MIN), stoppedAt: null }, origin: { receivedAt: T(NOW - 3 * MIN), campaignId: null }, ...over });

describe('runScheduler — escalades', () => {
  it('crée la notification manager une seule fois, même si le planificateur repasse', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', lead({ status: 'callback', nextAction: { type: 'client_callback', dueAt: T(NOW - 40 * MIN), reason: 'Rappel' } }));
    const first = await run(db);
    expect(first.escalations).toBe(1);
    const n = [...db.data.entries()].find(([k]) => k.startsWith('cl_notifications/L1_esc_cb_'))![1];
    expect(n).toMatchObject({ type: 'manager_alert', recipientIds: ['m1'], leadId: 'L1', sound: 'critical', readBy: [] });
    expect((await run(db)).escalations).toBe(0);
    expect([...db.data.keys()].filter((k) => k.startsWith('cl_notifications/'))).toHaveLength(1);
  });
  it("un lead en échec ne bloque pas les autres, et l\'erreur est consignée", async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/bad', lead({ status: 'callback', managerIds: ['m1'], nextAction: { type: 'client_callback', dueAt: T(NOW - 40 * MIN), reason: '' } }));
    db.data.set('cl_leads/ok', lead({ status: 'callback', managerIds: ['m2'], nextAction: { type: 'client_callback', dueAt: T(NOW - 50 * MIN), reason: '' } }));
    const real = FakeRef.prototype.create;
    FakeRef.prototype.create = async function (this: FakeRef, d: Doc) {
      if (this.path.startsWith('cl_notifications/bad_')) throw new Error('panne');
      return real.call(this, d);
    };
    try {
      const r = await run(db);
      expect(r.escalations).toBe(1);
      expect(r.errors[0]).toMatch(/panne/);
    } finally {
      FakeRef.prototype.create = real;
    }
  });
});

describe('runScheduler — recyclage', () => {
  const end = (cycle: number, over: Doc = {}) => lead({ status: 'unreachable_cycle_end', managerIds: [], sla: { startedAt: T(NOW - 9 * H), stoppedAt: T(NOW - 8 * H) }, nr: { attempt: 5, cycle, nextAt: T(NOW - H) }, ...over });
  it('entre en recyclage : statut, action P4, historique par le moteur, compteur du télépro', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', end(1));
    db.data.set('cl_profiles/u1', profile({ uid: 'u1' }));
    const r = await run(db);
    expect(r).toMatchObject({ recycled: 1, archived: 0 });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ status: 'recycling', nextAction: { type: 'recycle', priority: 'P4', actionId: 'L1_recycle_c2' } });
    expect(db.data.get('cl_actions/L1_recycle_c2')).toMatchObject({ state: 'open', ownerId: 'u1', type: 'recycle', priority: 'P4' });
    expect(db.data.get('cl_leads/L1/events/sched_recycle_2')).toMatchObject({ actorId: 'engine', before: { status: 'unreachable_cycle_end' }, after: { status: 'recycling' } });
    expect((db.data.get('cl_profiles/u1')!.load as Doc).recycling).toBe(1);
  });
  it('un second passage ne refait rien (le statut a changé)', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', end(1));
    await run(db);
    expect(await run(db)).toMatchObject({ recycled: 0, archived: 0 });
  });
  it('après le nombre de cycles configuré : archivé, sans action', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', end(3));
    expect(await run(db)).toMatchObject({ archived: 1, recycled: 0 });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ status: 'unreachable_archived', nextAction: null });
    expect(db.data.get('cl_leads/L1/events/sched_archive_3')).toBeDefined();
  });
  it('délai pas écoulé : rien', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', end(1, { nr: { attempt: 5, cycle: 1, nextAt: T(NOW + H) } }));
    expect(await run(db)).toMatchObject({ recycled: 0, archived: 0 });
  });
});

describe('runScheduler — file tampon', () => {
  it("attribue un lead en attente dès qu\'un télépro compatible est disponible", async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', buffered());
    withTelepro(db);
    const r = await run(db);
    expect(r).toMatchObject({ assigned: 1, stillWaiting: 0 });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u2', assignmentState: 'assigned', bufferReason: null });
    expect(db.data.get('cl_leads/L1/events/sched_L1_' + Math.floor(NOW / 60_000) + '_reassigned')).toMatchObject({ type: 'assigned', actorId: 'engine' });
    expect((db.data.get('cl_profiles/u2')!.load as Doc).newLeads).toBe(1);
  });
  it('respecte le plafond pendant le passage : le dixième lead entre, le onzième attend', async () => {
    const db = new FakeDb();
    withTelepro(db, 'u2', { load: { newLeads: 9, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
    db.data.set('cl_leads/A', buffered({ origin: { receivedAt: T(NOW - 20 * MIN), campaignId: null } }));
    db.data.set('cl_leads/B', buffered({ origin: { receivedAt: T(NOW - 10 * MIN), campaignId: null } }));
    const r = await run(db);
    expect(r).toMatchObject({ assigned: 1, stillWaiting: 1 });
    expect((db.data.get('cl_leads/A') as Doc).ownerId).toBe('u2'); // le plus ancien d'abord
    expect((db.data.get('cl_leads/B') as Doc).ownerId).toBeNull();
  });
  it('aucun télépro disponible : le lead reste en file, compté comme en attente', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', buffered());
    withTelepro(db, 'u2', { operationalStatus: 'paused' });
    expect(await run(db)).toMatchObject({ assigned: 0, stillWaiting: 1 });
    expect((db.data.get('cl_leads/L1') as Doc).ownerId).toBeNull();
  });
  it('décision humaine (doublon, campagne inactive) : jamais contournée', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', buffered({ bufferReason: 'duplicate_review', assignmentState: 'buffer' }));
    withTelepro(db);
    expect(await run(db)).toMatchObject({ assigned: 0, stillWaiting: 0 });
    expect((db.data.get('cl_leads/L1') as Doc).ownerId).toBeNull();
  });
  it('campagne suspendue : le lead attend une décision', async () => {
    const db = new FakeDb();
    db.data.set('cl_campaigns/c1', { name: 'C', status: 'suspended', eligibleUserIds: [], eligibleTeamIds: [] });
    db.data.set('cl_leads/L1', buffered({ origin: { receivedAt: T(NOW - 3 * MIN), campaignId: 'c1' } }));
    withTelepro(db);
    expect((await run(db)).assigned).toBe(0);
  });
});

describe('runScheduler — trace et lecture', () => {
  it('écrit le dernier passage dans cl_config/schedulerStatus', async () => {
    const db = new FakeDb();
    const r = await run(db);
    expect(db.data.get('cl_config/schedulerStatus')).toMatchObject({ report: { leadsRead: 0, assigned: 0 } });
    expect(r.errors).toEqual([]);
  });
  it('ne lit que les leads ouverts', async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/closed', lead({ status: 'converted' }));
    db.data.set('cl_leads/open', lead());
    expect((await run(db)).leadsRead).toBe(1);
  });
  it('lecture tolérante d\'un lead incomplet', () => {
    const l = toSchedLead('x', { status: 'new' });
    expect(l).toMatchObject({ id: 'x', ownerId: null, managerIds: [], nextAction: null, receivedAtMs: 0 });
  });
  it('réglages : défauts, valeurs valides prises, invalides ignorées', () => {
    expect(parseSchedulerRules(undefined, undefined)).toEqual(DEFAULT_SCHEDULER_RULES);
    expect(parseSchedulerRules({ callbackEscalationMin: 45, maxRecycleCycles: 5 }, undefined)).toMatchObject({ callbackEscalationMin: 45, maxRecycleCycles: 5 });
    expect(parseSchedulerRules({ callbackEscalationMin: 0, maxRecycleCycles: 'x', bufferWarnMin: -3 }, undefined)).toMatchObject({ callbackEscalationMin: 30, maxRecycleCycles: 3, bufferWarnMin: 15 });
  });
});

describe('runScheduler — absences', () => {
  const absence = (over: Doc = {}): Doc => ({ id: 'A1', userId: 'u2', from: T(NOW - H), to: T(NOW + 5 * H), restoreDistribution: true, handled: false, ...over });
  it('absence en cours : le statut « Absent » est posé (sauf pendant un appel)', async () => {
    const db = new FakeDb();
    withTelepro(db);
    db.data.set('cl_absences/A1', absence());
    expect(await run(db)).toMatchObject({ absencesStarted: 1 });
    expect(db.data.get('cl_profiles/u2')).toMatchObject({ operationalStatus: 'absent' });
    expect((await run(db)).absencesStarted).toBe(0); // déjà posé : rien de plus
    const busy = new FakeDb();
    withTelepro(busy, 'u2', { operationalStatus: 'on_call' });
    busy.data.set('cl_absences/A1', absence());
    await run(busy);
    expect(busy.data.get('cl_profiles/u2')).toMatchObject({ operationalStatus: 'on_call' });
  });
  it('absence pas encore commencée : rien', async () => {
    const db = new FakeDb();
    withTelepro(db);
    db.data.set('cl_absences/A1', absence({ from: T(NOW + H), to: T(NOW + 5 * H) }));
    expect(await run(db)).toMatchObject({ absencesStarted: 0, absencesEnded: 0 });
    expect(db.data.get('cl_profiles/u2')).toMatchObject({ operationalStatus: 'available' });
  });
  it("fin de l'absence : télépro de nouveau disponible, absence marquée traitée, audit", async () => {
    const db = new FakeDb();
    withTelepro(db, 'u2', { operationalStatus: 'absent' });
    db.data.set('cl_absences/A1', absence({ to: T(NOW - MIN) }));
    expect(await run(db)).toMatchObject({ absencesEnded: 1 });
    expect(db.data.get('cl_profiles/u2')).toMatchObject({ operationalStatus: 'available', distributionSuspended: false });
    expect(db.data.get('cl_absences/A1')).toMatchObject({ handled: true });
    expect(db.data.get('cl_audit/absence_return_A1')).toMatchObject({ action: 'absence.return', actorId: 'engine' });
    expect((await run(db)).absencesEnded).toBe(0);
  });
  it('« rétablir automatiquement » désactivé : la distribution reste suspendue au retour', async () => {
    const db = new FakeDb();
    withTelepro(db, 'u2', { operationalStatus: 'absent' });
    db.data.set('cl_absences/A1', absence({ to: T(NOW - MIN), restoreDistribution: false }));
    await run(db);
    expect(db.data.get('cl_profiles/u2')).toMatchObject({ operationalStatus: 'available', distributionSuspended: true });
  });
});

describe('runScheduler — retour des transferts temporaires', () => {
  const batch = (over: Doc = {}): Doc => ({ id: 'B1', fromUid: 'u1', toUids: ['u2'], leadIds: ['L1'], temporary: true, returnAt: T(NOW - MIN), returned: false, ...over });
  const seedTransfer = (b: Doc, leadOver: Doc = {}) => {
    const db = new FakeDb();
    withTelepro(db, 'u1');
    withTelepro(db, 'u2');
    db.data.set('cl_leads/L1', lead({ status: 'awaiting_documents', ownerId: 'u2', managerIds: ['m1'], ...leadOver }));
    db.data.set('cl_transfers/B1', b);
    return db;
  };
  it("ramène les leads encore chez le destinataire à leur propriétaire d'origine", async () => {
    const db = seedTransfer(batch());
    const r = await run(db);
    expect(r).toMatchObject({ returned: 1 });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u1' });
    expect(db.data.get('cl_transfers/B1')).toMatchObject({ returned: true });
    expect((await run(db)).returned).toBe(0);
  });
  it("un lead repris ailleurs ou clôturé entre-temps n'est pas touché ; le lot est quand même soldé", async () => {
    const moved = seedTransfer(batch(), { ownerId: 'u3' });
    expect((await run(moved)).returned).toBe(0);
    expect((moved.data.get('cl_leads/L1') as Doc).ownerId).toBe('u3');
    expect(moved.data.get('cl_transfers/B1')).toMatchObject({ returned: true });
    const closed = seedTransfer(batch(), { status: 'converted' });
    expect((await run(closed)).returned).toBe(0);
  });
  it('transfert définitif ou retour dans le futur : rien', async () => {
    expect((await run(seedTransfer(batch({ temporary: false })))).returned).toBe(0);
    expect((await run(seedTransfer(batch({ returnAt: T(NOW + H) })))).returned).toBe(0);
  });
  it("propriétaire d'origine devenu inactif : l'erreur est consignée, sans bloquer les passages suivants", async () => {
    const db = seedTransfer(batch());
    db.data.set('users/u1', { name: 'X', role: 'telepro commercial', status: 'inactive' });
    const r = await run(db);
    expect(r.returned).toBe(0);
    expect(r.errors.some((e) => /retour L1/.test(e))).toBe(true);
    expect(db.data.get('cl_transfers/B1')).toMatchObject({ returned: true });
  });
});

describe('runScheduler — réglages de Paramètres', () => {
  const slow = (id: string): Doc => lead({ status: 'new', sla: { startedAt: T(NOW - 11 * MIN), stoppedAt: null }, managerIds: ['m1'], nextAction: null });
  it("le délai du SLA réglé par l'administrateur décide de l'alerte manager", async () => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', slow('L1'));
    expect((await run(db)).escalations).toBe(1); // 5 min par défaut : 9 min = hors SLA
    const lax = new FakeDb();
    lax.data.set('cl_leads/L1', slow('L1'));
    lax.data.set('cl_settings/sla', { firstAlertMin: 20, criticalMin: 30, reassignMin: 40 });
    expect((await run(lax)).escalations).toBe(0);
  });
  it("SLA suspendu hors horaires : un lead reçu la nuit n'est pas « hors SLA » à l'ouverture", async () => {
    const night = Date.parse('2026-10-07T04:00:00Z'); // 06:00 Paris, fermé ; ouverture à 09:00 (07:00Z), NOW = 11:00 Paris
    const mk = () => {
      const db = new FakeDb();
      db.data.set('cl_leads/L1', lead({ status: 'new', sla: { startedAt: T(night), stoppedAt: null }, origin: { receivedAt: T(night), campaignId: null }, managerIds: ['m1'] }));
      return db;
    };
    const suspended = mk();
    suspended.data.set('cl_settings/sla', { suspendOutsideHours: true });
    // 2 h de travail écoulées (09:00 → 11:00) : dépassé quand même ; avec un SLA de 3 h, non.
    suspended.data.set('cl_settings/sla', { suspendOutsideHours: true, firstAlertMin: 180, criticalMin: 200, reassignMin: 220 });
    expect((await run(suspended)).escalations).toBe(0);
    const real = mk();
    real.data.set('cl_settings/sla', { suspendOutsideHours: false, firstAlertMin: 180, criticalMin: 200, reassignMin: 220 });
    expect((await run(real)).escalations).toBe(1); // 5 h de temps réel
  });
});

describe('runScheduler — réattribution au SLA', () => {
  const on = { autoReassign: true, firstAlertMin: 5, criticalMin: 10, reassignMin: 15, maxReassignments: 2 };
  const owned = (over: Doc = {}) => lead({ status: 'new', ownerId: 'u1', managerIds: ['m1'], sla: { startedAt: T(NOW - 20 * MIN), stoppedAt: null }, origin: { receivedAt: T(NOW - 20 * MIN), campaignId: null }, ...over });
  const setup = (settings: Doc | null, leadOver: Doc = {}) => {
    const db = new FakeDb();
    db.data.set('cl_leads/L1', owned(leadOver));
    withTelepro(db, 'u1', { load: { newLeads: 1, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
    withTelepro(db, 'u2');
    if (settings) db.data.set('cl_settings/sla', settings);
    return db;
  };
  it('lead non pris en charge au délai : confié à un autre télépro, par le moteur, avec compteurs et historique', async () => {
    const db = setup(on);
    const r = await run(db);
    expect(r).toMatchObject({ slaReassigned: 1 });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u2', reassignCount: 1 });
    expect(db.data.get('cl_leads/L1/events/sla_L1_1_reassigned')).toMatchObject({ type: 'reassigned', actorId: 'engine', before: { ownerId: 'u1' }, after: { ownerId: 'u2' } });
    expect((db.data.get('cl_profiles/u1')!.load as Doc).newLeads).toBe(0);
    expect((db.data.get('cl_profiles/u2')!.load as Doc).newLeads).toBe(1);
    expect(db.data.get('cl_audit/reassign_L1_sla_L1_1')).toMatchObject({ action: 'lead.reassign', actorId: 'engine' });
  });
  it('un second passage ne le réattribue pas aussitôt : le nouveau propriétaire a le même délai', async () => {
    const db = setup(on);
    await run(db);
    expect((await run(db)).slaReassigned).toBe(0);
  });
  it('règle désactivée (par défaut), délai non atteint, SLA arrêté, maximum atteint : jamais', async () => {
    expect((await run(setup(null))).slaReassigned).toBe(0);
    expect((await run(setup({ ...on, autoReassign: false }))).slaReassigned).toBe(0);
    expect((await run(setup({ ...on, reassignMin: 40, criticalMin: 30 }))).slaReassigned).toBe(0);
    expect((await run(setup(on, { sla: { startedAt: T(NOW - 20 * MIN), stoppedAt: T(NOW - 10 * MIN) } }))).slaReassigned).toBe(0);
    expect((await run(setup(on, { reassignCount: 2 }))).slaReassigned).toBe(0);
  });
  it("personne d\'autre ne peut le prendre : il reste à son propriétaire", async () => {
    const db = setup(on);
    db.data.delete('cl_profiles/u2');
    expect((await run(db)).slaReassigned).toBe(0);
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u1' });
  });
  it("la règle de la campagne l\'emporte sur la règle générale", async () => {
    const db = setup({ ...on, autoReassign: false }, { origin: { receivedAt: T(NOW - 20 * MIN), campaignId: 'c1' } });
    db.data.set('cl_campaigns/c1', { name: 'C', status: 'active', eligibleUserIds: [], eligibleTeamIds: [], autoEligible: true });
    db.data.set('cl_settings/sla_c1', { autoReassign: true, reassignMin: 12 });
    expect((await run(db)).slaReassigned).toBe(1);
  });
  it("un rappel client promis n\'est jamais réattribué automatiquement", async () => {
    const db = setup(on, { status: 'callback', nextAction: { type: 'client_callback', dueAt: T(NOW - 60 * MIN), reason: '' } });
    expect((await run(db)).slaReassigned).toBe(0);
  });
});


describe('runScheduler — reprise des transmissions au CRM principal (§11.9)', () => {
  const transmit = vi.mocked(transmitConversion);
  const OK = { ok: true, replay: false, state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1', documents: 0, message: 'ok' } as const;
  const conversion = (over: Doc = {}): Doc => ({ leadId: 'L1', state: 'pending', attempts: 0, lastAttemptAt: null, lockedUntil: null, lastError: null, ...over });
  const seedConv = (id: string, over: Doc = {}) => {
    const db = new FakeDb();
    db.data.set(`cl_conversions/${id}`, conversion(over));
    db.data.set(`cl_leads/${id}`, { fullName: 'Jean Dupont', status: 'transmitting', managerIds: ['m1'] });
    return db;
  };
  const reset = () => transmit.mockReset().mockResolvedValue(OK);

  it('relance une vente jamais transmise, au nom du système', async () => {
    reset();
    const db = seedConv('L1');
    const r = await run(db);
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls[0][1]).toMatchObject({ leadId: 'L1', actorId: 'system', nowMs: NOW });
    expect(r.transmitted).toBe(1);
  });
  it('ignore une conversion déjà confirmée', async () => {
    reset();
    await run(seedConv('L1', { state: 'confirmed' }));
    expect(transmit).not.toHaveBeenCalled();
  });
  it('respecte la pause croissante entre deux tentatives', async () => {
    reset();
    await run(seedConv('L1', { state: 'failed', attempts: 2, lastAttemptAt: T(NOW - 3 * MIN) }));
    expect(transmit).not.toHaveBeenCalled();
    await run(seedConv('L1', { state: 'failed', attempts: 2, lastAttemptAt: T(NOW - 5 * MIN) }));
    expect(transmit).toHaveBeenCalledTimes(1);
  });
  it('laisse une exécution en cours terminer (verrou)', async () => {
    reset();
    await run(seedConv('L1', { lockedUntil: T(NOW + 30_000) }));
    expect(transmit).not.toHaveBeenCalled();
  });
  it('ne retente jamais seul un doublon de dossier : décision humaine', async () => {
    reset();
    await run(seedConv('L1', { state: 'failed', attempts: 1, lastAttemptAt: T(NOW - 10 * MIN), lastError: { code: 'duplicate_dossier' } }));
    expect(transmit).not.toHaveBeenCalled();
  });
  it('après 5 échecs : plus de reprise automatique, une seule alerte vers les administrateurs', async () => {
    reset();
    const db = seedConv('L1', { state: 'failed', attempts: 5, lastAttemptAt: T(NOW - 3 * H) });
    db.data.set('users/adm1', { role: 'Administrateur' });
    db.data.set('users/u9', { role: 'Télépro Commercial' });
    const first = await run(db);
    expect(transmit).not.toHaveBeenCalled();
    expect(first.transmissionAlerts).toBe(1);
    expect(db.data.get('cl_notifications/transmit_alert_L1')).toMatchObject({ type: 'manager_alert', leadId: 'L1', recipientIds: ['adm1'], sound: 'critical', readBy: [] });
    expect((db.data.get('cl_notifications/transmit_alert_L1') as Doc).description).toContain('5 tentatives');
    expect(db.data.get('cl_conversions/L1')).toMatchObject({ alertedAt: expect.any(Date) });
    const second = await run(db);
    expect(second.transmissionAlerts).toBe(0);
  });
  it("un échec est rapporté sans bloquer; « déjà en cours » n'est pas une erreur", async () => {
    transmit.mockReset().mockResolvedValue({ ok: false, code: 'failed', message: 'La pièce n\'a pas pu être transférée.' });
    const r = await run(seedConv('L1'));
    expect(r.transmitted).toBe(0);
    expect(r.errors.some((e) => e.includes('transmission L1'))).toBe(true);
    transmit.mockReset().mockResolvedValue({ ok: false, code: 'busy', message: 'en cours' });
    expect((await run(seedConv('L1'))).errors.filter((e) => e.includes('transmission'))).toEqual([]);
  });
  it('au plus 5 reprises par passage', async () => {
    reset();
    const db = new FakeDb();
    for (let i = 1; i <= 8; i++) db.data.set(`cl_conversions/L${i}`, conversion({ leadId: `L${i}` }));
    const r = await run(db);
    expect(transmit).toHaveBeenCalledTimes(5);
    expect(r.transmitted).toBe(5);
  });
  it('le rapport enregistré porte les nouveaux compteurs', async () => {
    reset();
    const db = seedConv('L1');
    await run(db);
    expect(db.data.get('cl_config/schedulerStatus')).toMatchObject({ report: { transmitted: 1, transmissionAlerts: 0 } });
  });
});
