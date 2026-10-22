import { describe, expect, it, vi } from 'vitest';
import { importLeads, MAX_ROWS_PER_BATCH, sanitizeRow, type ImportArgs } from './importLeads';
import type { IngestResult } from './ingest';

// Base en mémoire : on vérifie ce que importLeads ÉCRIT (idempotence, audit) ; la réception est simulée.
type Doc = Record<string, unknown>;
class FakeDb {
  data = new Map<string, Doc>();
  collection(name: string) {
    return {
      doc: (id: string) => ({
        get: async () => ({ exists: this.data.has(`${name}/${id}`), get: (k: string) => this.data.get(`${name}/${id}`)?.[k] }),
        set: async (d: Doc) => { this.data.set(`${name}/${id}`, { ...d }); },
      }),
    };
  }
}

const NOW = Date.UTC(2026, 9, 22, 9, 0);
let n = 0;
const args = (over: Partial<ImportArgs> = {}): ImportArgs => ({ uid: 'm1', role: 'manager', channel: 'import', sourceId: null, batchId: `batch-${String(++n).padStart(6, '0')}`, startRow: 2, rows: [{ phone: '0612345678' }], nowMs: NOW, ...over });
const created = (leadId: string): IngestResult => ({ ok: true, kind: 'created', leadId, rawLeadId: `raw-${leadId}`, assignmentState: 'assigned', ownerId: 'u1', bufferReason: null });
const run = (db: FakeDb, a: ImportArgs, ingest = vi.fn(async (): Promise<IngestResult> => created('L1'))) => importLeads(db as never, a, { ingest: ingest as never });

