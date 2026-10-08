import { describe, expect, it, vi } from 'vitest';
import { handlePortfolioHttp, type PortfolioHttpDeps, type PortfolioHttpInput } from './portfolioHttp';
import type { PortfolioResult } from './portfolio';

const OK: PortfolioResult = { ok: true, message: 'fait' };

const deps = (over: Partial<PortfolioHttpDeps> = {}): PortfolioHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'm1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'manager' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});
const absence = { kind: 'declare_absence', userId: 'u1', requestId: 'req-12345678', input: { type: 'leave' } };
const transfer = { kind: 'transfer', fromUid: 'u1', batchId: 'batch-12345678', assignments: [{ leadId: 'L1', targetUid: 'u2' }], reason: 'Congé', returnAtMs: null };
const req = (body: unknown, over: Partial<PortfolioHttpInput> = {}): PortfolioHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: JSON.stringify(body), ...over });

describe('handlePortfolioHttp', () => {
  it('200 : transmet l\'identité et le rôle du jeton, jamais ceux du corps', async () => {
    const d = deps();
    const r = await handlePortfolioHttp(req({ ...absence, uid: 'pirate', role: 'admin' }), d);
    expect(r).toEqual({ status: 200, body: OK });
    expect(d.run).toHaveBeenCalledWith({ kind: 'declare_absence', uid: 'm1', role: 'manager', requestId: 'req-12345678', userId: 'u1', input: { type: 'leave' } });
  });
  it('transfert et fin d\'absence : formes acceptées', async () => {
    const d = deps();
    expect((await handlePortfolioHttp(req(transfer), d)).status).toBe(200);
    expect(d.run).toHaveBeenLastCalledWith({ kind: 'transfer', uid: 'm1', role: 'manager', fromUid: 'u1', batchId: 'batch-12345678', assignments: transfer.assignments, reason: 'Congé', returnAtMs: null });
    expect((await handlePortfolioHttp(req({ kind: 'end_absence', absenceId: 'abs_1' }), d)).status).toBe(200);
    expect((await handlePortfolioHttp(req({ ...transfer, returnAtMs: 1_800_000_000_000 }), d)).status).toBe(200);
  });
  it('405 hors POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handlePortfolioHttp(req(absence, { method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });
  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer bad']) expect((await handlePortfolioHttp(req(absence, { authorization }), d)).status).toBe(401);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('400 : corps illisible, action inconnue, identifiants ou champs invalides', async () => {
    const d = deps();
    const bad: unknown[] = [
      null, [], { kind: 'explode' }, { kind: 'constructor' }, {},
      { ...absence, userId: '../x' }, { ...absence, requestId: 'court' },
      { kind: 'end_absence', absenceId: '' }, { kind: 'end_absence' },
      { ...transfer, fromUid: 3 }, { ...transfer, batchId: 'x' }, { ...transfer, assignments: 'non' }, { ...transfer, returnAtMs: 'demain' },
    ];
    for (const b of bad) expect((await handlePortfolioHttp(req(b), d)).status).toBe(400);
    expect((await handlePortfolioHttp({ method: 'POST', authorization: 'Bearer good', rawBody: 'pas du json' }, d)).status).toBe(400);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('403 pour un télépro ou un compte sans accès, sans exécuter', async () => {
    for (const role of ['telepro', null] as const) {
      const d = deps({ resolveRole: vi.fn(async () => role) });
      expect((await handlePortfolioHttp(req(absence), d)).status).toBe(403);
      expect(d.run).not.toHaveBeenCalled();
    }
  });
  it('codes de refus métier', async () => {
    const cases: [Extract<PortfolioResult, { ok: false }>['code'], number][] = [['forbidden', 403], ['not_found', 404], ['invalid', 422], ['conflict', 409]];
    for (const [code, status] of cases) {
      const r = await handlePortfolioHttp(req(absence), deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) }));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, error: code, message: 'non' });
    }
  });
  it('500 sans fuite du détail', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handlePortfolioHttp(req(absence), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(d.log.error).toHaveBeenCalled();
  });
});
