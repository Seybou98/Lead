import { describe, expect, it, vi } from 'vitest';

// Base en mémoire : on vérifie ce que syncMainStatuses ÉCRIT côté CRM Leads, et qu'il ne modifie JAMAIS le CRM principal.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { syncMainStatuses } from './mainSync';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  /** Chemins écrits : sert à prouver qu'aucune écriture n'atteint le CRM principal. */
  writes: string[] = [];
  collection(name: string, prefix = ''): FakeCol { return new FakeCol(this, `${prefix}${name}`); }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    const tx = new FakeTx(this);
    const out = await fn(tx);
    tx.commit();
    return out;
  }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string, private filters: [string, unknown][] = [], private max = Infinity) {}
  doc(id: string): FakeRef { return new FakeRef(this.db, `${this.path}/${id}`); }
  where(f: string, _op: string, v: unknown) { return new FakeCol(this.db, this.path, [...this.filters, [f, v]], this.max); }
  limit(n: number) { return new FakeCol(this.db, this.path, this.filters, n); }
  async get() {
    const docs = [...this.db.data.keys()]
      .filter((k) => k.startsWith(`${this.path}/`) && !k.slice(this.path.length + 1).includes('/'))
      .map((k) => snap(this.db, k))
      .filter((s) => this.filters.every(([f, v]) => (s.data() as Doc)[f] === v))
      .slice(0, this.max);
    return { docs, empty: docs.length === 0 };
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string) { return this.db.collection(name, `${this.path}/`); }
  async get() { return snap(this.db, this.path); }
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  const get = (k: string) => (d ? k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Doc)[p] : undefined), d) ?? d[k] : undefined);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get, ref: new FakeRef(db, path) };
};
const setDeep = (obj: Doc, key: string, val: unknown) => {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] = (cur[p] && typeof cur[p] === 'object' ? { ...(cur[p] as Doc) } : {})) as Doc;
  const inc = val as { __inc?: number };
  const last = parts[parts.length - 1];
  cur[last] = inc && typeof inc === 'object' && '__inc' in inc ? Number(cur[last] ?? 0) + (inc.__inc as number) : val;
};
class FakeTx {
  private ops: (() => void)[] = [];
  private wrote = false;
  constructor(private db: FakeDb) {}
  async get(ref: FakeRef) {
    if (this.wrote) throw new Error('lecture après écriture : interdit dans une transaction Firestore');
    return snap(this.db, ref.path);
  }
  update(ref: FakeRef, patch: Doc) { this.wrote = true; this.ops.push(() => { this.db.writes.push(ref.path); const c = this.db.data.get(ref.path); if (!c) throw new Error(`update inexistant : ${ref.path}`); for (const [k, v] of Object.entries(patch)) setDeep(c, k, v); }); }
  set(ref: FakeRef, data: Doc) { this.wrote = true; this.ops.push(() => { this.db.writes.push(ref.path); this.db.data.set(ref.path, { ...data }); }); }
  commit() { for (const op of this.ops) op(); }
}

const NOW = Date.UTC(2026, 9, 9, 10, 0);

function seed(main: { dossier?: Doc; client?: Doc | null; sub?: Doc | null } = {}, leadOver: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { id: 'L1', status: 'converted', fullName: 'Jean Dupont', ownerId: 'u1', managerIds: ['m1'], commercialState: 'sale_committed', financialState: 'none', ...leadOver });
  db.data.set('cl_sales/L1', { id: 'L1', commercialState: 'sale_committed', financialState: 'none' });
  db.data.set('cl_conversions/L1', { leadId: 'L1', state: 'confirmed', dossierId: 'cl_L1', clientId: '2612345' });
  db.data.set('dossiers/cl_L1', { status: 'incomplet', subventionId: 'sub1', leadId: 'L1', ...(main.dossier ?? {}) });
  db.data.set('subventions/sub1', { dossier: { statut: 'incomplet_a_completer' }, ...(main.sub ?? {}) });
  if (main.client) db.data.set('clients/c1', { sourceDossierId: 'cl_L1', ...main.client });
  return db;
}
const run = (db: FakeDb, now = NOW) => syncMainStatuses(db as never, now);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { mainStatus: Doc; status: string; commercialState: string; saleTrack?: Doc };
const conv = (db: FakeDb) => db.data.get('cl_conversions/L1') as Doc;
const events = (db: FakeDb) => [...db.data.entries()].filter(([k]) => k.startsWith('cl_leads/L1/events/') || k.startsWith('cl_leads/L1/events')).map(([, v]) => v);