describe('importLeads : droits et forme', () => {
  it('administrateur et manager seulement', async () => {
    for (const role of ['admin', 'manager'] as const) expect((await run(new FakeDb(), args({ role }))).ok).toBe(true);
    expect(await run(new FakeDb(), args({ role: 'telepro' }))).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('aucune ligne, trop de lignes, saisie manuelle de plusieurs lignes : refusés', async () => {
    expect(await run(new FakeDb(), args({ rows: [] }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(new FakeDb(), args({ rows: Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, () => ({ phone: '1' })) }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(new FakeDb(), args({ channel: 'manual', rows: [{ phone: '1' }, { phone: '2' }] }))).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('rien n’est transmis quand le lot est refusé', async () => {
    const ingest = vi.fn();
    await run(new FakeDb(), args({ role: 'telepro' }), ingest as never);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('importLeads : traitement', () => {
  it('chaque ligne suit la réception, avec le canal, la source, l’auteur, le lot et le numéro de ligne', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => created('L1'));
    const a = args({ sourceId: 'src1', startRow: 12, rows: [{ phone: '1' }, { phone: '2' }] });
    await run(new FakeDb(), a, ingest);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenNthCalledWith(1, expect.anything(), { channel: 'import', sourceId: 'src1', payload: { phone: '1' }, nowMs: NOW, meta: { actorId: 'm1', batchId: a.batchId, row: 12 } });
    expect(ingest).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ meta: { actorId: 'm1', batchId: a.batchId, row: 13 } }));
  });
  it('résultats par ligne : créé, rattaché (doublon), rejeté', async () => {
    const results: IngestResult[] = [created('L1'), { ok: true, kind: 'attached', leadId: 'L0', rawLeadId: 'r', outcome: 'interaction_added' }, { ok: false, kind: 'rejected', code: 'no_contact', reason: 'Aucun téléphone ni email.', rawLeadId: 'r' }];
    let i = 0;
    const r = await run(new FakeDb(), args({ rows: [{}, {}, {}] }), vi.fn(async () => results[i++]) as never);
    expect(r).toMatchObject({ ok: true, replay: false, summary: { created: 1, attached: 1, rejected: 1 } });
    if (!r.ok) throw new Error();
    expect(r.results.map((x) => [x.row, x.ok])).toEqual([[2, true], [3, true], [4, false]]);
    expect(r.results[2]).toMatchObject({ code: 'no_contact', reason: 'Aucun téléphone ni email.' });
  });
  it('une ligne en erreur technique n’interrompt pas les suivantes', async () => {
    let i = 0;
    const ingest = vi.fn(async (): Promise<IngestResult> => { if (i++ === 0) throw new Error('boom'); return created('L2'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await run(new FakeDb(), args({ rows: [{ phone: '1' }, { phone: '2' }] }), ingest as never);
    if (!r.ok) throw new Error();
    expect(r.results[0]).toMatchObject({ ok: false, code: 'error' });
    expect(r.results[1]).toMatchObject({ ok: true, kind: 'created' });
    expect(JSON.stringify(r)).not.toContain('boom');
  });
  it('ligne qui n’est pas un objet : refusée sans appel à la réception', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => created('L1'));
    const r = await run(new FakeDb(), args({ rows: ['texte', null, [1]] }), ingest as never);
    if (!r.ok) throw new Error();
    expect(r.results.every((x) => !x.ok && x.code === 'invalid_row')).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('importLeads : temps imparti', () => {
  it('s’arrête avant le délai de la fonction et rend ce qui est traité', async () => {
    let t = 0;
    const ingest = vi.fn(async (): Promise<IngestResult> => { t += 5_000; return created(); });
    const r = await importLeads(new FakeDb() as never, args({ rows: [{ phone: '1' }, { phone: '2' }, { phone: '3' }, { phone: '4' }] }), { ingest: ingest as never, clock: () => t, budgetMs: 8_000 });
    if (!r.ok) throw new Error();
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(2);
    expect(r.results.map((x) => x.row)).toEqual([2, 3]);
    expect(r.summary.created).toBe(2);
  });
  it('au moins une ligne par appel, même si le délai est déjà écoulé', async () => {
    let t = 0;
    const ingest = vi.fn(async (): Promise<IngestResult> => { t += 60_000; return created(); });
    const r = await importLeads(new FakeDb() as never, args({ rows: [{ phone: '1' }, { phone: '2' }] }), { ingest: ingest as never, clock: () => t, budgetMs: 1 });
    if (!r.ok) throw new Error();
    expect(r.processed).toBe(1);
  });
  it('rejeu d’un lot partiel : mêmes résultats et même nombre de lignes traitées', async () => {
    let t = 0;
    const db = new FakeDb();
    const ingest = vi.fn(async (): Promise<IngestResult> => { t += 5_000; return created(); });
    const a = args({ rows: [{ phone: '1' }, { phone: '2' }, { phone: '3' }] });
    const first = await importLeads(db as never, a, { ingest: ingest as never, clock: () => t, budgetMs: 6_000 });
    const again = await importLeads(db as never, a, { ingest: ingest as never, clock: () => t, budgetMs: 6_000 });
    if (!first.ok || !again.ok) throw new Error();
    expect(again).toMatchObject({ replay: true, processed: first.processed });
    expect(ingest).toHaveBeenCalledTimes(first.processed);
  });
  it('tout est traité quand le temps suffit', async () => {
    const r = await importLeads(new FakeDb() as never, args({ rows: [{ phone: '1' }, { phone: '2' }] }), { ingest: vi.fn(async (): Promise<IngestResult> => created()) as never });
    if (!r.ok) throw new Error();
    expect(r.processed).toBe(2);
  });
});

describe('importLeads : idempotence et audit', () => {
  it('rejeu du même lot : mêmes résultats, aucune ligne ré-importée', async () => {
    const db = new FakeDb();
    const ingest = vi.fn(async (): Promise<IngestResult> => created('L1'));
    const a = args();
    const first = await run(db, a, ingest);
    const second = await run(db, a, ingest);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !second.ok) throw new Error();
    expect(second.results).toEqual(first.results);
  });
  it('le lot d’un autre utilisateur ne se rejoue pas', async () => {
    const db = new FakeDb();
    const a = args();
    await run(db, a);
    expect(await run(db, { ...a, uid: 'm2' })).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('une trace d’audit par lot : auteur, lot, volumes, source', async () => {
    const db = new FakeDb();
    const a = args({ sourceId: 'src1' });
    await run(db, a);
    expect(db.data.get(`cl_audit/import_${a.batchId}_2`)).toMatchObject({ action: 'leads.import', actorId: 'm1', entityType: 'lead_batch', entityId: a.batchId, after: { rows: 1, created: 1, attached: 0, rejected: 0, sourceId: 'src1' } });
  });
  it('saisie manuelle : action d’audit propre', async () => {
    const db = new FakeDb();
    const a = args({ channel: 'manual' });
    await run(db, a);
    expect(db.data.get(`cl_audit/import_${a.batchId}_2`)).toMatchObject({ action: 'lead.manual_create' });
  });
});

describe('sanitizeRow', () => {
  it('valeurs simples uniquement, tailles bornées', () => {
    expect(sanitizeRow({ phone: ' 06 ', n: 3, ok: true, obj: { a: 1 }, arr: [1], nul: null, '': 'x', long: 'a'.repeat(900) })).toMatchObject({ phone: ' 06 ', n: 3, ok: true });
    const out = sanitizeRow({ obj: { a: 1 }, arr: [1], nul: null, long: 'a'.repeat(900) }) ?? {};
    expect(Object.keys(out)).toEqual(['long']);
    expect(String(out.long)).toHaveLength(500);
  });
  it('pas un objet : null', () => {
    for (const v of ['x', 1, null, undefined, [1]]) expect(sanitizeRow(v)).toBeNull();
  });
  it('plus de 40 champs : les premiers seulement', () => {
    expect(Object.keys(sanitizeRow(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v']))) ?? {})).toHaveLength(40);
  });
});
