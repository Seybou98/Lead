import { describe, expect, it, vi } from 'vitest';
import { handleHubHttp, type HubHttpDeps, type HubHttpInput } from './integrationsHubHttp';
import type { ReplayOutcome } from './integrationsHub';

const OK: ReplayOutcome = { ok: true, kind: 'created', leadId: 'L7', message: 'Lead créé à partir de la donnée reprise.' };
const JOURNAL = { entries: [], truncated: false, limits: { raw: 400, conversions: 300 } };

const deps = (over: Partial<HubHttpDeps> = {}): HubHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'adm' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'admin' as const),
  journal: vi.fn(async () => JOURNAL),
  replay: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const req = (body: unknown, over: Partial<HubHttpInput> = {}): HubHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: JSON.stringify(body), ...over });

describe('handleHubHttp', () => {
  it('journal : 200 avec les entrées', async () => {
    const d = deps();
    expect(await handleHubHttp(req({ action: 'journal' }), d)).toEqual({ status: 200, body: { ok: true, ...JOURNAL } });
    expect(d.replay).not.toHaveBeenCalled();
  });
  it('reprise : transmet l’identité du jeton (jamais celle du corps) et les corrections', async () => {
    const d = deps();
    const r = await handleHubHttp(req({ action: 'replay', rawLeadId: 'rx_1', uid: 'pirate', overrides: { phone: '0612345678', email: 5 } }), d);
    expect(r).toEqual({ status: 200, body: OK });
    expect(d.replay).toHaveBeenCalledWith({ uid: 'adm', rawLeadId: 'rx_1', overrides: { phone: '0612345678', email: undefined } });
  });
  it('405 hors POST ; 401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    expect((await handleHubHttp(req({ action: 'journal' }, { method: 'GET' }), d)).status).toBe(405);
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) expect((await handleHubHttp(req({ action: 'journal' }, { authorization }), d)).status).toBe(401);
    expect(d.journal).not.toHaveBeenCalled();
  });
  it('403 : réservé à l’administrateur (manager, télépro, compte inactif)', async () => {
    for (const role of ['manager', 'telepro', null] as const) {
      const d = deps({ resolveRole: vi.fn(async () => role) });
      expect((await handleHubHttp(req({ action: 'journal' }), d)).status).toBe(403);
      expect((await handleHubHttp(req({ action: 'replay', rawLeadId: 'r1' }), d)).status).toBe(403);
      expect(d.journal).not.toHaveBeenCalled();
      expect(d.replay).not.toHaveBeenCalled();
    }
  });
  it('400 : corps illisible, action inconnue, identifiant de donnée invalide, corrections mal formées', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', JSON.stringify({ action: 'delete' }), JSON.stringify({ action: 'replay' }), JSON.stringify({ action: 'replay', rawLeadId: '../x' }), JSON.stringify({ action: 'replay', rawLeadId: 'r1', overrides: 'x' }), JSON.stringify({ action: 'replay', rawLeadId: 'r1', overrides: null }), JSON.stringify({ action: 'replay', rawLeadId: 'r1', overrides: [] })]) {
      expect((await handleHubHttp(req({}, { rawBody }), d)).status).toBe(400);
    }
    expect(d.replay).not.toHaveBeenCalled();
  });
  it('refus métier : 404, 409, 422 avec le message', async () => {
    const out = (code: 'not_found' | 'invalid' | 'already' | 'busy' | 'still_rejected') => deps({ replay: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) });
    const cases: [Parameters<typeof out>[0], number][] = [['not_found', 404], ['already', 409], ['busy', 409], ['invalid', 422], ['still_rejected', 422]];
    for (const [code, status] of cases) expect(await handleHubHttp(req({ action: 'replay', rawLeadId: 'r1' }), out(code))).toEqual({ status, body: { ok: false, error: code, message: 'non' } });
  });
  it('500 sans fuite du détail', async () => {
    const d = deps({ journal: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handleHubHttp(req({ action: 'journal' }), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(d.log.error).toHaveBeenCalled();
  });
});
