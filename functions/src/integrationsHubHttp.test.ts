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

describe('handleHubHttp : erreurs de transmission et test de connexion', () => {
  const errors = vi.fn(async () => ({ entries: [], truncated: false }));
  const test = vi.fn(async () => ({ ok: true, ms: 40, message: 'Connexion établie' }));
  it('manager : voit les erreurs de son périmètre (son identité vient du jeton), rien d’autre', async () => {
    const d = deps({ resolveRole: vi.fn(async () => 'manager' as const), errors, test });
    expect(await handleHubHttp(req({ action: 'errors', uid: 'pirate' }), d)).toEqual({ status: 200, body: { ok: true, entries: [], truncated: false } });
    expect(errors).toHaveBeenCalledWith('adm', 'manager');
    for (const body of [{ action: 'journal' }, { action: 'test' }, { action: 'replay', rawLeadId: 'rx_1' }]) expect((await handleHubHttp(req(body), d)).status).toBe(403);
    expect(test).not.toHaveBeenCalled();
  });
  it('administrateur : erreurs de toutes les équipes, test de connexion', async () => {
    const d = deps({ errors, test });
    expect((await handleHubHttp(req({ action: 'errors' }), d)).status).toBe(200);
    expect(errors).toHaveBeenLastCalledWith('adm', 'admin');
    expect(await handleHubHttp(req({ action: 'test' }), d)).toEqual({ status: 200, body: { ok: true, reachable: true, ms: 40, message: 'Connexion établie' } });
  });
  it('télépro ou compte inactif : refusé pour les erreurs aussi', async () => {
    for (const role of ['telepro', null] as const) expect((await handleHubHttp(req({ action: 'errors' }), deps({ resolveRole: vi.fn(async () => role), errors }))).status).toBe(403);
  });
  it('échec du test : 200 avec reachable false (la fonction répond, c’est le CRM principal qui ne répond pas)', async () => {
    const r = await handleHubHttp(req({ action: 'test' }), deps({ test: vi.fn(async () => ({ ok: false, ms: 5000, message: 'Lecture impossible' })) }));
    expect(r.body).toMatchObject({ ok: true, reachable: false });
  });
});