describe('syncMainStatuses — première lecture', () => {
  it('pose l’étape sur le lead et la conversion, avec une entrée d’historique', async () => {
    const db = seed();
    const r = await run(db);
    expect(r).toMatchObject({ read: 1, changed: 1, cancelled: 0, errors: [] });
    expect(lead(db).mainStatus).toMatchObject({ stage: 'dossier_incomplete', label: 'Dossier incomplet' });
    expect(conv(db)).toMatchObject({ mainStage: 'dossier_incomplete', mainTerminal: false, mainSeq: 1 });
    expect(db.data.get('cl_leads/L1/events/main_L1_1')).toMatchObject({ type: 'conversion', actorId: 'system', note: 'CRM principal : Dossier incomplet', meta: { op: 'main_status' } });
  });
  it('première lecture « incomplet » : aucune notification', async () => {
    const db = seed();
    await run(db);
    expect([...db.data.keys()].some((k) => k.startsWith('cl_notifications/'))).toBe(false);
  });
  it('le statut du lead (« Converti ») n’est jamais touché', async () => {
    const db = seed({ dossier: { status: 'valide' } });
    await run(db);
    expect(lead(db).status).toBe('converted');
  });
});

describe('syncMainStatuses — idempotence', () => {
  it('relire sans changement ne réécrit rien', async () => {
    const db = seed();
    await run(db);
    const writes = db.writes.length;
    const r = await run(db, NOW + 300_000);
    expect(r.changed).toBe(0);
    expect(db.writes.length).toBe(writes);
    expect(conv(db).mainSeq).toBe(1);
  });
});

describe('syncMainStatuses — évolution du dossier', () => {
  it('validé : historique, notification, jalon', async () => {
    const db = seed();
    await run(db);
    (db.data.get('dossiers/cl_L1') as Doc).status = 'valide';
    const r = await run(db, NOW + 300_000);
    expect(r.changed).toBe(1);
    expect(lead(db).mainStatus).toMatchObject({ stage: 'dossier_validated' });
    expect(lead(db).mainStatus.validatedAt).toBeInstanceOf(Date);
    expect(db.data.get('cl_leads/L1/events/main_L1_2')).toMatchObject({ note: 'CRM principal : Dossier incomplet → Dossier validé' });
    expect(db.data.get('cl_notifications/main_L1_2')).toMatchObject({ title: 'Dossier validé', leadId: 'L1', recipientIds: ['u1', 'm1'], sound: null, readBy: [] });
  });
  it('client créé puis chantier puis installé puis facturé : jalons et fin de surveillance', async () => {
    const db = seed({ dossier: { status: 'valide', clientId: 'c1' }, client: { status: 'aprogrammer' } });
    await run(db);
    expect(lead(db).mainStatus.stage).toBe('client_created');
    for (const [status, stage] of [['placer', 'scheduled'], ['encours', 'in_progress'], ['terminer', 'installed'], ['facturer_cee_mpr', 'invoiced']] as const) {
      (db.data.get('clients/c1') as Doc).status = status;
      await run(db, NOW + 600_000);
      expect(lead(db).mainStatus.stage).toBe(stage);
    }
    expect(lead(db).mainStatus.installedAt).toBeInstanceOf(Date);
    expect(lead(db).mainStatus.invoicedAt).toBeInstanceOf(Date);
    expect(conv(db).mainTerminal).toBe(true);
    const writes = db.writes.length;
    await run(db, NOW + 900_000);
    expect(db.writes.length).toBe(writes); // facturé : plus relu
  });
  it('le client est retrouvé par sourceDossierId quand le dossier ne le référence pas', async () => {
    const db = seed({ dossier: { status: 'valide' }, client: { status: 'terminer' } });
    await run(db);
    expect(lead(db).mainStatus.stage).toBe('installed');
  });
  it('dossier à nouveau incomplet après validation : notification', async () => {
    const db = seed({ dossier: { status: 'valide' } });
    await run(db);
    (db.data.get('dossiers/cl_L1') as Doc).status = 'incomplet';
    (db.data.get('subventions/sub1') as Doc).dossier = { statut: 'incomplet_a_completer' };
    await run(db, NOW + 300_000);
    expect(db.data.get('cl_notifications/main_L1_2')).toMatchObject({ title: 'Dossier à nouveau incomplet' });
  });
});

