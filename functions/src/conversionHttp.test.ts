import { describe, expect, it, vi } from 'vitest';
import { handleConversionHttp, type ConversionHttpDeps, type ConversionHttpInput } from './conversionHttp';
import type { ConversionResult } from './conversion';

const OK: ConversionResult = { ok: true, replay: false, message: 'Brouillon enregistré.', status: 'file_building', validationState: 'none', saleNumber: null };

const deps = (over: Partial<ConversionHttpDeps> = {}): ConversionHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'telepro' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => JSON.stringify({ leadId: 'L1', requestId: 'req-12345678', input: { kind: 'create_sale' }, ...over });
const req = (over: Partial<ConversionHttpInput> = {}): ConversionHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleConversionHttp', () => {
  it('200 : transmet l\'identité du jeton (jamais celle du corps), le rôle et la saisie', async () => {
    const d = deps();
    const r = await handleConversionHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(OK);
    expect(d.run).toHaveBeenCalledWith({ uid: 'u1', role: 'telepro', leadId: 'L1', requestId: 'req-12345678', input: { kind: 'create_sale' } });
  });

  it('405 si ce n\'est pas un POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleConversionHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });

  it('401 sans jeton, mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) {
      expect((await handleConversionHttp(req({ authorization }), d)).status).toBe(401);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('400 : corps illisible, identifiants invalides, action inconnue', async () => {
    const d = deps();
    for (const rawBody of [undefined, '', 'pas du json', '[]', 'null', body({ leadId: '../x' }), body({ leadId: 5 }), body({ requestId: 'court' }), body({ input: null }), body({ input: {} }), body({ input: { kind: 'explode' } }), body({ input: { kind: 'constructor' } })]) {
      expect((await handleConversionHttp(req({ rawBody }), d)).status).toBe(400);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('suivi de vente : action imbriquée valide transmise, inconnue ou mal formée refusée (400)', async () => {
    const d = deps();
    const ok = await handleConversionHttp(req({ rawBody: body({ input: { kind: 'sale_action', action: { kind: 'signed' } } }) }), d);
    expect(ok.status).toBe(200);
    expect(d.run).toHaveBeenCalledWith(expect.objectContaining({ input: { kind: 'sale_action', action: { kind: 'signed' } } }));
    const d2 = deps();
    for (const action of [undefined, null, 'signed', [], {}, { kind: 'explode' }, { kind: 5 }, { kind: 'constructor' }]) {
      expect((await handleConversionHttp(req({ rawBody: body({ input: { kind: 'sale_action', action } }) }), d2)).status).toBe(400);
    }
    expect(d2.run).not.toHaveBeenCalled();
  });

  it('403 sans accès au CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleConversionHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('codes de refus métier : 403, 404, 409, 422', async () => {
    const cases: [Extract<ConversionResult, { ok: false }>['code'], number][] = [['forbidden', 403], ['not_found', 404], ['lead_closed', 409], ['unavailable', 409], ['invalid', 422]];
    for (const [code, status] of cases) {
      const r = await handleConversionHttp(req(), deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'non' })) }));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, error: code, message: 'non' });
    }
  });

  it('500 sans fuite du détail', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('secret interne'); }) });
    const r = await handleConversionHttp(req(), d);
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect(d.log.error).toHaveBeenCalled();
  });
});
