import { describe, expect, it, vi } from 'vitest';
import { handleImportHttp, MAX_BODY_BYTES, type ImportHttpDeps, type ImportHttpInput } from './importLeadsHttp';
import type { ImportOutcome } from './importLeads';

const OK: ImportOutcome = { ok: true, replay: false, results: [{ row: 2, ok: true, kind: 'created', leadId: 'L1' }], summary: { created: 1, attached: 0, rejected: 0 } };

const deps = (over: Partial<ImportHttpDeps> = {}): ImportHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'm1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'manager' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => JSON.stringify({ channel: 'import', sourceId: 'src1', batchId: 'batch-12345678', startRow: 2, rows: [{ phone: '0612345678' }], ...over });
const req = (over: Partial<ImportHttpInput> = {}): ImportHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleImportHttp', () => {
  it('200 : transmet l’identité du jeton (jamais celle du corps), le rôle, le canal, la source et les lignes', async () => {
    const d = deps();
    const r = await handleImportHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r).toEqual({ status: 200, body: OK });
    expect(d.run).toHaveBeenCalledWith({ uid: 'm1', role: 'manager', channel: 'import', sourceId: 'src1', batchId: 'batch-12345678', startRow: 2, rows: [{ phone: '0612345678' }] });
  });
  it('source absente : null ; première ligne par défaut : 2', async () => {
    const d = deps();
    await handleImportHttp(req({ rawBody: JSON.stringify({ channel: 'manual', batchId: 'batch-12345678', rows: [{}] }) }), d);
    expect(d.run).toHaveBeenCalledWith(expect.objectContaining({ channel: 'manual', sourceId: null, startRow: 2 }));
  });
  it('405 hors POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleImportHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });
  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) expect((await handleImportHttp(req({ authorization }), d)).status).toBe(401);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('400 : corps illisible, canal, lot ou lignes invalides', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', body({ channel: 'webhook' }), body({ batchId: 'court' }), body({ batchId: '../x/y/z/w' }), body({ rows: 'x' }), body({ rows: undefined }), body({ sourceId: 5 }), body({ sourceId: '../x' }), body({ startRow: 0 }), body({ startRow: '2' }), body({ startRow: 2.5 })]) {
      expect((await handleImportHttp(req({ rawBody }), d)).status).toBe(400);
    }
    expect(d.run).not.toHaveBeenCalled();
  });
  it('413 : corps trop volumineux, avant toute lecture', async () => {
    const d = deps();
    const r = await handleImportHttp(req({ rawBody: 'x'.repeat(MAX_BODY_BYTES + 1) }), d);
    expect(r.status).toBe(413);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('403 sans accès au CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleImportHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('refus métier : 403 et 422, avec le message', async () => {
    const out = (code: 'forbidden' | 'invalid') => deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) });
    expect(await handleImportHttp(req(), out('forbidden'))).toEqual({ status: 403, body: { ok: false, error: 'forbidden', message: 'non' } });
    expect(await handleImportHttp(req(), out('invalid'))).toEqual({ status: 422, body: { ok: false, error: 'invalid', message: 'non' } });
  });
  it('500 sans fuite du détail', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handleImportHttp(req(), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(d.log.error).toHaveBeenCalled();
  });
});
