import { describe, expect, it, vi } from 'vitest';

// Base en mémoire (pas d'émulateur disponible) : on vérifie ce que transmitConversion ÉCRIT dans le CRM principal et
// sur le lead (dossier, subvention, historique, pièces, conversion), l'idempotence et la reprise.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { backoffMinutes, transmitConversion, type StorageLike, type TransmitArgs } from './transmission';
import { emptyDraft, type MontageDraft } from '../../src/domain/conversion/montage';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    const tx = new FakeTx(this);
    const out = await fn(tx);
    tx.commit();
    return out;
  }
}
class FakeCol {
  constructor(public db: FakeDb, public path: string) {}
  doc(id: string): FakeRef { return new FakeRef(this.db, `${this.path}/${id}`); }
  private direct() {
    return [...this.db.data.keys()].filter((k) => k.startsWith(`${this.path}/`) && !k.slice(this.path.length + 1).includes('/'));
  }
  where(field: string, op: string, value: unknown) { return new FakeQuery(this, [{ field, op, value }], Infinity); }
  async get() { return { empty: this.direct().length === 0, docs: this.direct().map((k) => snap(this.db, k)) }; }
  matching(filters: { field: string; op: string; value: unknown }[]) {
    return this.direct().filter((k) => {
      const d = this.db.data.get(k)!;
      return filters.every((f) => (f.op === '==' ? d[f.field] === f.value : f.op === 'array-contains' ? Array.isArray(d[f.field]) && (d[f.field] as unknown[]).includes(f.value) : false));
    });
  }
}
class FakeQuery {
  constructor(private col: FakeCol, private filters: { field: string; op: string; value: unknown }[], private n: number) {}
  limit(n: number) { return new FakeQuery(this.col, this.filters, n); }
  async get() {
    const keys = this.col.matching(this.filters).slice(0, this.n);
    return { empty: keys.length === 0, docs: keys.map((k) => snap(this.col.db, k)) };
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol { return this.db.collection(name, `${this.path}/`); }
  async get() { return snap(this.db, this.path); }
  async set(data: Doc) { this.db.data.set(this.path, { ...data }); }
  async update(patch: Doc) {
    const cur = this.db.data.get(this.path);
    if (!cur) throw new Error(`update d'un document inexistant : ${this.path}`);
    for (const [k, v] of Object.entries(patch)) cur[k] = v;
  }
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k], ref: new FakeRef(db, path) };
};
class FakeTx {
  private ops: (() => void)[] = [];
  private wrote = false;
  constructor(private db: FakeDb) {}
  async get(ref: FakeRef) {
    if (this.wrote) throw new Error('lecture après écriture : interdit dans une transaction Firestore');
    return snap(this.db, ref.path);
  }
  update(ref: FakeRef, patch: Doc) { this.wrote = true; this.ops.push(() => { const cur = this.db.data.get(ref.path); if (!cur) throw new Error(`update inexistant : ${ref.path}`); Object.assign(cur, patch); }); }
  set(ref: FakeRef, data: Doc) { this.wrote = true; this.ops.push(() => { this.db.data.set(ref.path, { ...data }); }); }
  create(ref: FakeRef, data: Doc) { this.wrote = true; this.ops.push(() => { if (this.db.data.has(ref.path)) throw new Error('ALREADY_EXISTS'); this.db.data.set(ref.path, { ...data }); }); }
  commit() { for (const op of this.ops) op(); }
}

const NOW = Date.UTC(2026, 9, 8, 10, 0);
const T = (ms: number) => ({ toMillis: () => ms });

