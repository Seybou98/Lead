import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que applySaleAction ÉCRIT (états du lead et de la vente,
// historique, audit, notifications, idempotence), pas le moteur Firestore.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { applySaleAction, type SaleTrackArgs } from './saleTrack';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  autoId = 0;
  collection(name: string, prefix = ''): FakeCol { return new FakeCol(this, `${prefix}${name}`); }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> { return fn(new FakeTx(this)); }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string) {}
  doc(id?: string): FakeRef { return new FakeRef(this.db, `${this.path}/${id ?? `auto${++this.db.autoId}`}`); }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol { return this.db.collection(name, `${this.path}/`); }
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
  set(ref: FakeRef, data: Doc) { this.wrote = true; this.db.data.set(ref.path, { ...data }); }
}

const NOW = Date.UTC(2026, 9, 8, 12, 0);

function seed(over: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { id: 'L1', status: 'converted', ownerId: 'u1', managerIds: ['m1'], fullName: 'Jean Dupont', saleId: 'L1', commercialState: 'sale_committed', financialState: 'none', version: 5, ...over });
  db.data.set('cl_sales/L1', { id: 'L1', number: 'V-2026-00042', remainderCents: 349_000, commercialState: 'sale_committed', financialState: 'none' });
  return db;
}
let n = 0;
const args = (action: SaleTrackArgs['action'], over: Partial<SaleTrackArgs> = {}): SaleTrackArgs => ({ uid: 'u1', role: 'telepro', leadId: 'L1', requestId: `req-${String(++n).padStart(8, '0')}`, action, nowMs: NOW, ...over });
const run = (db: FakeDb, a: SaleTrackArgs) => applySaleAction(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { track?: Doc; saleTrack: Doc; securedAt?: Date; version: number };
const sale = (db: FakeDb) => db.data.get('cl_sales/L1') as Doc & { track: Doc; securedAt?: Date };
const manager = { uid: 'm1', role: 'manager' as const };
const keys = (db: FakeDb, prefix: string) => [...db.data.keys()].filter((k) => k.startsWith(prefix));

describe('applySaleAction — états et traces', () => {
  it("offre envoyée : états du lead et de la vente, date d'envoi, historique, audit", async () => {
    const db = seed();
    const r = await run(db, args({ kind: 'offer_sent', channel: 'email' }));
    expect(r).toMatchObject({ ok: true, replay: false, commercialState: 'offer_sent', financialState: 'none', secured: false });
    expect(lead(db)).toMatchObject({ commercialState: 'offer_sent', version: 6, saleTrack: { offerChannel: 'email' } });
    expect(lead(db).saleTrack.offerSentAt).toEqual(new Date(NOW));
    expect(sale(db)).toMatchObject({ commercialState: 'offer_sent', track: { offerChannel: 'email' } });
    const ev = db.data.get(keys(db, 'cl_leads/L1/events/')[0])!;
    expect(ev).toMatchObject({ type: 'conversion', actorId: 'u1', note: 'Offre envoyée (E-mail)', meta: { op: 'offer_sent', saleNumber: 'V-2026-00042' } });
    expect([...db.data.values()].some((v) => v.action === 'sale.offer_sent' && v.actorId === 'u1' && (v.after as Doc).commercialState === 'offer_sent')).toBe(true);
  });
  it('comptant jusqu’au bout : sécurisée à la confirmation du paiement, date posée une seule fois', async () => {
    const db = seed();
    await run(db, args({ kind: 'signed' }));
    expect(lead(db).securedAt).toBeUndefined();
    await run(db, args({ kind: 'deposit_expected', amountCents: 90_000 }));
    expect(lead(db).saleTrack.depositCents).toBe(90_000);
    const fin = await run(db, args({ kind: 'payment_confirmed' }));
    expect(fin).toMatchObject({ ok: true, commercialState: 'signed', financialState: 'payment_confirmed', secured: true });
    expect(lead(db).securedAt).toEqual(new Date(NOW));
    expect(sale(db).securedAt).toEqual(new Date(NOW));
    const notif = [...db.data.values()].find((v) => v.title === 'Vente sécurisée');
    expect(notif).toMatchObject({ leadId: 'L1', recipientIds: expect.arrayContaining(['m1']), readBy: [] });
  });
  it('financement refusé : la vente reste ouverte, motif tracé, responsables prévenus', async () => {
    const db = seed({ commercialState: 'signed', financialState: 'financing_in_progress' });
    const r = await run(db, args({ kind: 'financing_refused', reason: 'Revenus insuffisants' }, manager));
    expect(r).toMatchObject({ ok: true, commercialState: 'signed', financialState: 'financing_refused', secured: false });
    expect(lead(db).saleTrack.financingRefusedReason).toBe('Revenus insuffisants');
    expect(db.data.get(keys(db, 'cl_leads/L1/events/')[0])).toMatchObject({ reason: 'Revenus insuffisants' });
    expect([...db.data.values()].find((v) => v.title === 'Financement refusé')).toMatchObject({ recipientIds: ['u1'] });
    expect(lead(db).status).toBe('converted');
  });
  it("relance : date et compteur, aucun état modifié, pas d'audit", async () => {
    const db = seed();
    await run(db, args({ kind: 'reminder' }));
    await run(db, args({ kind: 'reminder', note: 'Message laissé' }));
    expect(lead(db)).toMatchObject({ commercialState: 'sale_committed', saleTrack: { reminderCount: 2 } });
    expect(lead(db).saleTrack.lastReminderAt).toEqual(new Date(NOW));
    expect(sale(db).track.reminderCount).toBe(2);
    expect([...db.data.values()].some((v) => String(v.action).startsWith('sale.'))).toBe(false);
    expect(keys(db, 'cl_leads/L1/events/')).toHaveLength(2);
  });
  it('annulation par un manager : états, motif, signal critique au propriétaire', async () => {
    const db = seed();
    const r = await run(db, args({ kind: 'cancel', reason: 'Client revenu sur sa décision' }, manager));
    expect(r).toMatchObject({ ok: true, commercialState: 'cancelled' });
    expect(lead(db).saleTrack).toMatchObject({ cancelReason: 'Client revenu sur sa décision' });
    expect([...db.data.values()].find((v) => v.title === 'Vente annulée')).toMatchObject({ recipientIds: ['u1'], sound: 'critical' });
    expect([...db.data.values()].some((v) => v.action === 'sale.cancel' && v.reason === 'Client revenu sur sa décision')).toBe(true);
  });
});

describe('applySaleAction — refus, droits, idempotence', () => {
  it("refus : rien n'est écrit", async () => {
    const db = seed();
    const r = await run(db, args({ kind: 'financing_accepted' }));
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(lead(db).version).toBe(5);
    expect(keys(db, 'cl_leads/L1/events/')).toHaveLength(0);
    expect(keys(db, 'cl_idempotency/')).toHaveLength(0);
  });
  it('un télépro étranger au lead est refusé ; un télépro ne peut pas annuler', async () => {
    const db = seed();
    expect(await run(db, args({ kind: 'reminder' }, { uid: 'autre' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(db, args({ kind: 'cancel', reason: 'Client revenu sur sa décision' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(lead(db).commercialState).toBe('sale_committed');
  });
  it("même demande rejouée : même réponse, rien n'est réécrit", async () => {
    const db = seed();
    const a = args({ kind: 'signed' });
    const first = await run(db, a);
    const again = await run(db, a);
    expect(again).toMatchObject({ ok: true, replay: true, commercialState: first.ok ? first.commercialState : '' });
    expect(lead(db).version).toBe(6);
    expect(keys(db, 'cl_leads/L1/events/')).toHaveLength(1);
  });
  it('identifiant réutilisé par un autre utilisateur : refusé', async () => {
    const db = seed();
    const a = args({ kind: 'signed' });
    await run(db, a);
    expect(await run(db, { ...a, uid: 'm1', role: 'manager' })).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('lead introuvable ; vente annulée : plus aucune action', async () => {
    expect(await run(new FakeDb(), args({ kind: 'reminder' }))).toMatchObject({ ok: false, code: 'not_found' });
    const db = seed({ commercialState: 'cancelled' });
    expect(await run(db, args({ kind: 'reminder' }))).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('lead ancien sans état de vente : démarre à « aucun »', async () => {
    const db = seed();
    const l = db.data.get('cl_leads/L1')!;
    delete l.commercialState;
    delete l.financialState;
    expect(await run(db, args({ kind: 'offer_sent', channel: 'sms' }))).toMatchObject({ ok: true, commercialState: 'offer_sent' });
  });
  it('acompte supérieur au reste à charge de la vente : refusé', async () => {
    const db = seed();
    expect(await run(db, args({ kind: 'deposit_expected', amountCents: 400_000 }))).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('lead sans vente : refusé', async () => {
    const db = seed({ saleId: null });
    expect(await run(db, args({ kind: 'reminder' }))).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
