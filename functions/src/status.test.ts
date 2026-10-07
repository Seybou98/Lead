import { describe, expect, it, vi } from 'vitest';
import { setOwnStatus } from './status';
import { handleStatusHttp, type StatusHttpDeps } from './statusHttp';
import type { StatusResult } from './status';

type Doc = Record<string, unknown>;

// Base en mémoire minimale : on vérifie ce que setOwnStatus ÉCRIT (champs, historique), pas Firestore lui-même.
class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string) {
    return { doc: (id: string) => ({ path: `${name}/${id}`, id }) };
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    return fn(new FakeTx(this));
  }
}
class FakeTx {
  constructor(private db: FakeDb) {}
  async get(ref: { path: string }) {
    const d = this.db.data.get(ref.path);
    return { exists: d !== undefined, get: (k: string) => d?.[k] };
  }
  update(ref: { path: string }, patch: Doc) {
    const cur = this.db.data.get(ref.path);
    if (!cur) throw new Error('update d’un document inexistant');
    Object.assign(cur, patch);
  }
  set(ref: { path: string }, data: Doc) {
    this.db.data.set(ref.path, { ...data });
  }
}

const NOW = Date.UTC(2026, 9, 7, 12, 0);
const seed = (status: unknown = 'available') => {
  const db = new FakeDb();
  db.data.set('cl_profiles/u1', { operationalStatus: status, operationalStatusSince: { toMillis: () => NOW - 3600_000 } });
  return db;
};
const run = (db: FakeDb, requested: unknown) => setOwnStatus(db as never, { uid: 'u1', requested, nowMs: NOW });
const profile = (db: FakeDb) => db.data.get('cl_profiles/u1') as Doc;

describe('setOwnStatus', () => {
  it('passe en pause : statut, horodatage et historique', async () => {
    const db = seed();
    expect(await run(db, 'paused')).toMatchObject({ ok: true, changed: true, status: 'paused', sinceMs: NOW });
    expect(profile(db).operationalStatus).toBe('paused');
    expect((profile(db).operationalStatusSince as Date).getTime()).toBe(NOW);
    expect(db.data.get(`cl_audit/status_u1_${NOW}`)).toMatchObject({
      actorId: 'u1',
      action: 'operational_status_changed',
      entityType: 'profile',
      entityId: 'u1',
      before: { operationalStatus: 'available' },
      after: { operationalStatus: 'paused' },
    });
  });

  it('même statut : rien n’est écrit, l’horodatage d’origine est conservé', async () => {
    const db = seed('paused');
    const r = await run(db, 'paused');
    expect(r).toMatchObject({ ok: true, changed: false, status: 'paused', sinceMs: NOW - 3600_000 });
    expect([...db.data.keys()]).toEqual(['cl_profiles/u1']);
  });

  it('refuse un statut interdit et n’écrit rien', async () => {
    const db = seed();
    expect(await run(db, 'absent')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(db, 'constructor')).toMatchObject({ ok: false, code: 'invalid' });
    expect(profile(db).operationalStatus).toBe('available');
    expect([...db.data.keys()]).toEqual(['cl_profiles/u1']);
  });

  it('un statut posé par le manager (absent, indisponible) ne se change pas', async () => {
    for (const locked of ['absent', 'unavailable']) {
      const db = seed(locked);
      expect(await run(db, 'available')).toMatchObject({ ok: false, code: 'locked' });
      expect(profile(db).operationalStatus).toBe(locked);
    }
  });

  it('profil inexistant : 404 explicite', async () => {
    expect(await run(new FakeDb(), 'paused')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('un statut illisible en base est traité comme « Disponible » plutôt que de planter', async () => {
    const db = seed('???');
    expect(await run(db, 'paused')).toMatchObject({ ok: true, changed: true });
    expect(db.data.get(`cl_audit/status_u1_${NOW}`)).toMatchObject({ before: { operationalStatus: 'available' } });
  });

  it('« En appel » est accepté (posé par le démarrage d’un appel)', async () => {
    expect(await run(seed(), 'on_call')).toMatchObject({ ok: true, status: 'on_call' });
  });
});

describe('handleStatusHttp', () => {
  const OK: StatusResult = { ok: true, changed: true, status: 'paused', sinceMs: 1 };
  const deps = (over: Partial<StatusHttpDeps> = {}): StatusHttpDeps => ({
    verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
    run: vi.fn(async () => OK),
    log: { warn: vi.fn(), error: vi.fn() },
    ...over,
  });
  const req = (over: Record<string, unknown> = {}) => ({ method: 'POST', authorization: 'Bearer good', rawBody: JSON.stringify({ status: 'paused' }), ...over }) as never;

  it('200 : l’identité vient du jeton, jamais du corps', async () => {
    const d = deps();
    const r = await handleStatusHttp(req({ rawBody: JSON.stringify({ status: 'paused', uid: 'pirate' }) }), d);
    expect(r).toEqual({ status: 200, body: OK });
    expect(d.run).toHaveBeenCalledWith({ uid: 'u1', requested: 'paused' });
  });

  it('405 / 401 / 400', async () => {
    const d = deps();
    expect((await handleStatusHttp(req({ method: 'GET' }), d)).status).toBe(405);
    for (const authorization of [undefined, '', 'good', 'Bearer bad']) expect((await handleStatusHttp(req({ authorization }), d)).status).toBe(401);
    for (const rawBody of [undefined, '{', 'null', '[]', '{}', JSON.stringify({ status: 3 })]) expect((await handleStatusHttp(req({ rawBody }), d)).status).toBe(400);
    expect(d.run).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['locked', 409],
    ['invalid', 422],
  ] as const)('refus « %s » → %i', async (code, status) => {
    const d = deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'Pourquoi' })) });
    const r = await handleStatusHttp(req(), d);
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ ok: false, error: code, message: 'Pourquoi' });
  });

  it('500 sans détail technique, erreur journalisée', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('boom secret'); }) });
    const r = await handleStatusHttp(req(), d);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('boom');
    expect(d.log.error).toHaveBeenCalled();
  });
});
