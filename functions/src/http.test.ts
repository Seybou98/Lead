import { describe, expect, it, vi } from 'vitest';
import { handleIngestHttp, parseIngestBody, resolveSourceId, safeEqual, type IngestHttpDeps, type IngestHttpInput } from './http';
import { parseServiceAccount } from './serviceAccount';
import type { IngestResult } from './ingest';

const SECRET = 'un-secret-long-et-aleatoire';

const created: IngestResult = { ok: true, kind: 'created', leadId: 'L1', rawLeadId: 'R1', assignmentState: 'assigned', ownerId: 'sarah', bufferReason: null };

const deps = (over: Partial<IngestHttpDeps> = {}): IngestHttpDeps & { run: ReturnType<typeof vi.fn> } => ({
  expectedSecret: SECRET,
  run: vi.fn(async () => created),
  log: { warn: vi.fn(), error: vi.fn() },
  ...over,
}) as IngestHttpDeps & { run: ReturnType<typeof vi.fn> };

const req = (over: Partial<IngestHttpInput> = {}): IngestHttpInput => ({
  method: 'POST',
  secret: SECRET,
  sourceId: 'meta',
  contentType: 'application/json',
  rawBody: JSON.stringify({ phone: '0612345678' }),
  ...over,
});

describe('safeEqual', () => {
  it('égalité stricte, quelle que soit la longueur', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('parseIngestBody', () => {
  it('JSON', () => expect(parseIngestBody('application/json', '{"phone":"06"}')).toEqual({ ok: true, payload: { phone: '06' } }));
  it('JSON avec charset', () => expect(parseIngestBody('application/json; charset=utf-8', '{"a":1}')).toEqual({ ok: true, payload: { a: 1 } }));
  it('formulaire', () => expect(parseIngestBody('application/x-www-form-urlencoded', 'phone=0612345678&Pr%C3%A9nom=Jean')).toEqual({ ok: true, payload: { phone: '0612345678', Prénom: 'Jean' } }));
  it('formulaire à clés imbriquées (data[email]) comme l\'ancien webhook', () => {
    expect(parseIngestBody('application/x-www-form-urlencoded', 'data[email]=a%40b.fr&data[phone]=06')).toEqual({ ok: true, payload: { data: { email: 'a@b.fr', phone: '06' } } });
  });
  it('corps vide : objet vide (le lead sera refusé faute de contact, avec un message clair)', () => {
    expect(parseIngestBody('application/json', '')).toEqual({ ok: true, payload: {} });
    expect(parseIngestBody(undefined, undefined)).toEqual({ ok: true, payload: {} });
    expect(parseIngestBody('application/json', '   ')).toEqual({ ok: true, payload: {} });
  });
  it('JSON mal formé : REFUSÉ, jamais pris pour un lead vide', () => {
    expect(parseIngestBody('application/json', '{"phone": ')).toEqual({ ok: false });
  });
  it('type de contenu absent : JSON d\'abord, sinon formulaire', () => {
    expect(parseIngestBody(undefined, '{"a":1}')).toEqual({ ok: true, payload: { a: 1 } });
    expect(parseIngestBody('text/plain', 'a=1&b=2')).toEqual({ ok: true, payload: { a: '1', b: '2' } });
  });
});

describe('resolveSourceId', () => {
  it('paramètre d\'URL prioritaire, sinon en-tête, nettoyé ; vide = null', () => {
    expect(resolveSourceId(' meta ', 'google')).toBe('meta');
    expect(resolveSourceId(undefined, 'google')).toBe('google');
    expect(resolveSourceId(undefined, undefined)).toBeNull();
    expect(resolveSourceId('  ', undefined)).toBeNull();
    expect(resolveSourceId(['a', 'b'], undefined)).toBe('a,b'); // ?source=a&source=b : valeur inconnue, refusée plus loin
  });
});

describe('handleIngestHttp', () => {
  it('lead valide : 200 et le lead est transmis au moteur avec sa source', async () => {
    const d = deps();
    const r = await handleIngestHttp(req(), d);
    expect(r).toEqual({ status: 200, body: created });
    expect(d.run).toHaveBeenCalledWith({ sourceId: 'meta', payload: { phone: '0612345678' } });
  });

  describe('sécurité : rien n\'atteint le moteur sans le bon secret', () => {
    it.each([['absent', undefined], ['vide', ''], ['mauvais', 'autre-secret'], ['préfixe du bon', SECRET.slice(0, 5)], ['bon + suffixe', SECRET + 'x']])('secret %s : 401', async (_n, secret) => {
      const d = deps();
      const r = await handleIngestHttp(req({ secret }), d);
      expect(r.status).toBe(401);
      expect(d.run).not.toHaveBeenCalled();
    });
    it('fonction mal configurée (secret attendu vide) : 500, même avec un secret fourni vide — jamais d\'accès ouvert', async () => {
      const d = deps({ expectedSecret: '' });
      expect((await handleIngestHttp(req({ secret: '' }), d)).status).toBe(500);
      expect((await handleIngestHttp(req({ secret: 'n-importe-quoi' }), d)).status).toBe(500);
      expect(d.run).not.toHaveBeenCalled();
      expect(d.log.error).toHaveBeenCalled();
    });
    it('le secret n\'apparaît jamais dans la réponse ni dans les journaux', async () => {
      const d = deps();
      const r = await handleIngestHttp(req({ secret: 'mauvais' }), d);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify((d.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(SECRET);
    });
  });

  it.each(['GET', 'PUT', 'DELETE', 'OPTIONS', 'get'])('méthode %s : 405', async (method) => {
    const d = deps();
    expect((await handleIngestHttp(req({ method }), d)).status).toBe(405);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('la méthode est vérifiée avant le secret : un GET sans secret ne révèle rien de plus', async () => {
    expect((await handleIngestHttp(req({ method: 'GET', secret: undefined }), deps())).status).toBe(405);
  });

  it('corps illisible : 400, le moteur n\'est pas appelé', async () => {
    const d = deps();
    const r = await handleIngestHttp(req({ rawBody: '{"phone":' }), d);
    expect(r).toEqual({ status: 400, body: { ok: false, error: 'invalid_body' } });
    expect(d.run).not.toHaveBeenCalled();
  });

  it('corps déjà lu par l\'hébergeur (Firebase) : utilisé tel quel, prioritaire sur le corps brut', async () => {
    const d = deps();
    await handleIngestHttp(req({ parsedBody: { email: 'a@b.fr' }, rawBody: 'ignoré' }), d);
    expect(d.run).toHaveBeenCalledWith({ sourceId: 'meta', payload: { email: 'a@b.fr' } });
  });

  describe('codes de retour du moteur', () => {
    const rejected = (code: 'no_contact' | 'unknown_source' | 'source_disabled'): IngestResult => ({ ok: false, kind: 'rejected', code, reason: 'x', rawLeadId: 'R' });
    it.each([['unknown_source', 400], ['source_disabled', 403], ['no_contact', 422]] as const)('%s → %i', async (code, status) => {
      const r = await handleIngestHttp(req(), deps({ run: vi.fn(async () => rejected(code)) }));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, code });
    });
    it('lead rattaché ou déjà reçu : 200 (la source ne doit pas réessayer)', async () => {
      for (const result of [{ ok: true, kind: 'attached', leadId: 'L', rawLeadId: 'R', outcome: 'attached_to_open_lead' }, { ok: true, kind: 'replay', leadId: 'L', rawLeadId: 'R' }] as IngestResult[]) {
        expect((await handleIngestHttp(req(), deps({ run: vi.fn(async () => result) }))).status).toBe(200);
      }
    });
    it('erreur interne : 500 sans détail technique, et l\'erreur est journalisée', async () => {
      const d = deps({ run: vi.fn(async () => { throw new Error('Firestore down: secret-detail'); }) });
      const r = await handleIngestHttp(req(), d);
      expect(r).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
      expect(JSON.stringify(r)).not.toContain('secret-detail');
      expect(d.log.error).toHaveBeenCalled();
    });
  });
});

describe('parseServiceAccount', () => {
  const svc = { project_id: 'crm-pose-dev', client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

  it('base64 (recommandé)', () => {
    expect(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: b64(svc) })).toMatchObject({ project_id: 'crm-pose-dev' });
  });
  it('JSON brut', () => {
    expect(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(svc) }).client_email).toBe(svc.client_email);
  });
  it('base64 collé par erreur dans la variable JSON : accepté', () => {
    expect(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: b64(svc) }).project_id).toBe('crm-pose-dev');
  });
  it('la clé privée avec des « \\n » littéraux est restaurée (cas fréquent des variables d\'environnement)', () => {
    const flat = { ...svc, private_key: '-----BEGIN KEY-----\\nabc\\n-----END KEY-----\\n' };
    expect(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: b64(flat) }).private_key).toBe(svc.private_key);
  });
  it('le base64 est prioritaire sur le JSON brut', () => {
    const r = parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: b64(svc), FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...svc, project_id: 'autre' }) });
    expect(r.project_id).toBe('crm-pose-dev');
  });
  it('variables absentes : message qui dit quoi définir', () => {
    expect(() => parseServiceAccount({})).toThrow(/FIREBASE_SERVICE_ACCOUNT_JSON_BASE64/);
    expect(() => parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: '  ' })).toThrow(/manquante/);
  });
  it('compte incomplet ou illisible : refusé, et le message ne contient jamais la clé', () => {
    for (const env of [{ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: b64({ client_email: 'x' }) }, { FIREBASE_SERVICE_ACCOUNT_JSON: '{pas du json' }, { FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: 'pas-du-base64!!' }]) {
      try {
        parseServiceAccount(env);
        throw new Error('un refus était attendu');
      } catch (e) {
        expect((e as Error).message).not.toContain('BEGIN KEY');
        expect((e as Error).message).toMatch(/project_id|illisible|client_email/);
      }
    }
  });
});
