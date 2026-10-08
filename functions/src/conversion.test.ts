import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que applyConversionAction ÉCRIT (brouillon, validation,
// vente, conversion, statut, historique, notifications, audit, compteurs, idempotence), pas le moteur Firestore.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { applyConversionAction, toStoredValidation, type ConversionArgs } from './conversion';
import { emptyDraft, type MontageDraft } from '../../src/domain/conversion/montage';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  autoId = 0;
  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    return fn(new FakeTx(this));
  }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string) {}
  doc(id?: string): FakeRef {
    return new FakeRef(this.db, `${this.path}/${id ?? `auto${++this.db.autoId}`}`);
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol {
    return this.db.collection(name, `${this.path}/`);
  }
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

const NOW = Date.UTC(2026, 9, 8, 10, 0);

function completeDraft(over: (d: MontageDraft) => void = () => undefined): MontageDraft {
  const d = emptyDraft();
  d.identity = { fullName: 'Jean Dupont', phone: '0612345678', email: 'jean@x.fr', addressLine: '15 rue des Lilas', postalCode: '69003', city: 'Lyon' };
  d.project = { housingType: 'Maison', occupancy: 'Propriétaire occupant', livingAreaM2: 125, currentHeating: 'Fioul', climateZone: 'H1', cadastralRef: '', previsitDate: '' };
  d.aids = { mprCents: 800_000, ceeCents: 450_000, delegate: 'TotalEnergies', rfrCents: null, householdSize: 3, eligibility: 'validated', ceeDoubleChecked: true };
  d.offer = { lines: [{ id: 'l1', productId: 'p1', label: 'PAC', service: 'Pose', qty: 1, unitHtCents: 1_332_500, vatRate: 20 }], discountCents: 0, financing: { mode: 'cash', downPaymentCents: 0 }, rge: true };
  d.consentConfirmed = true;
  over(d);
  return d;
}

function seed(over: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { id: 'L1', status: 'file_building', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], fullName: 'Jean Dupont', consent: true, productCode: 'PAC', origin: { campaignId: 'c1', sourceId: 's1' }, version: 3, ...over });
  db.data.set('cl_campaigns/c1', { name: 'PAC IDF' });
  db.data.set('cl_profiles/u1', { load: { newLeads: 0, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
  for (const code of ['identity', 'tax_notice']) db.data.set(`cl_leads/L1/documents/${code}`, { typeCode: code, mandatory: true, status: 'conform' });
  return db;
}
let n = 0;
const args = (over: Partial<ConversionArgs> = {}): ConversionArgs => ({ uid: 'u1', role: 'telepro', leadId: 'L1', requestId: `req-${String(++n).padStart(8, '0')}`, input: { kind: 'create_sale' }, nowMs: NOW, ...over });
const run = (db: FakeDb, a: ConversionArgs) => applyConversionAction(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { status: string; montage: Record<string, unknown>; conversion: Record<string, unknown>; version: number };
const saveDraft = (db: FakeDb, d = completeDraft()) => run(db, args({ input: { kind: 'save_draft', draft: d } }));
const withDiscount = () => completeDraft((d) => { d.offer.discountCents = 200_000; });
const keys = (db: FakeDb, prefix: string) => [...db.data.keys()].filter((k) => k.startsWith(prefix));

describe('applyConversionAction — brouillon', () => {
  it('écrit le brouillon, le résumé du lead et passe le dossier à « prêt »', async () => {
    const db = seed();
    const r = await saveDraft(db);
    expect(r).toMatchObject({ ok: true, replay: false, status: 'file_ready', validationState: 'none', saleNumber: null });
    expect(db.data.get('cl_leads/L1/montage/draft')).toMatchObject({ updatedBy: 'u1', identity: { fullName: 'Jean Dupont' } });
    expect(lead(db)).toMatchObject({ status: 'file_ready', version: 4, montage: { blocking: 0, toConfirm: 0, totalTtcCents: 1_599_000, remainderCents: 349_000 } });
    expect(keys(db, 'cl_leads/L1/events/').length).toBeGreaterThan(0);
  });
  it('dossier incomplet : brouillon quand même enregistré, reste en montage', async () => {
    const db = seed();
    const r = await saveDraft(db, completeDraft((d) => { d.identity.city = ''; }));
    expect(r).toMatchObject({ ok: true, status: 'file_building' });
    expect(lead(db).montage).toMatchObject({ blocking: 1 });
  });
  it('un télépro étranger au lead est refusé, rien n\'est écrit', async () => {
    const db = seed();
    const r = await run(db, args({ uid: 'autre', input: { kind: 'save_draft', draft: completeDraft() } }));
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(db.data.has('cl_leads/L1/montage/draft')).toBe(false);
    expect(lead(db).version).toBe(3);
  });
  it('lead introuvable', async () => expect(await run(new FakeDb(), args({ input: { kind: 'save_draft', draft: {} } }))).toMatchObject({ ok: false, code: 'not_found' }));
  it('rejeu du même identifiant de demande : même réponse, rien de plus écrit', async () => {
    const db = seed();
    const a = args({ input: { kind: 'save_draft', draft: completeDraft() } });
    const first = await run(db, a);
    const second = await run(db, a);
    expect(second).toMatchObject({ ok: true, replay: true, status: first.ok ? first.status : '' });
    expect(lead(db).version).toBe(4);
  });
  it('identifiant de demande réutilisé par un autre utilisateur : refusé', async () => {
    const db = seed();
    const a = args({ input: { kind: 'save_draft', draft: completeDraft() } });
    await run(db, a);
    expect(await run(db, { ...a, uid: 'm1', role: 'manager' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('applyConversionAction — validation manager', () => {
  async function pendingSeed() {
    const db = seed();
    await saveDraft(db, withDiscount());
    const ask = await run(db, args({ input: { kind: 'request_validation', message: 'Remise accordée au client fidèle.' } }));
    return { db, ask };
  }
  it('la demande passe le lead en « validation manager », notifie le manager et trace l\'audit', async () => {
    const { db, ask } = await pendingSeed();
    expect(ask).toMatchObject({ ok: true, status: 'manager_validation', validationState: 'pending' });
    expect(db.data.get('cl_leads/L1/montage/validation')).toMatchObject({ state: 'pending', requestedBy: 'u1', exceptions: [{ key: 'discount' }] });
    const notif = [...db.data.entries()].find(([k, v]) => k.startsWith('cl_notifications/') && v.title === 'Vente à valider');
    expect(notif?.[1]).toMatchObject({ recipientIds: ['m1'], leadId: 'L1', sound: 'critical', readBy: [] });
    expect([...db.data.values()].some((v) => v.action === 'conversion.request_validation' && v.actorId === 'u1')).toBe(true);
  });
  it('le demandeur ne peut plus modifier le dossier pendant l\'attente', async () => {
    const { db } = await pendingSeed();
    expect(await saveDraft(db, withDiscount())).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('le manager approuve : dossier prêt, propriétaire notifié, décision et audit tracés', async () => {
    const { db } = await pendingSeed();
    const r = await run(db, args({ uid: 'm1', role: 'manager', input: { kind: 'decide', decision: 'approve', comment: 'OK', acknowledged: true } }));
    expect(r).toMatchObject({ ok: true, status: 'file_ready', validationState: 'approved' });
    expect(db.data.get('cl_leads/L1/montage/validation')).toMatchObject({ state: 'approved', decidedBy: 'm1', comment: 'OK' });
    expect([...db.data.values()].some((v) => v.action === 'conversion.decide.approve' && v.actorId === 'm1')).toBe(true);
    const notif = [...db.data.values()].find((v) => v.title === 'Vente approuvée');
    expect(notif).toMatchObject({ recipientIds: ['u1'] });
  });
  it('le télépro demandeur ne peut pas approuver sa propre demande', async () => {
    const { db } = await pendingSeed();
    expect(await run(db, args({ input: { kind: 'decide', decision: 'approve', comment: '', acknowledged: true } }))).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('refus sans commentaire : rejeté ; avec commentaire : retour en montage', async () => {
    const { db } = await pendingSeed();
    expect(await run(db, args({ uid: 'm1', role: 'manager', input: { kind: 'decide', decision: 'refuse', comment: '', acknowledged: false } }))).toMatchObject({ ok: false, code: 'invalid' });
    const r = await run(db, args({ uid: 'm1', role: 'manager', input: { kind: 'decide', decision: 'refuse', comment: 'Remise trop forte', acknowledged: false } }));
    expect(r).toMatchObject({ ok: true, status: 'file_building', validationState: 'refused' });
  });
  it('modifier le dossier après approbation annule l\'approbation', async () => {
    const { db } = await pendingSeed();
    await run(db, args({ uid: 'm1', role: 'manager', input: { kind: 'decide', decision: 'approve', comment: '', acknowledged: true } }));
    const r = await saveDraft(db, completeDraft((d) => { d.offer.discountCents = 300_000; }));
    expect(r).toMatchObject({ ok: true, status: 'file_building', validationState: 'none' });
    expect(db.data.get('cl_leads/L1/montage/validation')).toMatchObject({ state: 'none' });
  });
});

describe('applyConversionAction — création de la vente', () => {
  async function readySeed() {
    const db = seed();
    await saveDraft(db);
    return db;
  }
  it('crée la vente, la conversion en attente, passe le lead en transmission, numérote', async () => {
    const db = await readySeed();
    const r = await run(db, args());
    expect(r).toMatchObject({ ok: true, replay: false, status: 'transmitting', saleNumber: 'V-2026-00001' });
    expect(db.data.get('cl_sales/L1')).toMatchObject({ number: 'V-2026-00001', leadId: 'L1', totalTtcCents: 1_599_000, remainderCents: 349_000, productCode: 'PAC', campaignName: 'PAC IDF', ownerId: 'u1', managerIds: ['m1'], createdBy: 'u1' });
    expect(db.data.get('cl_conversions/L1')).toMatchObject({ leadId: 'L1', idempotencyKey: 'sale_L1', state: 'pending', saleId: 'L1', clientId: null, dossierId: null, attempts: 0 });
    expect(lead(db)).toMatchObject({ status: 'transmitting', saleId: 'L1', commercialState: 'sale_committed', conversion: { state: 'pending', clientId: null, dossierId: null } });
    expect(db.data.get('cl_counters/sales_2026')).toMatchObject({ n: 1 });
    expect([...db.data.values()].some((v) => v.action === 'conversion.create_sale')).toBe(true);
  });
  it('double clic (autre identifiant de demande) : rend la vente existante, aucune seconde vente (RG14)', async () => {
    const db = await readySeed();
    await run(db, args());
    const again = await run(db, args());
    expect(again).toMatchObject({ ok: true, replay: true, saleNumber: 'V-2026-00001' });
    expect(keys(db, 'cl_sales/')).toEqual(['cl_sales/L1']);
    expect(db.data.get('cl_counters/sales_2026')).toMatchObject({ n: 1 });
  });
  it('la reprise par un utilisateur sans droit sur le lead ne révèle rien', async () => {
    const db = await readySeed();
    await run(db, args());
    expect(await run(db, args({ uid: 'autre', role: 'telepro' }))).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('le numéro de vente suit le compteur de l\'année', async () => {
    const db = await readySeed();
    db.data.set('cl_counters/sales_2026', { n: 41 });
    expect(await run(db, args())).toMatchObject({ ok: true, saleNumber: 'V-2026-00042' });
    expect(db.data.get('cl_counters/sales_2026')).toMatchObject({ n: 42 });
  });
  it('contrôle bloquant : aucune écriture, message qui dit quoi corriger', async () => {
    const db = seed();
    await saveDraft(db, completeDraft((d) => { d.offer.rge = null; }));
    const r = await run(db, args());
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(r.ok ? '' : r.message).toContain('Qualification RGE');
    expect(db.data.has('cl_sales/L1')).toBe(false);
    expect(db.data.has('cl_conversions/L1')).toBe(false);
  });
  it('document obligatoire non conforme : vente refusée', async () => {
    const db = seed();
    db.data.set('cl_leads/L1/documents/tax_notice', { typeCode: 'tax_notice', mandatory: true, status: 'received' });
    await saveDraft(db);
    expect(await run(db, args())).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('exception : vente impossible sans approbation, possible après, avec l\'approbateur conservé', async () => {
    const db = seed();
    await saveDraft(db, withDiscount());
    expect(await run(db, args())).toMatchObject({ ok: false, code: 'unavailable' });
    await run(db, args({ input: { kind: 'request_validation', message: 'Remise accordée au client fidèle.' } }));
    await run(db, args({ uid: 'm1', role: 'manager', input: { kind: 'decide', decision: 'approve', comment: '', acknowledged: true } }));
    expect(await run(db, args())).toMatchObject({ ok: true, status: 'transmitting' });
    expect(db.data.get('cl_sales/L1')).toMatchObject({ validatedBy: 'm1', discountCents: 200_000 });
  });
  it('le montant des compteurs de charge du propriétaire reste cohérent', async () => {
    const db = await readySeed();
    await run(db, args());
    expect((db.data.get('cl_profiles/u1') as { load: Doc }).load).toMatchObject({ filesToBuild: 0 });
  });
});

describe('toStoredValidation', () => {
  it('document absent ou état inconnu : aucune demande', () => {
    expect(toStoredValidation(undefined).state).toBe('none');
    expect(toStoredValidation({ state: 'hack' }).state).toBe('none');
  });
  it('relit les dates Firestore', () => {
    const v = toStoredValidation({ state: 'pending', requestedAt: { toMillis: () => 5 }, requestedBy: 'u1', fingerprint: 'f' });
    expect(v).toMatchObject({ state: 'pending', requestedAtMs: 5, requestedBy: 'u1', fingerprint: 'f' });
  });
});
