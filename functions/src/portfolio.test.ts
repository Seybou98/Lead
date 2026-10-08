import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que declareAbsence, endAbsence et transferLeads ÉCRIVENT.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }), arrayUnion: (...v: unknown[]) => ({ __union: v }) } }));

import { declareAbsence, endAbsence, TRANSFER_BATCH_MAX, transferLeads } from './portfolio';
import { DEFAULT_HANDLING } from '../../src/domain/portfolio/portfolio';

type Doc = Record<string, unknown>;
const T = (ms: number) => ({ toMillis: () => ms });

class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<R>(fn: (tx: FakeTx) => Promise<R>): Promise<R> {
    return fn(new FakeTx(this));
  }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string, private filters: [string, unknown][] = []) {}
  doc(id: string): FakeRef {
    return new FakeRef(this.db, `${this.path}/${id}`);
  }
  where(f: string, _op: string, v: unknown) {
    return new FakeCol(this.db, this.path, [...this.filters, [f, v]]);
  }
  async get() {
    const docs = [...this.db.data.keys()]
      .filter((k) => k.startsWith(`${this.path}/`) && !k.slice(this.path.length + 1).includes('/'))
      .map((k) => snap(this.db, k))
      .filter((s) => this.filters.every(([f, v]) => (s.data() as Doc)[f] === v));
    return { docs };
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol { return this.db.collection(name, `${this.path}/`); }
  async get() { return snap(this.db, this.path); }
  async set(data: Doc, opts?: { merge?: boolean }) { put(this.db, this.path, data, opts); }
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
  const v = val as { __inc?: number; __union?: unknown[] };
  if (v && typeof v === 'object' && '__inc' in v) cur[last] = Number(cur[last] ?? 0) + (v.__inc as number);
  else if (v && typeof v === 'object' && '__union' in v) cur[last] = [...new Set([...((cur[last] as unknown[]) ?? []), ...(v.__union as unknown[])])];
  else cur[last] = val;
};
function put(db: FakeDb, path: string, data: Doc, opts?: { merge?: boolean }) {
  const cur = db.data.get(path);
  if (opts?.merge && cur) {
    const next = { ...cur };
    for (const [k, v] of Object.entries(data)) setDeep(next, k, v);
    db.data.set(path, next);
  } else {
    const next: Doc = {};
    for (const [k, v] of Object.entries(data)) setDeep(next, k, v);
    db.data.set(path, next);
  }
}
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
    put(this.db, ref.path, data, opts);
  }
}

const NOW = Date.parse('2026-10-07T09:00:00Z');
const DAY = 86_400_000;
const H = 3_600_000;

function seed() {
  const db = new FakeDb();
  db.data.set('users/u1', { name: 'Sarah Cohen', role: 'telepro commercial', status: 'active' });
  db.data.set('users/u2', { name: 'Mehdi Benali', role: 'telepro commercial', status: 'active' });
  const load = { newLeads: 1, callbacks: 0, interested: 0, documents: 1, filesToBuild: 0, recycling: 0 };
  db.data.set('cl_profiles/u1', { operationalStatus: 'available', managerIds: ['m1'], load: { ...load } });
  db.data.set('cl_profiles/u2', { operationalStatus: 'available', managerIds: ['m1', 'm2'], primaryTeamId: 't1', load: { ...load, newLeads: 0, documents: 0 } });
  db.data.set('cl_leads/L1', { fullName: 'Jean Dupont', status: 'new', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], assignmentState: 'assigned', reassignCount: 0, version: 1, nextAction: null });
  db.data.set('cl_leads/L2', { fullName: 'Claire Martin', status: 'awaiting_documents', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], assignmentState: 'assigned', reassignCount: 0, version: 1, nextAction: null });
  return db;
}
const abs = (over: Record<string, unknown> = {}) => ({ type: 'leave', fromMs: NOW - H, toMs: NOW + 2 * DAY, reason: 'Congé validé', restoreDistribution: true, handling: DEFAULT_HANDLING, ...over });
const declare = (db: FakeDb, over: Partial<Parameters<typeof declareAbsence>[1]> = {}) =>
  declareAbsence(db as never, { uid: 'm1', role: 'manager', userId: 'u1', input: abs(), requestId: 'req-00000001', nowMs: NOW, ...over });

