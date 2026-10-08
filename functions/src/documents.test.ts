import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que applyDocumentAction ÉCRIT (pièces, résumé,
// statut, actions, historique, compteurs, idempotence), pas le moteur Firestore lui-même.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { applyDocumentAction, parseDocumentRules, type DocumentsArgs } from './documents';
import { DEFAULT_DOCUMENT_RULES } from '../../src/domain/documents/plan';

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

const NOW = Date.UTC(2026, 9, 7, 8, 0); // mercredi 10:00 Paris
const DAY = 86_400_000;
const T = (ms: number) => ({ toMillis: () => ms });

const piece = (code: string, mandatory: boolean, status = 'expected'): [string, Doc] => [
  `cl_leads/L1/documents/${code}`,
  { id: code, typeCode: code, mandatory, status, koReason: null, koComment: null, file: null },
];

function seed(over: Doc = {}, docs: [string, Doc][] = [piece('identity', true), piece('tax_notice', true), piece('bank_details', false)]) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', {
    id: 'L1',
    status: 'awaiting_documents',
    ownerId: 'u1',
    teamId: 't1',
    managerIds: ['m1'],
    nextAction: { actionId: 'L1_document_followup_req0', type: 'document_followup', dueAt: T(NOW + DAY), priority: 'P2', reason: 'Relancer' },
    documents: { state: 'requested', expected: 3, received: 0, conform: 0, mandatory: 2, mandatoryConform: 0, lastRequestAt: T(NOW - DAY), nextFollowUpAt: T(NOW + DAY), promisedAt: T(NOW + 3_600_000) },
    version: 4,
    ...over,
  });
  db.data.set('cl_actions/L1_document_followup_req0', { id: 'L1_document_followup_req0', state: 'open', leadId: 'L1' });
  db.data.set('cl_profiles/u1', { load: { newLeads: 0, callbacks: 0, interested: 0, documents: 1, filesToBuild: 0, recycling: 0 } });
  for (const [k, v] of docs) db.data.set(k, v);
  return db;
}

