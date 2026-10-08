import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que reassignLead ÉCRIT, pas le moteur Firestore.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { reassignLead, type ReassignArgs } from './reassign';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    return fn(new FakeTx(this));
  }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string) {}
  doc(id: string): FakeRef {
    return new FakeRef(this.db, `${this.path}/${id}`);
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol {
    return this.db.collection(name, `${this.path}/`);
  }
  async get() { return snap(this.db, this.path); }
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k] };
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
  async get(ref: FakeRef | FakeCol) {
    if (this.wrote) throw new Error('lecture après écriture : interdit dans une transaction Firestore');
    if (ref instanceof FakeCol) {
      const docs = [...this.db.data.keys()].filter((k) => k.startsWith(`${ref.path}/`) && !k.slice(ref.path.length + 1).includes('/')).map((k) => snap(this.db, k));
      return { docs };
    }
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

const NOW = Date.UTC(2026, 9, 7, 8, 0);

function seed(over: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', {
    id: 'L1', fullName: 'Jean Dupont', status: 'callback', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], reassignCount: 0,
    nextAction: { actionId: 'act1', type: 'client_callback', dueAt: { toMillis: () => NOW }, priority: 'P0', reason: 'Rappel' }, version: 3, ...over,
  });
  db.data.set('cl_actions/act1', { id: 'act1', state: 'open', leadId: 'L1', ownerId: 'u1', managerIds: ['m1'] });
  db.data.set('cl_profiles/u1', { load: { newLeads: 0, callbacks: 2, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
  db.data.set('cl_profiles/u2', { primaryTeamId: 't2', managerIds: ['m1', 'm2'], load: { newLeads: 1, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
  db.data.set('users/u2', { name: 'Sarah Martin', email: 's@x.fr', role: 'telepro commercial', status: 'active' });
  return db;
}

let n = 0;
const args = (over: Partial<ReassignArgs> = {}): ReassignArgs => ({
  uid: 'm1', role: 'manager', leadId: 'L1', targetUid: 'u2', reason: 'Propriétaire absent', requestId: `req-${String(++n).padStart(8, '0')}`, nowMs: NOW, ...over,
});
const run = (db: FakeDb, a: ReassignArgs) => reassignLead(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { ownerId: string | null; managerIds: string[]; version: number; reassignCount: number; nextAction: Doc | null };
const load = (db: FakeDb, uid: string) => db.data.get(`cl_profiles/${uid}`)!.load as Doc;

describe('reassignLead', () => {
  it('change le propriétaire, déplace la charge, historise, notifie et trace', async () => {
    const db = seed();
    const a = args();
    const r = await run(db, a);
    expect(r).toMatchObject({ ok: true, replay: false, ownerId: 'u2' });
    expect(lead(db)).toMatchObject({ ownerId: 'u2', teamId: 't2', assignmentState: 'assigned', bufferReason: null, reassignCount: 1, version: 4 });
    expect([...lead(db).managerIds].sort()).toEqual(['m1', 'm2']);
    expect(load(db, 'u1').callbacks).toBe(1);
    expect(load(db, 'u2').callbacks).toBe(1);
    expect(db.data.get('cl_actions/act1')).toMatchObject({ ownerId: 'u2', teamId: 't2' });
    expect(db.data.get(`cl_leads/L1/events/${a.requestId}_reassigned`)).toMatchObject({ type: 'reassigned', actorId: 'm1', before: { ownerId: 'u1' }, after: { ownerId: 'u2' }, reason: 'Propriétaire absent' });
    expect(db.data.get(`cl_notifications/L1_${a.requestId}_to`)).toMatchObject({ recipientIds: ['u2'], leadId: 'L1' });
    expect(db.data.get(`cl_notifications/L1_${a.requestId}_from`)).toMatchObject({ recipientIds: ['u1'] });
    expect(db.data.get(`cl_audit/reassign_L1_${a.requestId}`)).toMatchObject({ action: 'lead.reassign', actorId: 'm1', reason: 'Propriétaire absent' });
  });

  it("attribution d'un lead de la file tampon : action créée, charge ajoutée au seul nouveau télépro", async () => {
    const db = seed({ status: 'new', ownerId: null, nextAction: null, assignmentState: 'buffer', bufferReason: 'no_candidate', managerIds: ['m1'] });
    const a = args();
    expect(await run(db, a)).toMatchObject({ ok: true });
    expect(lead(db).nextAction).toMatchObject({ type: 'take_new_lead', priority: 'P1' });
    expect(db.data.get(`cl_actions/L1_take_new_lead_${a.requestId}`)).toMatchObject({ state: 'open', ownerId: 'u2', type: 'take_new_lead' });
    expect(load(db, 'u2').newLeads).toBe(2);
    expect(load(db, 'u1').callbacks).toBe(2);
  });

  it("rejeu du même identifiant : même réponse, rien n'est réécrit", async () => {
    const db = seed();
    const a = args();
    await run(db, a);
    const version = lead(db).version;
    expect(await run(db, a)).toMatchObject({ ok: true, replay: true });
    expect(lead(db).version).toBe(version);
    expect(load(db, 'u2').callbacks).toBe(1);
  });

  it("refus métier : rien n'est écrit", async () => {
    const db = seed();
    const before = JSON.stringify([...db.data.entries()]);
    for (const a of [args({ reason: '' }), args({ targetUid: 'u1' }), args({ uid: 'm9' }), args({ targetUid: 'absent' })]) {
      expect((await run(db, a)).ok).toBe(false);
    }
    expect(JSON.stringify([...db.data.entries()])).toBe(before);
  });

  it('codes de refus', async () => {
    expect(await run(seed(), args({ leadId: 'ABSENT' }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await run(seed(), args({ uid: 'm9' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(seed({ status: 'converted' }), args())).toMatchObject({ ok: false, code: 'lead_closed' });
    expect(await run(seed(), args({ reason: '' }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it("cible sans compte actif ou qui n'est pas télépro : refusée", async () => {
    const inactive = seed();
    inactive.data.set('users/u2', { name: 'S', role: 'telepro commercial', status: 'inactive' });
    expect(await run(inactive, args())).toMatchObject({ ok: false, code: 'invalid' });
    const tech = seed();
    tech.data.set('users/u2', { name: 'S', role: 'technicien', status: 'active' });
    expect(await run(tech, args())).toMatchObject({ ok: false, code: 'invalid' });
  });

  it("l'administrateur peut réattribuer hors de son périmètre", async () => {
    expect(await run(seed(), args({ uid: 'root', role: 'admin' }))).toMatchObject({ ok: true });
  });
});

describe('reassignLead — attribution automatique (planificateur)', () => {
  const buffered = () => seed({ status: 'new', ownerId: null, nextAction: null, assignmentState: 'buffer', bufferReason: 'no_candidate' });
  const engine = (over: Partial<ReassignArgs> = {}) => args({ uid: 'engine', role: 'admin', engine: true, reason: 'Capacité réapparue', ...over });
  it("attribue un lead de la file tampon et l'inscrit comme attribué par le moteur", async () => {
    const db = buffered();
    const a = engine();
    expect(await run(db, a)).toMatchObject({ ok: true, ownerId: 'u2' });
    expect(db.data.get(`cl_leads/L1/events/${a.requestId}_reassigned`)).toMatchObject({ type: 'assigned', actorId: 'engine' });
    expect(lead(db).ownerId).toBe('u2');
  });
  it("refuse un lead déjà attribué (course entre deux passages) : rien n'est modifié", async () => {
    const db = seed();
    const before = JSON.stringify([...db.data.entries()]);
    expect(await run(db, engine())).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify([...db.data.entries()])).toBe(before);
  });
  it("refuse un télépro au plafond, suspendu ou en pause, alors qu'un manager peut le décider", async () => {
    for (const patch of [{ load: { newLeads: 10 } }, { distributionSuspended: true }, { operationalStatus: 'paused' }]) {
      const db = buffered();
      db.data.set('cl_profiles/u2', { primaryTeamId: 't2', managerIds: ['m1'], load: { newLeads: 1 }, capacity: { newLeadsCap: 10 }, ...patch });
      expect(await run(db, engine())).toMatchObject({ ok: false, code: 'invalid' });
    }
    const full = buffered();
    full.data.set('cl_profiles/u2', { primaryTeamId: 't2', managerIds: ['m1'], load: { newLeads: 10 }, capacity: { newLeadsCap: 10 } });
    expect(await run(full, args())).toMatchObject({ ok: true });
  });
});