describe('syncMainStatuses — annulation côté CRM principal', () => {
  it('retire la vente des ventes nettes, avec motif, audit et signal critique', async () => {
    const db = seed({ dossier: { status: 'valide', clientId: 'c1' }, client: { status: 'aprogrammer' } });
    await run(db);
    (db.data.get('clients/c1') as Doc).status = 'annuler';
    const r = await run(db, NOW + 300_000);
    expect(r).toMatchObject({ changed: 1, cancelled: 1 });
    expect(lead(db)).toMatchObject({ commercialState: 'cancelled', status: 'converted', saleTrack: { cancelReason: 'Annulé dans le CRM principal' } });
    expect(db.data.get('cl_sales/L1')).toMatchObject({ commercialState: 'cancelled', track: { cancelReason: 'Annulé dans le CRM principal' } });
    expect(db.data.get('cl_audit/main_cancel_L1')).toMatchObject({ action: 'sale.cancel_from_main', before: { commercialState: 'sale_committed' }, after: { commercialState: 'cancelled' } });
    expect(db.data.get('cl_notifications/main_L1_2')).toMatchObject({ title: 'Dossier annulé dans le CRM principal', sound: 'critical' });
    expect(conv(db).mainTerminal).toBe(true);
  });
  it('une vente déjà rétractée côté Leads garde son état et son motif', async () => {
    const db = seed({ dossier: { status: 'abandonner' } }, { commercialState: 'retracted', saleTrack: { cancelReason: 'Rétractation du client' } });
    const r = await run(db);
    expect(r.cancelled).toBe(0);
    expect(lead(db)).toMatchObject({ commercialState: 'retracted', saleTrack: { cancelReason: 'Rétractation du client' } });
    expect(lead(db).mainStatus.stage).toBe('cancelled');
  });
});

describe('syncMainStatuses — garanties', () => {
  it('n’écrit jamais dans le CRM principal', async () => {
    const db = seed({ dossier: { status: 'valide', clientId: 'c1' }, client: { status: 'terminer' } });
    await run(db);
    expect(db.writes.every((p) => p.startsWith('cl_'))).toBe(true);
  });
  it('statut inconnu : étape « unknown », rien d’inventé', async () => {
    const db = seed({ dossier: { status: 'valide', clientId: 'c1' }, client: { status: 'sav' } });
    await run(db);
    expect(lead(db).mainStatus.stage).toBe('unknown');
    expect(conv(db).mainTerminal).toBe(false);
  });
  it('dossier supprimé côté CRM principal : la dernière étape connue est conservée', async () => {
    const db = seed();
    await run(db);
    db.data.delete('dossiers/cl_L1');
    const r = await run(db, NOW + 300_000);
    expect(r.changed).toBe(0);
    expect(lead(db).mainStatus.stage).toBe('dossier_incomplete');
  });
  it('conversion non confirmée ou sans dossier : ignorée', async () => {
    const db = seed();
    (conv(db) as Doc).state = 'failed';
    expect((await run(db)).read).toBe(0);
    const db2 = seed();
    (conv(db2) as Doc).dossierId = null;
    expect((await run(db2)).read).toBe(0);
  });
  it('un dossier en échec ne bloque pas les autres', async () => {
    const db = seed();
    db.data.set('cl_conversions/L2', { leadId: 'L2', state: 'confirmed', dossierId: 'cl_L2' });
    db.data.set('dossiers/cl_L2', { status: 'valide' }); // lead L2 absent : ignoré proprement
    const r = await run(db);
    expect(r.errors).toEqual([]);
    expect(lead(db).mainStatus.stage).toBe('dossier_incomplete');
    expect(events(db).length).toBeGreaterThan(0);
  });
});