function draft(over: (d: MontageDraft) => void = () => undefined): Doc {
  const d = emptyDraft();
  d.identity = { fullName: 'Jean Dupont', phone: '06 12 34 56 78', email: 'jean@x.fr', addressLine: '15 rue des Lilas', postalCode: '69003', city: 'Lyon' };
  d.project = { housingType: 'Maison individuelle', occupancy: 'Propriétaire occupant', livingAreaM2: 125, currentHeating: 'Fioul', climateZone: 'H1', cadastralRef: '', previsitDate: '' };
  d.aids = { mprCents: 800_000, ceeCents: 450_000, delegate: 'TotalEnergies', rfrCents: 2_450_000, householdSize: 3, eligibility: 'validated', ceeDoubleChecked: true };
  d.offer.lines = [{ id: 'l1', productId: 'p1', label: 'PAC', service: 'Pose', qty: 1, unitHtCents: 1_332_500, vatRate: 20 }];
  d.consentConfirmed = true;
  over(d);
  return d as unknown as Doc;
}

function seed(opts: { files?: boolean } = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { id: 'L1', status: 'transmitting', ownerId: 'u1', managerIds: ['m1'], fullName: 'Jean Dupont', consent: true });
  db.data.set('cl_leads/L1/montage/draft', draft());
  db.data.set('cl_sales/L1', { id: 'L1', leadId: 'L1', number: 'V-2026-00042', mprCents: 800_000, ceeCents: 450_000, remainderCents: 349_000, totalTtcCents: 1_599_000, discountCents: 0, campaignName: 'PAC IDF', lines: [{ productId: 'p1', label: 'PAC' }] });
  db.data.set('cl_conversions/L1', { leadId: 'L1', state: 'pending', saleId: 'L1', clientId: null, dossierId: null, attempts: 0, lastError: null });
  db.data.set('products/p1', { category: 'PAC' });
  db.data.set('users/u1', { firstName: 'Sarah', lastName: 'Martin' });
  const files = opts.files ?? true;
  for (const code of ['identity', 'tax_notice']) {
    db.data.set(`cl_leads/L1/documents/${code}`, { typeCode: code, label: code, mandatory: true, status: 'conform', file: files ? { storagePath: `cl_documents/L1/${code}/a.pdf`, originalName: `${code}.pdf`, sizeBytes: 1000, contentType: 'application/pdf' } : null });
  }
  return db;
}

const okStorage = (): StorageLike & { copy: ReturnType<typeof vi.fn> } => ({ copy: vi.fn(async (_s: string, dest: string) => ({ url: `https://files/${dest}?token=t` })) });
const args = (over: Partial<TransmitArgs> = {}): TransmitArgs => ({ leadId: 'L1', actorId: 'u1', nowMs: NOW, storage: okStorage(), random: () => 0.12345, fetchParcel: async () => null, ...over });
const run = (db: FakeDb, a: TransmitArgs = args()) => transmitConversion(db as never, a);
const conv = (db: FakeDb) => db.data.get('cl_conversions/L1') as Doc;
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc;
const dossiers = (db: FakeDb) => [...db.data.keys()].filter((k) => /^dossiers\/[^/]+$/.test(k));

