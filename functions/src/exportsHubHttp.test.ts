import { describe, expect, it, vi } from 'vitest';
import type { Role } from '../../src/domain/enums';
import type { ExportRun } from '../../src/domain/reports/schedule';
import { handleExportsHttp, type ExportsHttpDeps } from './exportsHubHttp';

const RUN = { id: 'r1', files: [{ scope: 'all', path: 'secret/path', filename: 'a.csv', mime: 'text/csv', bytes: 1, rows: 1, recipients: [] }] } as unknown as ExportRun;

function deps(role: Role | null = 'admin', over: Partial<ExportsHttpDeps> = {}): ExportsHttpDeps {
  return {
    verifyToken: async (t) => { if (t !== 'good') throw new Error('bad'); return 'u1'; },
    resolveRole: async () => role,
    runs: vi.fn(async () => [RUN]),
    runNow: vi.fn(async () => ({ ok: true as const, run: RUN })),
    resend: vi.fn(async () => ({ ok: true as const, run: RUN })),
    download: vi.fn(async () => ({ ok: true as const, filename: 'a.csv', mime: 'text/csv', content: 'x' })),
    log: { warn: () => undefined, error: () => undefined },
    ...over,
  };
}
const call = (body: unknown, d: ExportsHttpDeps, o: { method?: string; auth?: string } = {}) =>
  handleExportsHttp({ method: o.method ?? 'POST', authorization: o.auth === undefined ? 'Bearer good' : o.auth, rawBody: typeof body === 'string' ? body : JSON.stringify(body) }, d);

describe('exports-hub : identité et forme', () => {
  it('méthode, jeton absent ou refusé, corps illisible', async () => {
    expect((await call({ action: 'runs' }, deps(), { method: 'GET' })).status).toBe(405);
    expect((await call({ action: 'runs' }, deps(), { auth: '' })).status).toBe(401);
    expect((await call({ action: 'runs' }, deps(), { auth: 'Bearer nope' })).status).toBe(401);
    expect((await call('pas du json', deps())).status).toBe(400);
    expect((await call({ action: 'autre' }, deps())).status).toBe(400);
    expect((await call({ action: 'run' }, deps())).status).toBe(400);
    expect((await call({ action: 'download', runId: '../x' }, deps())).status).toBe(400);
    expect((await call({ action: 'download', runId: 'r1', file: '../x' }, deps())).status).toBe(400);
    expect((await call({ action: 'download', runId: 'r1', file: 3 }, deps())).status).toBe(400);
  });
  it('télépro, compte inactif : refusé', async () => {
    expect((await call({ action: 'runs' }, deps('telepro'))).status).toBe(403);
    expect((await call({ action: 'runs' }, deps(null))).status).toBe(403);
  });
});

describe('exports-hub : actions', () => {
  it('historique : administrateur et manager, chemins de stockage retirés', async () => {
    for (const role of ['admin', 'manager'] as const) {
      const d = deps(role);
      const out = await call({ action: 'runs' }, d);
      expect(out.status).toBe(200);
      expect(JSON.stringify(out.body)).not.toContain('secret/path');
      expect(d.runs).toHaveBeenCalledWith(role, 'u1');
    }
  });
  it('téléchargement : transmet l’identité du jeton, jamais celle du corps', async () => {
    const d = deps('manager');
    await call({ action: 'download', runId: 'r1', file: 'm1', uid: 'pirate' }, d);
    expect(d.download).toHaveBeenCalledWith({ runId: 'r1', scope: 'm1', uid: 'u1', role: 'manager' });
  });
  it('téléchargement : introuvable 404, supprimé 410', async () => {
    const nf = deps('manager', { download: async () => ({ ok: false, code: 'not_found', message: 'x' }) });
    expect((await call({ action: 'download', runId: 'r1' }, nf)).status).toBe(404);
    const gone = deps('admin', { download: async () => ({ ok: false, code: 'expired', message: 'x' }) });
    expect((await call({ action: 'download', runId: 'r1' }, gone)).status).toBe(410);
  });
  it('exécuter maintenant et renvoyer : administrateur seulement', async () => {
    const m = deps('manager');
    expect((await call({ action: 'run', scheduleId: 's_1' }, m)).status).toBe(403);
    expect((await call({ action: 'resend', runId: 'r1' }, m)).status).toBe(403);
    expect(m.runNow).not.toHaveBeenCalled();
    const a = deps('admin');
    expect((await call({ action: 'run', scheduleId: 's_1' }, a)).status).toBe(200);
    expect(a.runNow).toHaveBeenCalledWith('s_1', 'u1');
    expect((await call({ action: 'resend', runId: 'r1' }, a)).status).toBe(200);
  });
  it('codes de refus : introuvable 404, déjà exécuté 409, refus 422', async () => {
    const nf = deps('admin', { runNow: async () => ({ ok: false, code: 'not_found', message: 'x' }) });
    expect((await call({ action: 'run', scheduleId: 's_1' }, nf)).status).toBe(404);
    const ex = deps('admin', { runNow: async () => ({ ok: false, code: 'exists', message: 'x' }) });
    expect((await call({ action: 'run', scheduleId: 's_1' }, ex)).status).toBe(409);
    const st = deps('admin', { runNow: async () => ({ ok: false, code: 'storage', message: 'x' }) });
    expect((await call({ action: 'run', scheduleId: 's_1' }, st)).status).toBe(422);
    const inv = deps('admin', { resend: async () => ({ ok: false, code: 'invalid', message: 'x' }) });
    expect((await call({ action: 'resend', runId: 'r1' }, inv)).status).toBe(422);
  });
  it('erreur interne : 500 sans détail', async () => {
    const d = deps('admin', { runs: async () => { throw new Error('boom secret'); } });
    const out = await call({ action: 'runs' }, d);
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('boom');
  });
});
