import { describe, expect, it, vi } from 'vitest';
import { readJournal, replayRawLead, RAW_LIMIT } from './integrationsHub';
import type { IngestResult } from './ingest';

// Base en mémoire avec les requêtes utilisées par le hub (orderBy, where, limit) : on vérifie ce qui est LU et ÉCRIT.
type Doc = Record<string, unknown>;
const ts = (ms: number) => ({ toMillis: () => ms });

class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string) {
    const db = this;
    const snapDoc = (path: string) => {
      const d = db.data.get(path);
      return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k] };
    };
    const list = () => [...db.data.keys()].filter((k) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes('/')).map(snapDoc);
    const query = (filter: (d: ReturnType<typeof snapDoc>) => boolean, order?: { field: string; dir: 'asc' | 'desc' }, max?: number) => ({
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => query(filter, { field, dir }, max),
      where: (field: string, _op: string, value: unknown) => query((d) => filter(d) && d.get(field) === value, order, max),
      limit: (n: number) => query(filter, order, n),
      get: async () => {
        let docs = list().filter(filter);
        if (order) docs = docs.sort((a, b) => { const av = (a.get(order.field) as { toMillis?: () => number })?.toMillis?.() ?? 0; const bv = (b.get(order.field) as { toMillis?: () => number })?.toMillis?.() ?? 0; return order.dir === 'desc' ? bv - av : av - bv; });
        if (max !== undefined) docs = docs.slice(0, max);
        return { docs, size: docs.length };
      },
    });
    return {
      ...query(() => true),
      doc: (id: string) => ({
        get: async () => snapDoc(`${name}/${id}`),
        set: async (d: Doc) => { db.data.set(`${name}/${id}`, { ...d }); },
        update: async (patch: Doc) => { const cur = db.data.get(`${name}/${id}`); if (!cur) throw new Error('absent'); db.data.set(`${name}/${id}`, { ...cur, ...patch }); },
        create: async (d: Doc) => { if (db.data.has(`${name}/${id}`)) throw new Error('ALREADY_EXISTS'); db.data.set(`${name}/${id}`, { ...d }); },
        delete: async () => { db.data.delete(`${name}/${id}`); },
      }),
    };
  }
}

const NOW = Date.UTC(2026, 9, 22, 12, 0);

function seed() {
  const db = new FakeDb();
  db.data.set('cl_sources/pabbly', { name: 'Pabbly' });
  db.data.set('cl_rawLeads/r1', { receivedAt: ts(NOW - 10 * 60_000), channel: 'webhook', sourceId: 'pabbly', payloadJson: JSON.stringify({ full_name: 'Jean', phone: '0612345678', lead_id: 'EXT-1' }), leadId: 'L1', processingState: 'processed' });
  db.data.set('cl_rawLeads/r2', { receivedAt: ts(NOW - 20 * 60_000), channel: 'webhook', sourceId: 'pabbly', payloadJson: JSON.stringify({ full_name: 'Anne', access_token: 'secret123' }), leadId: null, processingState: 'rejected', rejectionCode: 'no_contact', rejectionReason: 'Aucun téléphone ni email.' });
  db.data.set('cl_conversions/L9', { state: 'failed', attempts: 3, lastError: { code: 'step_failed', message: 'Montant invalide' }, createdAt: ts(NOW - 3_600_000), updatedAt: ts(NOW - 600_000), dossierId: null });
  db.data.set('cl_audit/a1', { action: 'integration.replay', at: ts(NOW - 5 * 60_000), actorId: 'adm', after: { rawLeadId: 'rz', outcome: 'created', leadId: 'L5' } });
  db.data.set('cl_audit/a2', { action: 'lead.reassign', at: ts(NOW), actorId: 'm1', after: {} });
  return db;
}

describe('readJournal', () => {
  it('rassemble données brutes, transmissions et reprises, du plus récent au plus ancien', async () => {
    const r = await readJournal(seed() as never, NOW);
    expect(r.entries.map((e) => e.id)).toEqual(['audit_a1', 'conv_L9', 'raw_r1', 'raw_r2']);
    expect(r.truncated).toBe(false);
  });
  it('nom de la source, statut et erreur de chaque trace', async () => {
    const { entries } = await readJournal(seed() as never, NOW);
    const by = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(by.raw_r1).toMatchObject({ status: 'success', sourceLabel: 'Pabbly', reference: 'EXT-1', leadId: 'L1' });
    expect(by.raw_r2).toMatchObject({ status: 'error', replayable: true, error: { code: 'no_contact' } });
    expect(by.conv_L9).toMatchObject({ status: 'error', attempts: 3, error: { message: 'Montant invalide' } });
    expect(by.audit_a1).toMatchObject({ actorId: 'adm', operation: 'Reprise manuelle', leadId: 'L5' });
  });
  it('les secrets ne sortent jamais du serveur', async () => {
    const r = await readJournal(seed() as never, NOW);
    expect(JSON.stringify(r)).not.toContain('secret123');
  });
  it('seules les reprises sont lues dans le journal d’audit', async () => {
    const { entries } = await readJournal(seed() as never, NOW);
    expect(entries.filter((e) => e.kind === 'audit')).toHaveLength(1);
  });
  it('lecture bornée : signalée comme tronquée', async () => {
    const db = seed();
    for (let i = 0; i < RAW_LIMIT; i++) db.data.set(`cl_rawLeads/x${i}`, { receivedAt: ts(NOW - i), channel: 'webhook', payloadJson: '{}', processingState: 'processed' });
    expect((await readJournal(db as never, NOW)).truncated).toBe(true);
  });
  it('base vide : journal vide', async () => {
    expect(await readJournal(new FakeDb() as never, NOW)).toMatchObject({ entries: [], truncated: false });
  });
});

