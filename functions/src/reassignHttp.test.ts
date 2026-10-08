import { describe, expect, it, vi } from 'vitest';
import { handleReassignHttp, type ReassignHttpDeps, type ReassignHttpInput } from './reassignHttp';
import type { ReassignOutcome as DocumentsResult } from './reassign';

const OK: DocumentsResult = { ok: true, replay: false, message: 'Lead réattribué.', ownerId: 'u2' };

const deps = (over: Partial<ReassignHttpDeps> = {}): ReassignHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'telepro' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => JSON.stringify({ leadId: 'L1', targetUid: 'u2', requestId: 'req-12345678', reason: 'Absent', ...over });
const req = (over: Partial<ReassignHttpInput> = {}): ReassignHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleReassignHttp', () => {
  it('200 : transmet l\'identité du jeton (jamais celle du corps), le rôle et la saisie', async () => {
    const d = deps();
    const r = await handleReassignHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(OK);
    expect(d.run).toHaveBeenCalledWith({ uid: 'u1', role: 'telepro', leadId: 'L1', targetUid: 'u2', requestId: 'req-12345678', reason: 'Absent' });
  });

  it('405 si ce n\'est pas un POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleReassignHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });

  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) {
      expect((await handleReassignHttp(req({ authorization }), d)).status).toBe(401);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('400 : corps illisible, identifiants invalides, action inconnue', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', body({ leadId: '../x' }), body({ leadId: 5 }), body({ requestId: 'court' }), body({ targetUid: '../x' }), body({ targetUid: 5 }), body({ targetUid: undefined })]) {
      expect((await handleReassignHttp(req({ rawBody }), d)).status).toBe(400);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('403 sans accès au CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleReassignHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('codes de refus métier : 403, 404, 409, 422', async () => {
    const cases: [Extract<DocumentsResult, { ok: false }>['code'], number][] = [['forbidden', 403], ['not_found', 404], ['lead_closed', 409], ['invalid', 422]];
    for (const [code, status] of cases) {
      const r = await handleReassignHttp(req(), deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) }));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, error: code, message: 'non' });
    }
  });

  it('500 sans fuite du détail', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handleReassignHttp(req(), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect(d.log.error).toHaveBeenCalled();
  });
});
