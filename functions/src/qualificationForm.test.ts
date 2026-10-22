import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que saveQualificationAnswers ÉCRIT, pas le moteur Firestore.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { readPublishedForm, saveQualificationAnswers, type QualificationArgs } from './qualificationForm';

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
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k] };
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
    Object.assign(cur, patch);
  }
  set(ref: FakeRef, data: Doc) {
    this.wrote = true;
    this.db.data.set(ref.path, { ...data });
  }
}

const NOW = Date.UTC(2026, 9, 9, 9, 0);
const field = (id: string, type: string, label: string, over: Doc = {}): Doc => ({ id, type, label, help: '', required: false, blocking: false, options: [], defaultValue: null, min: null, max: null, expected: null, products: [], ...over });
const FORM: Doc = {
  published: {
    fields: [
      field('q_owner', 'yesno', 'Êtes-vous propriétaire ?', { required: true }),
      field('q_heating', 'list', 'Chauffage actuel', { options: [{ value: 'fuel', label: 'Fioul' }, { value: 'gas', label: 'Gaz' }] }),
      field('q_cons', 'number', 'Consommation annuelle', { required: true, min: 0 }),
    ],
    rules: [
      { id: 'r_cons', match: 'all', clauses: [{ fieldId: 'q_heating', op: 'eq', value: 'fuel' }], action: 'show', targets: ['q_cons'], message: '', eligibility: null, compute: null },
      { id: 'r_el', match: 'all', clauses: [{ fieldId: 'q_owner', op: 'eq', value: false }], action: 'eligibility', targets: [], message: '', eligibility: 'refused', compute: null },
    ],
  },
  version: 3,
};

function seed(over: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { id: 'L1', status: 'interested', ownerId: 'u1', managerIds: ['m1'], productCode: 'PAC', version: 4, ...over });
  db.data.set('cl_settings/qualification_pac', FORM);
  return db;
}
let n = 0;
const args = (over: Partial<QualificationArgs> = {}): QualificationArgs => ({ uid: 'u1', role: 'telepro', leadId: 'L1', answers: { q_owner: true, q_heating: 'gas' }, requestId: `req-${String(++n).padStart(8, '0')}`, nowMs: NOW, ...over });
const run = (db: FakeDb, a: QualificationArgs) => saveQualificationAnswers(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc;

describe('saveQualificationAnswers', () => {
  it('enregistre les réponses avec la version du formulaire, le résumé et l’historique', async () => {
    const db = seed();
    const a = args();
    const r = await run(db, a);
    expect(r).toMatchObject({ ok: true, status: 'complete', version: 3, eligibility: 'ok' });
    expect(lead(db).qualificationForm).toMatchObject({ key: 'qualification_pac', version: 3, answers: { q_owner: true, q_heating: 'gas' }, status: 'complete', missing: [], savedBy: 'u1' });
    expect(lead(db).version).toEqual({ __inc: 1 });
    expect(db.data.get(`cl_leads/L1/events/${a.requestId}_qualification`)).toMatchObject({ type: 'qualification', actorId: 'u1', meta: { version: 3, status: 'complete' } });
  });
  it('réponses incomplètes : enregistrées, statut « incomplète » avec ce qui manque', async () => {
    const db = seed();
    expect(await run(db, args({ answers: { q_heating: 'fuel' } }))).toMatchObject({ ok: true, status: 'incomplete' });
    expect((lead(db).qualificationForm as Doc).missing).toEqual(['q_owner', 'q_cons']);
  });
  it('éligibilité modifiée par une condition', async () => {
    const db = seed();
    expect(await run(db, args({ answers: { q_owner: false } }))).toMatchObject({ ok: true, eligibility: 'refused' });
  });
  it('les réponses d’un champ masqué et les champs inconnus ne sont jamais enregistrés', async () => {
    const db = seed();
    await run(db, args({ answers: { q_owner: true, q_heating: 'gas', q_cons: 5000, q_pirate: 'x' } }));
    expect((lead(db).qualificationForm as Doc).answers).toEqual({ q_owner: true, q_heating: 'gas' });
  });
  it('valeur hors format : refusée, rien n’est écrit', async () => {
    const db = seed();
    const r = await run(db, args({ answers: { q_owner: true, q_heating: 'fuel', q_cons: -4 } }));
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.ok ? '' : r.message).toContain('Consommation annuelle');
    expect(lead(db).qualificationForm).toBeUndefined();
    const r2 = await run(db, args({ answers: { q_heating: 'charbon' } }));
    expect(r2).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('réponses illisibles : refusées', async () => {
    expect(await run(seed(), args({ answers: 'x' as never }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(seed(), args({ answers: [] as never }))).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('droits : propriétaire, manager du périmètre, administrateur ; pas un autre télépro ni un autre manager', async () => {
    expect((await run(seed(), args({ uid: 'u1', role: 'telepro' }))).ok).toBe(true);
    expect((await run(seed(), args({ uid: 'm1', role: 'manager' }))).ok).toBe(true);
    expect((await run(seed(), args({ uid: 'a1', role: 'admin' }))).ok).toBe(true);
    expect(await run(seed(), args({ uid: 'u2', role: 'telepro' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(seed(), args({ uid: 'm2', role: 'manager' }))).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('lead clôturé : refusé', async () => {
    for (const status of ['converted', 'not_interested', 'ineligible', 'fake_lead']) expect(await run(seed({ status }), args())).toMatchObject({ ok: false, code: 'lead_closed' });
  });
  it('lead introuvable', async () => expect(await run(new FakeDb(), args())).toMatchObject({ ok: false, code: 'not_found' }));
  it('aucun formulaire publié (brouillon seul, ou rien) : refusé', async () => {
    const db = seed();
    db.data.set('cl_settings/qualification_pac', { draft: (FORM.published as Doc), published: null, version: 0 });
    expect(await run(db, args())).toMatchObject({ ok: false, code: 'no_form' });
    db.data.delete('cl_settings/qualification_pac');
    expect(await run(db, args())).toMatchObject({ ok: false, code: 'no_form' });
  });
  it('formulaire par défaut quand le produit n’a pas le sien', async () => {
    const db = seed();
    db.data.delete('cl_settings/qualification_pac');
    db.data.set('cl_settings/qualification_default', FORM);
    const r = await run(db, args());
    expect(r).toMatchObject({ ok: true });
    expect((lead(db).qualificationForm as Doc).key).toBe('qualification_default');
  });
  it('relecture avec une nouvelle version publiée : la nouvelle version est enregistrée', async () => {
    const db = seed();
    await run(db, args());
    db.data.set('cl_settings/qualification_pac', { ...FORM, version: 4 });
    await run(db, args());
    expect((lead(db).qualificationForm as Doc).version).toBe(4);
  });
});

describe('readPublishedForm', () => {
  it('le formulaire du produit l’emporte, sinon le formulaire par défaut, sinon rien', async () => {
    const docs: Record<string, Doc> = { qualification_default: FORM };
    const read = async (k: string) => docs[k];
    expect((await readPublishedForm(read, 'PAC'))?.key).toBe('qualification_default');
    docs.qualification_pac = FORM;
    expect((await readPublishedForm(read, 'PAC'))?.key).toBe('qualification_pac');
    expect(await readPublishedForm(async () => undefined, 'PAC')).toBeNull();
  });
  it('un formulaire publié vide est ignoré', async () => {
    expect(await readPublishedForm(async () => ({ published: { fields: [], rules: [] }, version: 1 }), null)).toBeNull();
  });
});