describe('replayRawLead', () => {
  const created = (id = 'L7'): IngestResult => ({ ok: true, kind: 'created', leadId: id, rawLeadId: 'new', assignmentState: 'assigned', ownerId: 'u1', bufferReason: null });
  const run = (db: FakeDb, over = {}, ingest = vi.fn(async (): Promise<IngestResult> => created())) => replayRawLead(db as never, { uid: 'adm', rawLeadId: 'r2', nowMs: NOW, ...over }, { ingest: ingest as never });

  it('rejoue le payload d’origine avec la correction, marque la reprise et la trace', async () => {
    const db = seed();
    const ingest = vi.fn(async (): Promise<IngestResult> => created());
    const r = await run(db, { overrides: { phone: ' 06 99 88 77 66 ' } }, ingest);
    expect(r).toMatchObject({ ok: true, kind: 'created', leadId: 'L7' });
    expect(ingest).toHaveBeenCalledWith(expect.anything(), { channel: 'webhook', sourceId: 'pabbly', payload: { full_name: 'Anne', access_token: 'secret123', phone: '06 99 88 77 66' }, nowMs: NOW, meta: { actorId: 'adm', batchId: 'replay_r2' } });
    expect(db.data.get('cl_rawLeads/r2')).toMatchObject({ replayedBy: 'adm', replayLeadId: 'L7', processingState: 'rejected' });
    expect(JSON.parse(String(db.data.get('cl_rawLeads/r2')!.payloadJson))).not.toHaveProperty('phone');
    expect(db.data.get(`cl_audit/replay_r2_${NOW}`)).toMatchObject({ action: 'integration.replay', actorId: 'adm', after: { rawLeadId: 'r2', outcome: 'created', leadId: 'L7', corrected: ['phone'] } });
  });
  it('rattaché à un lead existant : message qui le dit', async () => {
    const r = await run(seed(), {}, vi.fn(async (): Promise<IngestResult> => ({ ok: true, kind: 'attached', leadId: 'L0', rawLeadId: 'n', outcome: 'x' })));
    expect(r).toMatchObject({ ok: true, kind: 'attached' });
    if (r.ok) expect(r.message).toMatch(/aucun doublon/);
  });
  it('toujours refusé : rien n’est marqué repris, la garde est levée pour réessayer, la tentative est tracée', async () => {
    const db = seed();
    const r = await run(db, {}, vi.fn(async (): Promise<IngestResult> => ({ ok: false, kind: 'rejected', code: 'no_contact', reason: 'Aucun téléphone ni email.', rawLeadId: 'n' })));
    expect(r).toMatchObject({ ok: false, code: 'still_rejected' });
    expect(db.data.get('cl_rawLeads/r2')!.replayedAt).toBeUndefined();
    expect(db.data.has('cl_idempotency/replay_r2')).toBe(false);
    expect(db.data.get(`cl_audit/replay_r2_${NOW}`)).toMatchObject({ after: { outcome: 'rejected' } });
  });
  it('une seule reprise : la seconde est refusée, rien n’est ré-ingéré', async () => {
    const db = seed();
    const ingest = vi.fn(async (): Promise<IngestResult> => created());
    await run(db, {}, ingest);
    expect(await run(db, {}, ingest)).toMatchObject({ ok: false, code: 'already' });
    expect(ingest).toHaveBeenCalledTimes(1);
  });
  it('reprise déjà en cours (garde posée) : refusée', async () => {
    const db = seed();
    db.data.set('cl_idempotency/replay_r2', { uid: 'x' });
    const ingest = vi.fn();
    expect(await run(db, {}, ingest as never)).toMatchObject({ ok: false, code: 'busy' });
    expect(ingest).not.toHaveBeenCalled();
  });
  it('donnée traitée, introuvable ou illisible : refusée', async () => {
    const db = seed();
    expect(await run(db, { rawLeadId: 'r1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(db, { rawLeadId: 'nope' })).toMatchObject({ ok: false, code: 'not_found' });
    db.data.set('cl_rawLeads/bad', { receivedAt: ts(NOW), channel: 'webhook', payloadJson: 'pas du json', processingState: 'rejected' });
    expect(await run(db, { rawLeadId: 'bad' })).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('donnée « reçue » jamais traitée au-delà de 5 minutes : reprenable ; récente : non', async () => {
    const db = seed();
    db.data.set('cl_rawLeads/stuck', { receivedAt: ts(NOW - 10 * 60_000), channel: 'import', sourceId: null, payloadJson: JSON.stringify({ phone: '0612345678' }), processingState: 'received' });
    db.data.set('cl_rawLeads/fresh', { receivedAt: ts(NOW - 30_000), channel: 'import', payloadJson: '{}', processingState: 'received' });
    expect(await run(db, { rawLeadId: 'stuck' })).toMatchObject({ ok: true });
    expect(await run(db, { rawLeadId: 'fresh' })).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('erreur technique : la garde est levée, l’erreur remonte, la donnée brute reste intacte', async () => {
    const db = seed();
    await expect(run(db, {}, vi.fn(async () => { throw new Error('boom'); }) as never)).rejects.toThrow('boom');
    expect(db.data.has('cl_idempotency/replay_r2')).toBe(false);
    expect(db.data.get('cl_rawLeads/r2')!.replayedAt).toBeUndefined();
  });
  it('corrections vides ignorées', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => created());
    await run(seed(), { overrides: { phone: '  ', email: '' } }, ingest);
    expect((ingest.mock.calls[0] as unknown[])[1]).toMatchObject({ payload: { full_name: 'Anne', access_token: 'secret123' } });
  });
});