describe('transmitConversion — cas nominal', () => {
  it('crée le dossier, sa subvention, son historique, copie les pièces et confirme', async () => {
    const db = seed();
    const storage = okStorage();
    const r = await run(db, args({ storage }));
    expect(r).toMatchObject({ ok: true, replay: false, state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1', documents: 2 });
    const dossier = db.data.get('dossiers/cl_L1')!;
    expect(dossier).toMatchObject({ id: 'cl_L1', clientNumber: '2612345', name: 'Jean Dupont', tag: 'MPR + CEE', status: 'incomplet', subventionId: 'cl_L1', leadId: 'L1', saleNumber: 'V-2026-00042', commercial: { id: 'u1', firstName: 'Sarah', lastName: 'Martin' } });
    expect(db.data.get('subventions/cl_L1')).toMatchObject({ dossierId: 'cl_L1', clientId: 'cl_L1', ownerType: 'occupant', primeMprTotal: 8000, primeCeeTotal: 4500 });
    expect(db.data.get('historique_dossier/cl_created_L1')).toMatchObject({ action: 'client_created', clientId: 'cl_L1', details: 'Nouveau dossier N°: 2612345', source: 'crm-leads' });
    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(storage.copy).toHaveBeenCalledWith('cl_documents/L1/identity/a.pdf', 'dossiers/cl_L1/documents/identity/lead_identity.pdf');
    expect(db.data.get('dossiers/cl_L1/documents/lead_identity')).toMatchObject({ type: 'identity', path: 'dossiers/cl_L1/documents/identity/lead_identity.pdf', url: expect.stringContaining('https://files/'), source: 'crm-leads', leadId: 'L1' });
    expect((dossier.uploadedDocuments as unknown[]).length).toBe(2);
    expect(conv(db)).toMatchObject({ state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1', documentsTransferred: true, documentsCount: 2, lastError: null, lockedUntil: null, attempts: 1 });
    expect(lead(db)).toMatchObject({ status: 'converted', conversion: { state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1' } });
  });
  it('historique du lead, audit et notification', async () => {
    const db = seed();
    await run(db);
    expect(db.data.get('cl_leads/L1/events/transmit_L1_status')).toMatchObject({ type: 'status_changed', before: { status: 'transmitting' }, after: { status: 'converted' } });
    expect(db.data.get('cl_leads/L1/events/transmit_L1_done')).toMatchObject({ type: 'conversion', note: 'Dossier n° 2612345 créé dans le CRM principal' });
    expect(db.data.get('cl_audit/conv_transmit_L1')).toMatchObject({ action: 'conversion.transmit', entityId: 'L1' });
    expect(db.data.get('cl_notifications/transmit_L1_done')).toMatchObject({ leadId: 'L1', recipientIds: ['m1'], sound: null });
  });
  it("sans pièce avec fichier : confirme sans stockage", async () => {
    const db = seed({ files: false });
    expect(await run(db, args({ storage: null }))).toMatchObject({ ok: true, documents: 0 });
  });
  it('le numéro de dossier évite ceux déjà pris (dossiers et clients)', async () => {
    const db = seed();
    db.data.set('dossiers/autre', { clientNumber: '2612345' });
    db.data.set('clients/x', { clientNumber: '2600001' });
    const seq = [0.12345, 0.00001, 0.5];
    const r = await run(db, args({ random: () => seq.shift() ?? 0.9 }));
    expect(r).toMatchObject({ ok: true, clientId: '2650000' });
  });
});

describe('transmitConversion — historique utile, notes, source, financement', () => {
  const seedEvents = (db: FakeDb) => {
    db.data.set('cl_leads/L1/events/e1', { type: 'created', at: T(NOW - 3 * 86_400_000), actorId: 'engine' });
    db.data.set('cl_leads/L1/events/e2', { type: 'status_changed', at: T(NOW - 2 * 86_400_000), actorId: 'u1', before: { status: 'new' }, after: { status: 'interested' } });
    db.data.set('cl_leads/L1/events/e3', { type: 'note', at: T(NOW - 86_400_000), actorId: 'u1', note: 'Client motivé' });
    db.data.set('cl_leads/L1/events/e4', { type: 'field_corrected', at: T(NOW - 3_600_000), actorId: 'u1', note: 'Brouillon enregistré' });
    db.data.set('cl_leads/L1/events/e5', { type: 'alert', at: T(NOW - 3_000_000), actorId: 'system', note: 'SLA' });
  };
  const hist = (db: FakeDb) => [...db.data.entries()].filter(([k]) => k.startsWith('historique_dossier/cl_ev_')).sort((a, b) => Number((a[1].timestamp as Date).getTime()) - Number((b[1].timestamp as Date).getTime()));
  it("recopie l'historique utile dans l'historique du dossier, sans le technique", async () => {
    const db = seed();
    seedEvents(db);
    await run(db);
    const entries = hist(db);
    expect(entries.map(([k]) => k)).toEqual(['historique_dossier/cl_ev_L1_e1', 'historique_dossier/cl_ev_L1_e2', 'historique_dossier/cl_ev_L1_e3']);
    expect(entries.map(([, v]) => v.details)).toEqual(['Historique CRM Leads : Lead reçu', 'Historique CRM Leads : Statut : Nouveau → Intéressé', 'Historique CRM Leads : Note : Client motivé']);
    expect(entries[0][1]).toMatchObject({ action: 'comment_added', clientId: 'cl_L1', clientName: 'Jean Dupont', source: 'crm-leads', leadId: 'L1' });
    expect(conv(db)).toMatchObject({ historyTransferred: true, historyCount: 3 });
  });
  it('retransmettre ne crée aucun doublon : mêmes identifiants', async () => {
    const db = seed();
    seedEvents(db);
    await run(db, args({ storage: { copy: vi.fn(async () => { throw new Error('x'); }) } }));
    await run(db, args({ nowMs: NOW + 120_000 }));
    expect(hist(db)).toHaveLength(3);
  });
  it('sans événement utile : étape terminée quand même', async () => {
    const db = seed();
    expect(await run(db)).toMatchObject({ ok: true });
    expect(conv(db)).toMatchObject({ historyTransferred: true, historyCount: 0 });
  });
  it('notes, source et financement arrivent dans le dossier', async () => {
    const db = seed();
    db.data.set('cl_leads/L1', { ...(db.data.get('cl_leads/L1') as Doc), lastNote: { text: 'Rappeler après 18 h' }, origin: { campaignId: 'c1', sourceId: 'pabbly', platform: 'meta', externalId: 'ext-9', receivedAt: T(NOW - 86_400_000) } });
    db.data.set('cl_leads/L1/montage/draft', draft((d) => { d.notes = 'Pavillon RT2012'; d.offer.financing = { mode: 'credit', downPaymentCents: 90_000, organism: 'Floa' }; }));
    await run(db);
    const dossier = db.data.get('dossiers/cl_L1')!;
    expect(dossier.comment).toBe('Pavillon RT2012\nRappeler après 18 h');
    const details = dossier.dossierDetails as { marketing: Doc; financing: Doc; offer: { lignes: unknown[] } };
    expect(details.marketing).toMatchObject({ source: 'pabbly', plateforme: 'meta', identifiantExterne: 'ext-9', campagneId: 'c1' });
    expect(details.financing).toMatchObject({ mode: 'credit', organisme: 'Floa', apport: 900, montantFinance: 2590 });
    expect(details.offer.lignes).toHaveLength(1);
  });
});

describe('transmitConversion — parcelle cadastrale automatique', () => {
  const info = (db: FakeDb) => (db.data.get('dossiers/cl_L1')!.questionnaireAnswers as { info: Doc }).info;
  it("complète la parcelle depuis l'adresse quand le montage ne l'a pas renseignée", async () => {
    const db = seed();
    const fetchParcel = vi.fn(async () => '69003000AB0123');
    await run(db, args({ fetchParcel }));
    expect(fetchParcel).toHaveBeenCalledWith('15 rue des Lilas 69003 Lyon');
    expect(info(db)).toMatchObject({ parcelCadastrale: '69003000AB0123', parcellesCadastrales: '69003000AB0123' });
    expect((db.data.get('dossiers/cl_L1')!.dossierDetails as { housing: Doc }).housing).toMatchObject({ cadastralReference: '69003000AB0123', cadastralPlots: '69003000AB0123' });
    expect((db.data.get('dossiers/cl_L1')!.dossierDetails as { importedForm: Doc }).importedForm).toMatchObject({ parcellesCadastrales: '69003000AB0123' });
  });
  it('une parcelle saisie au montage est conservée, sans appel au service', async () => {
    const db = seed();
    db.data.set('cl_leads/L1/montage/draft', draft((d) => { d.project.cadastralRef = '75001000ZZ0001'; }));
    const fetchParcel = vi.fn(async () => '69003000AB0123');
    await run(db, args({ fetchParcel }));
    expect(fetchParcel).not.toHaveBeenCalled();
    expect(info(db)).toMatchObject({ parcelCadastrale: '75001000ZZ0001' });
  });
  it('service indisponible ou parcelle introuvable : la transmission réussit, le champ reste vide', async () => {
    const db1 = seed();
    expect(await run(db1, args({ fetchParcel: async () => { throw new Error('IGN en panne'); } }))).toMatchObject({ ok: true });
    expect(info(db1).parcelCadastrale).toBe('');
    const db2 = seed();
    expect(await run(db2, args({ fetchParcel: async () => null }))).toMatchObject({ ok: true });
    expect(info(db2).parcelCadastrale).toBe('');
  });
});

describe('transmitConversion — idempotence (RG14)', () => {
  it('relance après confirmation : même résultat, rien de recréé', async () => {
    const db = seed();
    const storage = okStorage();
    await run(db, args({ storage }));
    const again = await run(db, args({ storage }));
    expect(again).toMatchObject({ ok: true, replay: true, clientId: '2612345', dossierId: 'cl_L1' });
    expect(dossiers(db)).toEqual(['dossiers/cl_L1']);
    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(conv(db).attempts).toBe(1);
  });
  it('deux exécutions simultanées : un seul dossier', async () => {
    const db = seed();
    const [a, b] = await Promise.all([run(db), run(db)]);
    expect([a.ok, b.ok].some(Boolean)).toBe(true);
    expect(dossiers(db)).toEqual(['dossiers/cl_L1']);
    // Même si l'une des deux échoue, la conversion confirmée par l'autre n'est jamais dégradée.
    expect(conv(db).state).toBe('confirmed');
    expect(lead(db).status).toBe('converted');
    expect(db.data.get('subventions/cl_L1')).toBeDefined();
  });
  it('transmission déjà en cours (verrou) : refus « busy »', async () => {
    const db = seed();
    (conv(db) as Doc).lockedUntil = T(NOW + 60_000);
    expect(await run(db)).toMatchObject({ ok: false, code: 'busy' });
    expect(dossiers(db)).toEqual([]);
  });
  it('verrou expiré : reprise possible', async () => {
    const db = seed();
    (conv(db) as Doc).lockedUntil = T(NOW - 1);
    expect(await run(db)).toMatchObject({ ok: true });
  });
  it('aucune vente : introuvable', async () => {
    const db = seed();
    db.data.delete('cl_sales/L1');
    expect(await run(db)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('transmitConversion — échec et reprise (§11.9)', () => {
  it("échec de copie d'une pièce : vente et dossier conservés, lead en erreur, détails tracés", async () => {
    const db = seed();
    const storage = { copy: vi.fn(async () => { throw new Error('quota'); }) };
    const r = await run(db, args({ storage }));
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(r.ok ? '' : r.message).toContain('pas pu être transférée');
    expect(r.ok ? '' : r.message).not.toContain('quota');
    expect(db.data.has('dossiers/cl_L1')).toBe(true);
    expect(db.data.has('cl_sales/L1')).toBe(true);
    expect(conv(db)).toMatchObject({ state: 'failed', dossierId: 'cl_L1', clientId: '2612345', attempts: 1, lockedUntil: null });
    expect(conv(db).documentsTransferred).toBeUndefined();
    expect((conv(db).lastError as Doc).code).toBe('document_copy_failed');
    expect(lead(db).status).toBe('transmission_error');
    expect(db.data.get('cl_leads/L1/events/transmit_err_L1_1')).toMatchObject({ type: 'conversion', meta: { op: 'transmit_failed', code: 'document_copy_failed', attempt: 1 } });
  });
  it('reprise : continue à l’étape des pièces, ne recrée pas le dossier, converti', async () => {
    const db = seed();
    await run(db, args({ storage: { copy: vi.fn(async () => { throw new Error('quota'); }) } }));
    const storage = okStorage();
    const r = await run(db, args({ storage, nowMs: NOW + 120_000 }));
    expect(r).toMatchObject({ ok: true, dossierId: 'cl_L1', clientId: '2612345', documents: 2 });
    expect(dossiers(db)).toEqual(['dossiers/cl_L1']);
    expect(conv(db)).toMatchObject({ state: 'confirmed', attempts: 2, lastError: null });
    expect(lead(db).status).toBe('converted');
  });
  it('stockage indisponible alors que des pièces sont à transférer : échec explicite', async () => {
    const db = seed();
    const r = await run(db, args({ storage: null }));
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect((conv(db).lastError as Doc).code).toBe('storage_unavailable');
  });
  it('brouillon introuvable : échec explicite, rien créé', async () => {
    const db = seed();
    db.data.delete('cl_leads/L1/montage/draft');
    expect(await run(db)).toMatchObject({ ok: false, code: 'failed' });
    expect(dossiers(db)).toEqual([]);
    expect((conv(db).lastError as Doc).code).toBe('draft_missing');
  });
  it('erreur inattendue : message métier sans détail technique', async () => {
    const db = seed();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.data.delete('products/p1');
    const original = db.collection.bind(db);
    db.collection = ((name: string, prefix?: string) => {
      if (name === 'subventions') throw new Error('boom interne');
      return original(name, prefix);
    }) as typeof db.collection;
    // `subventions` est lu avant la transaction : l'erreur remonte comme inattendue.
    await expect(run(db)).rejects.toThrow('boom interne');
  });
  it('backoff : double à chaque échec, plafonné à une heure', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60]);
  });
});

describe('transmitConversion — doublon de dossier (§24.7)', () => {
  const withExisting = () => {
    const db = seed();
    db.data.set('dossiers/existant', { clientNumber: '2599999', leadId: 'AUTRE', searchIndex: ['jean@x.fr', '0612345678', '06'] });
    return db;
  };
  it('contact déjà présent : on s’arrête, décision demandée, rien créé', async () => {
    const db = withExisting();
    const r = await run(db);
    expect(r).toMatchObject({ ok: false, code: 'duplicate', duplicates: [{ id: 'existant', clientNumber: '2599999' }] });
    expect(r.ok ? '' : r.message).toContain('2599999');
    expect(dossiers(db)).toEqual(['dossiers/existant']);
    expect(conv(db)).toMatchObject({ state: 'failed' });
    expect((conv(db).lastError as Doc).code).toBe('duplicate_dossier');
  });
  it('décision « rattacher » : pas de nouveau dossier, le lead est converti vers le dossier existant', async () => {
    const db = withExisting();
    await run(db);
    const r = await run(db, args({ onDuplicate: 'link', nowMs: NOW + 1000 }));
    expect(r).toMatchObject({ ok: true, clientId: '2599999', dossierId: 'existant' });
    expect(dossiers(db)).toEqual(['dossiers/existant']);
    expect(conv(db)).toMatchObject({ state: 'confirmed', dossierId: 'existant', linkedExisting: true });
    expect(lead(db)).toMatchObject({ status: 'converted', conversion: { dossierId: 'existant' } });
  });
  it('décision « créer quand même » : nouveau dossier', async () => {
    const db = withExisting();
    await run(db);
    const r = await run(db, args({ onDuplicate: 'create', nowMs: NOW + 1000 }));
    expect(r).toMatchObject({ ok: true, dossierId: 'cl_L1' });
    expect(dossiers(db).sort()).toEqual(['dossiers/cl_L1', 'dossiers/existant']);
  });
  it('le dossier de ce même lead n’est jamais un doublon', async () => {
    const db = seed();
    db.data.set('dossiers/cl_L1', { clientNumber: '2611111', leadId: 'L1', searchIndex: ['jean@x.fr'] });
    const r = await run(db);
    expect(r).toMatchObject({ ok: true, dossierId: 'cl_L1', clientId: '2611111' });
  });
  it('dossier cl_<lead> déjà utilisé par un autre lead : refus', async () => {
    const db = seed();
    db.data.set('dossiers/cl_L1', { clientNumber: '2611111', leadId: 'AUTRE', searchIndex: [] });
    const r = await run(db);
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect((conv(db).lastError as Doc).code).toBe('dossier_conflict');
  });
});