describe('declareAbsence', () => {
  it('enregistre l\'absence, pose le statut « Absent » si elle est en cours et trace l\'opération', async () => {
    const db = seed();
    const r = await declare(db);
    expect(r).toMatchObject({ ok: true, data: { absenceId: 'abs_req-00000001' } });
    expect(db.data.get('cl_absences/abs_req-00000001')).toMatchObject({ userId: 'u1', type: 'leave', reason: 'Congé validé', restoreDistribution: true, handled: false, createdBy: 'm1' });
    expect(db.data.get('cl_profiles/u1')).toMatchObject({ operationalStatus: 'absent' });
    expect(db.data.get('cl_audit/absence_abs_req-00000001')).toMatchObject({ action: 'absence.create', actorId: 'm1', entityId: 'u1', reason: 'Congé validé' });
  });
  it('absence future : aucun changement de statut avant l\'heure prévue (le moteur lit les dates)', async () => {
    const db = seed();
    await declare(db, { input: abs({ fromMs: NOW + DAY, toMs: NOW + 3 * DAY }) });
    expect(db.data.get('cl_profiles/u1')).toMatchObject({ operationalStatus: 'available' });
    expect(db.data.has('cl_absences/abs_req-00000001')).toBe(true);
  });
  it('un télépro en appel n\'est pas coupé : le statut attend le passage du planificateur', async () => {
    const db = seed();
    db.data.get('cl_profiles/u1')!.operationalStatus = 'on_call';
    await declare(db);
    expect(db.data.get('cl_profiles/u1')).toMatchObject({ operationalStatus: 'on_call' });
  });
  it('même demande rejouée : rien n\'est dupliqué', async () => {
    const db = seed();
    await declare(db);
    const again = await declare(db);
    expect(again).toMatchObject({ ok: true, data: { replay: true } });
    expect([...db.data.keys()].filter((k) => k.startsWith('cl_absences/'))).toHaveLength(1);
  });
  it('période qui en chevauche une autre : refusée', async () => {
    const db = seed();
    await declare(db);
    const r = await declare(db, { requestId: 'req-00000002', input: abs({ fromMs: NOW + DAY, toMs: NOW + 5 * DAY }) });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(await declare(db, { requestId: 'req-00000003', input: abs({ fromMs: NOW + 3 * DAY, toMs: NOW + 5 * DAY }) })).toMatchObject({ ok: true });
  });
  it('droits : un manager hors périmètre ou un télépro refusé ; l\'administrateur passe', async () => {
    expect(await declare(seed(), { uid: 'm9' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await declare(seed(), { uid: 'root', role: 'admin' })).toMatchObject({ ok: true });
  });
  it('cible sans profil, ou qui n\'est pas télépro : refusée', async () => {
    const noProfile = seed();
    noProfile.data.delete('cl_profiles/u1');
    expect(await declare(noProfile)).toMatchObject({ ok: false, code: 'invalid' });
    const boss = seed();
    boss.data.set('users/u1', { name: 'X', role: 'manager', status: 'active' });
    expect(await declare(boss)).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('saisie invalide : refusée avec les champs en cause, rien n\'est écrit', async () => {
    const db = seed();
    const before = JSON.stringify([...db.data.entries()]);
    const r = await declare(db, { input: abs({ reason: '', toMs: NOW - DAY }) });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    if (!r.ok) expect(Object.keys(r.errors ?? {}).sort()).toEqual(['period', 'reason']);
    expect(JSON.stringify([...db.data.entries()])).toBe(before);
  });
});

describe('endAbsence', () => {
  it('fin anticipée : la fin devient maintenant, le télépro est de nouveau disponible, trace', async () => {
    const db = seed();
    await declare(db);
    const r = await endAbsence(db as never, { uid: 'm1', role: 'manager', absenceId: 'abs_req-00000001', nowMs: NOW + H });
    expect(r.ok).toBe(true);
    expect(db.data.get('cl_absences/abs_req-00000001')).toMatchObject({ endedEarlyBy: 'm1' });
    expect((db.data.get('cl_absences/abs_req-00000001')!.to as Date).getTime()).toBe(NOW + H);
    expect(db.data.get('cl_profiles/u1')).toMatchObject({ operationalStatus: 'available' });
    expect(db.data.get('cl_audit/absence_end_abs_req-00000001')).toMatchObject({ action: 'absence.end' });
  });
  it('absence déjà terminée, inconnue ou hors périmètre : refusée', async () => {
    const db = seed();
    await declare(db);
    expect(await endAbsence(db as never, { uid: 'm1', role: 'manager', absenceId: 'abs_req-00000001', nowMs: NOW + 5 * DAY })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await endAbsence(db as never, { uid: 'm1', role: 'manager', absenceId: 'absente', nowMs: NOW })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await endAbsence(db as never, { uid: 'm9', role: 'manager', absenceId: 'abs_req-00000001', nowMs: NOW })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('transferLeads', () => {
  const run = (db: FakeDb, over: Partial<Parameters<typeof transferLeads>[1]> = {}) =>
    transferLeads(db as never, { uid: 'm1', role: 'manager', fromUid: 'u1', batchId: 'batch-00000001', assignments: [{ leadId: 'L1', targetUid: 'u2' }, { leadId: 'L2', targetUid: 'u2' }], reason: 'Congé de Sarah', returnAtMs: null, nowMs: NOW, ...over });

  it('transfère chaque lead, garde le propriétaire historique et enregistre le lot', async () => {
    const db = seed();
    const r = await run(db);
    expect(r).toMatchObject({ ok: true, data: { done: ['L1', 'L2'], failed: [] } });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u2', originalOwnerId: 'u1', reassignCount: 1 });
    expect(db.data.get('cl_leads/batch-00000001_L1')).toBeUndefined();
    expect(db.data.get('cl_leads/L1/events/batch-00000001_L1_reassigned')).toMatchObject({ type: 'reassigned', reason: 'Congé de Sarah', before: { ownerId: 'u1' }, after: { ownerId: 'u2' } });
    expect(db.data.get('cl_transfers/batch-00000001')).toMatchObject({ fromUid: 'u1', reason: 'Congé de Sarah', temporary: false, returnAt: null, returned: false, leadIds: ['L1', 'L2'], toUids: ['u2'] });
    expect((db.data.get('cl_profiles/u1')!.load as Doc)).toMatchObject({ newLeads: 0, documents: 0 });
    expect((db.data.get('cl_profiles/u2')!.load as Doc)).toMatchObject({ newLeads: 1, documents: 1 });
  });
  it('le propriétaire historique n\'est jamais écrasé par un second transfert', async () => {
    const db = seed();
    await run(db);
    db.data.set('cl_profiles/u3', { managerIds: ['m1'], load: {} });
    db.data.set('users/u3', { name: 'Z', role: 'telepro commercial', status: 'active' });
    await run(db, { fromUid: 'u2', batchId: 'batch-00000002', assignments: [{ leadId: 'L1', targetUid: 'u3' }] });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u3', originalOwnerId: 'u1' });
  });
  it('transfert temporaire : le retour programmé est enregistré avec le lot', async () => {
    const db = seed();
    await run(db, { returnAtMs: NOW + 2 * DAY });
    expect(db.data.get('cl_transfers/batch-00000001')).toMatchObject({ temporary: true });
    expect((db.data.get('cl_transfers/batch-00000001')!.returnAt as Date).getTime()).toBe(NOW + 2 * DAY);
  });
  it('rejeu du même lot : aucun élément n\'est transféré deux fois', async () => {
    const db = seed();
    await run(db);
    const again = await run(db);
    expect(again.ok).toBe(true);
    expect(db.data.get('cl_leads/L1')).toMatchObject({ reassignCount: 1 });
  });
  it('élément refusé : les autres passent, le refus est détaillé', async () => {
    const db = seed();
    const r = await run(db, { assignments: [{ leadId: 'L1', targetUid: 'u2' }, { leadId: 'L2', targetUid: 'inconnu' }] });
    expect(r).toMatchObject({ ok: true, data: { done: ['L1'] } });
    expect((r as { data: { failed: unknown[] } }).data.failed).toHaveLength(1);
    expect(db.data.get('cl_transfers/batch-00000001')).toMatchObject({ leadIds: ['L1'] });
  });
  it('tout refusé : échec, aucun lot enregistré', async () => {
    const db = seed();
    const r = await run(db, { assignments: [{ leadId: 'L1', targetUid: 'inconnu' }] });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(db.data.has('cl_transfers/batch-00000001')).toBe(false);
  });
  it('garde-fous : motif, taille du lot, droits, date de retour', async () => {
    const db = seed();
    expect(await run(db, { reason: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(db, { assignments: [] })).toMatchObject({ ok: false, code: 'invalid' });
    const big = Array.from({ length: TRANSFER_BATCH_MAX + 1 }, (_, i) => ({ leadId: `X${i}`, targetUid: 'u2' }));
    expect(await run(db, { assignments: big })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(db, { role: 'telepro' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(db, { returnAtMs: NOW - H })).toMatchObject({ ok: false, code: 'invalid' });
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u1' });
  });
  it('un manager hors périmètre du lead ne transfère rien', async () => {
    const db = seed();
    const r = await run(db, { uid: 'm9' });
    expect(r.ok).toBe(false);
    expect(db.data.get('cl_leads/L1')).toMatchObject({ ownerId: 'u1' });
  });
});
