import { describe, expect, it, vi } from 'vitest';
import { handleQualifyHttp, type QualifyHttpDeps, type QualifyHttpInput } from './qualifyHttp';
import type { QualifyResult } from './qualify';

const OK: QualifyResult = { ok: true, replay: false, summary: 'NR1 enregistré.', status: 'nr', nextActionAtMs: 1 };

const deps = (over: Partial<QualifyHttpDeps> = {}): QualifyHttpDeps => ({
  verifyToken: vi.fn(async (t: string) => (t === 'good' ? 'u1' : Promise.reject(new Error('bad')))),
  resolveRole: vi.fn(async () => 'telepro' as const),
  run: vi.fn(async () => OK),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ leadId: 'L1', requestId: 'req-12345678', input: { kind: 'no_answer' }, expectedStatus: 'new', durationSeconds: 42, ...over });

const req = (over: Partial<QualifyHttpInput> = {}): QualifyHttpInput => ({ method: 'POST', authorization: 'Bearer good', rawBody: body(), ...over });

describe('handleQualifyHttp', () => {
  it('200 : transmet l’identité vérifiée (jamais celle du corps), le rôle et la saisie', async () => {
    const d = deps();
    const r = await handleQualifyHttp(req({ rawBody: body({ uid: 'pirate', role: 'admin' }) }), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(OK);
    expect(d.run).toHaveBeenCalledWith({
      uid: 'u1',
      role: 'telepro',
      leadId: 'L1',
      requestId: 'req-12345678',
      expectedStatus: 'new',
      input: { kind: 'no_answer' },
      durationSeconds: 42,
    });
  });

  it('405 si ce n’est pas un POST, sans rien vérifier', async () => {
    const d = deps();
    expect((await handleQualifyHttp(req({ method: 'GET' }), d)).status).toBe(405);
    expect(d.verifyToken).not.toHaveBeenCalled();
  });

  it('401 sans jeton, avec un jeton mal formé ou refusé', async () => {
    const d = deps();
    for (const authorization of [undefined, '', 'good', 'Basic good', 'Bearer', 'Bearer bad']) {
      expect((await handleQualifyHttp(req({ authorization }), d)).status).toBe(401);
    }
    expect(d.run).not.toHaveBeenCalled();
  });

  it('403 si le compte n’a aucun rôle CRM Leads', async () => {
    const d = deps({ resolveRole: vi.fn(async () => null) });
    expect((await handleQualifyHttp(req(), d)).status).toBe(403);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('400 : corps illisible ou de mauvaise forme', async () => {
    const d = deps();
    const bad = ['{"leadId":', 'null', '[]', '"x"', body({ leadId: '' }), body({ leadId: 'a/b' }), body({ requestId: 'court' }), body({ requestId: 'a b c d e f g h' }), body({ input: null }), body({ input: [] }), body({ input: { kind: 3 } }), body({ expectedStatus: 5 })];
    for (const rawBody of bad) expect((await handleQualifyHttp(req({ rawBody }), d)).status).toBe(400);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('corps vide : 400', async () => {
    expect((await handleQualifyHttp(req({ rawBody: undefined }), deps())).status).toBe(400);
  });

  it('une durée absurde est ignorée ou bornée', async () => {
    const d = deps();
    await handleQualifyHttp(req({ rawBody: body({ durationSeconds: -5 }) }), d);
    await handleQualifyHttp(req({ rawBody: body({ durationSeconds: 999999 }) }), d);
    await handleQualifyHttp(req({ rawBody: body({ durationSeconds: 'long' }) }), d);
    const calls = (d.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].durationSeconds);
    expect(calls).toEqual([null, 6 * 3600, null]);
  });

  it('expectedStatus absent : accepté (null)', async () => {
    const d = deps();
    await handleQualifyHttp(req({ rawBody: JSON.stringify({ leadId: 'L1', requestId: 'req-12345678', input: { kind: 'no_answer' } }) }), d);
    expect((d.run as ReturnType<typeof vi.fn>).mock.calls[0][0].expectedStatus).toBeNull();
  });

  it.each([
    ['invalid', 422],
    ['forbidden', 403],
    ['not_found', 404],
    ['lead_closed', 409],
    ['unavailable', 409],
    ['stale', 409],
  ] as const)('refus métier « %s » → %i, avec message et champs en cause', async (code, status) => {
    const d = deps({ run: vi.fn(async () => ({ ok: false as const, code, message: 'Pourquoi', errors: { comment: 'requis' } })) });
    const r = await handleQualifyHttp(req(), d);
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ ok: false, error: code, message: 'Pourquoi', errors: { comment: 'requis' } });
  });

  it('500 sans détail technique si l’écriture échoue, et l’erreur est journalisée', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('boom secret interne'); }) });
    const r = await handleQualifyHttp(req(), d);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('boom');
    expect(d.log.error).toHaveBeenCalled();
  });

  it('500 si la lecture du rôle échoue', async () => {
    const d = deps({ resolveRole: vi.fn(async () => { throw new Error('firestore down'); }) });
    expect((await handleQualifyHttp(req(), d)).status).toBe(500);
  });

  it('un rejeu renvoie 200 avec replay=true', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...OK, replay: true })) });
    const r = await handleQualifyHttp(req(), d);
    expect(r.status).toBe(200);
    expect((r.body as { replay: boolean }).replay).toBe(true);
  });
});
