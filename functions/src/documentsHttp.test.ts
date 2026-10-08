import { describe, expect, it, vi } from 'vitest';
import { handleDocumentsHttp, type DocumentsHttpDeps, type DocumentsHttpInput } from './documentsHttp';
import type { DocumentsResult } from './documents';

const OK: DocumentsResult = { ok: true, replay: false, message: 'Pièce reçue.', status: 'awaiting_documents', state: 'partial', nextActionAtMs: 1 };

const deps = (over: Partial<DocumentsHttpDeps> = {}): DocumentsHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'telepro' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => JSON.stringify({ leadId: 'L1', requestId: 'req-12345678', input: { kind: 'receive', code: 'identity' }, ...over });
const req = (over: Partial<DocumentsHttpInput> = {}): DocumentsHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleDocumentsHttp', () => {
  it('200 : transmet l\'identité du jeton (jamais celle du corps), le rôle et la saisie', async () => {
    const d = deps();
    const r = await handleDocumentsHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(OK);
    expect(d.run).toHaveBeenCalledWith({ uid: 'u1', role: 'telepro', leadId: 'L1', requestId: 'req-12345678', input: { kind: 'receive', code: 'identity' } });
  });

  it('405 si ce n\'est pas un POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleDocumentsHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });

  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) {
      expect((await handleDocumentsHttp(req({ authorization }), d)).status).toBe(401);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('400 : corps illisible, identifiants invalides, action inconnue', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', body({ leadId: '../x' }), body({ leadId: 5 }), body({ requestId: 'court' }), body({ input: null }), body({ input: {} }), body({ input: { kind: 'explode' } }), body({ input: { kind: 'constructor' } })]) {
      expect((await handleDocumentsHttp(req({ rawBody }), d)).status).toBe(400);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('403 sans accès au CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleDocumentsHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('codes de refus métier : 403, 404, 409, 422', async () => {
    const cases: [Extract<DocumentsResult, { ok: false }>['code'], number][] = [['forbidden', 403], ['not_found', 404], ['lead_closed', 409], ['unavailable', 409], ['invalid', 422]];
    for (const [code, status] of cases) {
      const r = await handleDocumentsHttp(req(), deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) }));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, error: code, message: 'non' });
    }
  });

  it('500 sans fuite du détail', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handleDocumentsHttp(req(), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect(d.log.error).toHaveBeenCalled();
  });
});