let n = 0;
const args = (over: Partial<DocumentsArgs> = {}): DocumentsArgs => ({
  uid: 'u1',
  role: 'telepro',
  leadId: 'L1',
  requestId: `req-${String(++n).padStart(8, '0')}`,
  input: { kind: 'receive', code: 'identity', channel: 'whatsapp' },
  nowMs: NOW,
  ...over,
});
const run = (db: FakeDb, a: DocumentsArgs) => applyDocumentAction(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { documents: Doc; nextAction: Doc | null; status: string; version: number };
const piecesOf = (db: FakeDb, code: string) => db.data.get(`cl_leads/L1/documents/${code}`) as Doc;

describe('applyDocumentAction — réception', () => {
  it('écrit la pièce, le résumé, la prochaine action « à contrôler » et l\'historique', async () => {
    const db = seed();
    const a = args();
    const r = await run(db, a);
    expect(r).toMatchObject({ ok: true, replay: false, status: 'awaiting_documents', state: 'partial' });
    expect(piecesOf(db, 'identity')).toMatchObject({ status: 'received', channel: 'whatsapp' });
    expect(lead(db).documents).toMatchObject({ state: 'partial', received: 1, conform: 0, promisedAt: null, followUpCount: 0 });
    expect(lead(db).nextAction).toMatchObject({ type: 'document_review', priority: 'P1' });
    expect(lead(db).version).toBe(5);
    expect(db.data.get('cl_actions/L1_document_followup_req0')).toMatchObject({ state: 'done' });
    expect(db.data.get(`cl_actions/L1_document_review_${a.requestId}`)).toMatchObject({ state: 'open', ownerId: 'u1', managerIds: ['m1'], type: 'document_review' });
    expect(db.data.get(`cl_leads/L1/events/${a.requestId}_rcv_identity`)).toMatchObject({ type: 'document', actorId: 'u1' });
  });

  it('recopie sur le lead les pièces manquantes, le nombre à contrôler et la date de réception', async () => {
    const db = seed();
    await run(db, args());
    expect(lead(db).documents).toMatchObject({ toCheck: 1, missing: [{ code: 'tax_notice', status: 'expected', koReason: null }, { code: 'bank_details', status: 'expected', koReason: null }] });
    expect((lead(db).documents.lastReceivedAt as Date).getTime()).toBe(NOW);
  });

  it('rejeu du même identifiant : même réponse, rien n\'est réécrit', async () => {
    const db = seed();
    const a = args();
    await run(db, a);
    const version = lead(db).version;
    const again = await run(db, a);
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(lead(db).version).toBe(version);
  });

  it('un identifiant déjà utilisé par un autre utilisateur est refusé', async () => {
    const db = seed();
    const a = args();
    await run(db, a);
    expect(await run(db, { ...a, uid: 'u2', role: 'admin' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('applyDocumentAction — contrôle et dossier complet', () => {
  it('toutes les obligatoires conformes : prêt à monter, compteurs déplacés, action « monter »', async () => {
    const db = seed({}, [piece('identity', true, 'conform'), piece('tax_notice', true, 'received'), piece('bank_details', false)]);
    const a = args({ input: { kind: 'check', code: 'tax_notice', verdict: 'conform' } });
    const r = await run(db, a);
    expect(r).toMatchObject({ ok: true, status: 'file_ready_to_build', state: 'complete' });
    expect(lead(db).status).toBe('file_ready_to_build');
    expect(lead(db).documents).toMatchObject({ state: 'complete', conform: 2, mandatoryConform: 2, toCheck: 0 });
    expect((lead(db).documents.completedAt as Date).getTime()).toBe(NOW);
    expect(lead(db).nextAction).toMatchObject({ type: 'build_file' });
    expect((db.data.get('cl_profiles/u1')!.load as Doc)).toMatchObject({ documents: 0, filesToBuild: 1 });
    expect(piecesOf(db, 'tax_notice')).toMatchObject({ status: 'conform', checkedBy: 'u1' });
    expect(db.data.get(`cl_leads/L1/events/${a.requestId}_status`)).toMatchObject({ type: 'status_changed', before: { status: 'awaiting_documents' }, after: { status: 'file_ready_to_build' } });
  });

  it('non conforme : motif conservé, action « redemander »', async () => {
    const db = seed({}, [piece('identity', true, 'received'), piece('tax_notice', true)]);
    await run(db, args({ input: { kind: 'check', code: 'identity', verdict: 'non_conform', koReason: 'expired' } }));
    expect(piecesOf(db, 'identity')).toMatchObject({ status: 'non_conform', koReason: 'expired' });
    expect(lead(db).documents.state).toBe('incomplete_non_conform');
    expect(lead(db).nextAction).toMatchObject({ type: 'document_followup' });
  });

  it('refus métier : rien n\'est écrit', async () => {
    const db = seed();
    const before = JSON.stringify([...db.data.entries()]);
    const r = await run(db, args({ input: { kind: 'check', code: 'identity', verdict: 'conform' } }));
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify([...db.data.entries()])).toBe(before);
  });
});

describe('applyDocumentAction — relance, décision, droits', () => {
  it('relance : compteur et date mémorisés, prochaine échéance replanifiée', async () => {
    const db = seed();
    const r = await run(db, args({ input: { kind: 'follow_up', channel: 'sms' } }));
    expect(r).toMatchObject({ ok: true });
    expect(lead(db).documents).toMatchObject({ followUpCount: 1 });
    expect(lead(db).nextAction!.type).toBe('document_followup');
  });

  it('clôture à J+14 : statut de clôture, plus d\'action, compteur décrémenté', async () => {
    const db = seed();
    const r = await run(db, args({ input: { kind: 'decide', decision: 'close', closeReason: 'not_interested', comment: 'Ne répond plus' } }));
    expect(r).toMatchObject({ ok: true, status: 'not_interested' });
    expect(lead(db).nextAction).toBeNull();
    expect((db.data.get('cl_profiles/u1')!.load as Doc).documents).toBe(0);
  });

  it('un télépro étranger au lead est refusé ; l\'admin et le manager du lead passent', async () => {
    const db = seed();
    expect(await run(db, args({ uid: 'u9' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(db, args({ uid: 'm1', role: 'manager' }))).toMatchObject({ ok: true });
    expect(await run(db, args({ uid: 'root', role: 'admin', input: { kind: 'receive', code: 'tax_notice' } }))).toMatchObject({ ok: true });
  });

  it('lead introuvable', async () => expect(await run(seed(), args({ leadId: 'ABSENT' }))).toMatchObject({ ok: false, code: 'not_found' }));

  it('sans profil du propriétaire : l\'action aboutit quand même', async () => {
    const db = seed({}, [piece('identity', true, 'received')]);
    db.data.delete('cl_profiles/u1');
    expect(await run(db, args({ input: { kind: 'check', code: 'identity', verdict: 'conform' } }))).toMatchObject({ ok: true, status: 'file_ready_to_build' });
  });
});

describe('parseDocumentRules', () => {
  it('défauts sans configuration', () => expect(parseDocumentRules(undefined)).toEqual(DEFAULT_DOCUMENT_RULES));
  it('valeurs valides prises, invalides ignorées', () => {
    expect(parseDocumentRules({ followUpDays: [2, 4, 9], decisionRepeatDays: 3 }).followUpDays).toEqual([2, 4, 9]);
    for (const bad of [[], [3, 1], [0, 2], ['a'], [200], 'x']) expect(parseDocumentRules({ followUpDays: bad }).followUpDays).toEqual(DEFAULT_DOCUMENT_RULES.followUpDays);
    expect(parseDocumentRules({ decisionRepeatDays: 0 }).decisionRepeatDays).toBe(7);
  });
  it('marge « promis » et recyclage repris de callRules', () => {
    const r = parseDocumentRules(undefined, { promisedMarginMinutes: 45, recycleAfterDays: 10 });
    expect(r).toMatchObject({ promisedMarginMinutes: 45, recycleAfterDays: 10 });
  });
});
