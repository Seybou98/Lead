import { describe, expect, it, vi } from 'vitest';
import { handleQualificationHttp, type QualificationHttpDeps, type QualificationHttpInput } from './qualificationFormHttp';
import type { QualificationOutcome } from './qualificationForm';

const OK: QualificationOutcome = { ok: true, message: 'Qualification complète (formulaire v3).', status: 'complete', version: 3, eligibility: 'ok' };

const deps = (over: Partial<QualificationHttpDeps> = {}): QualificationHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'telepro' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => JSON.stringify({ leadId: 'L1', requestId: 'req-12345678', answers: { q_owner: true }, ...over });
const req = (over: Partial<QualificationHttpInput> = {}): QualificationHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleQualificationHttp', () => {
  it('200 : transmet l’identité du jeton (jamais celle du corps), le rôle et les réponses', async () => {
    const d = deps();
    const r = await handleQualificationHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r).toEqual({ status: 200, body: OK });
    expect(d.run).toHaveBeenCalledWith({ uid: 'u1', role: 'telepro', leadId: 'L1', answers: { q_owner: true }, requestId: 'req-12345678' });
  });
  it('405 si ce n’est pas un POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleQualificationHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });
  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) expect((await handleQualificationHttp(req({ authorization }), d)).status).toBe(401);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('400 : corps illisible, identifiants invalides, réponses absentes ou mal formées', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', body({ leadId: '../x' }), body({ leadId: 5 }), body({ requestId: 'court' }), body({ answers: undefined }), body({ answers: [] }), body({ answers: 'x' })]) {
      expect((await handleQualificationHttp(req({ rawBody }), d)).status).toBe(400);
    }
    expect(d.run).not.toHaveBeenCalled();
  });
  it('403 sans accès au CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleQualificationHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });
  it('codes métier : 403, 404, 409 (clôturé ou aucun formulaire), 422', async () => {
    const out = (code: 'forbidden' | 'not_found' | 'lead_closed' | 'no_form' | 'invalid') => deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'refus' })) });
    expect((await handleQualificationHttp(req(), out('forbidden'))).status).toBe(403);
    expect((await handleQualificationHttp(req(), out('not_found'))).status).toBe(404);
    expect((await handleQualificationHttp(req(), out('lead_closed'))).status).toBe(409);
    expect((await handleQualificationHttp(req(), out('no_form'))).status).toBe(409);
    const r = await handleQualificationHttp(req(), out('invalid'));
    expect(r).toEqual({ status: 422, body: { ok: false, error: 'invalid', message: 'refus' } });
  });
  it('500 : erreur interne journalisée, sans fuite', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('boom secret'); }) });
    const r = await handleQualificationHttp(req(), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(d.log.error).toHaveBeenCalled();
  });
});
