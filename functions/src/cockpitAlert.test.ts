import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { delete: () => ({ __del: true }) } }));

import { applyAlertAction, type AlertArgs } from './cockpitAlert';
import { handleAlertHttp, type AlertHttpDeps } from './cockpitAlertHttp';
import { isAlertHidden, parseAlertStates } from '../../src/domain/cockpit/alertStates';

type Doc = Record<string, unknown>;
// Base en mémoire : on vérifie ce que applyAlertAction ÉCRIT (champ du lead, audit, idempotence), pas le moteur Firestore.
class FakeDb {
  data = new Map<string, Doc>();
  private n = 0;
  collection(name: string) {
    return { doc: (id?: string) => this.ref(`${name}/${id ?? `auto${++this.n}`}`) };
  }
  ref(path: string) {
    return { path, id: path.split('/').pop()!, get: async () => this.snap(path) };
  }
  snap(path: string) {
    const d = this.data.get(path);
    return { exists: d !== undefined, data: () => d, get: (k: string) => d?.[k] };
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    let wrote = false;
    const tx = {
      get: async (r: { path: string }) => {
        if (wrote) throw new Error('lecture après écriture');
        return this.snap(r.path);
      },
      update: (r: { path: string }, patch: Doc) => {
        wrote = true;
        const cur = this.data.get(r.path);
        if (!cur) throw new Error('update inexistant');
        for (const [k, v] of Object.entries(patch)) {
          const parts = k.split('.');
          let o = cur;
          for (const p of parts.slice(0, -1)) o = (o[p] = { ...((o[p] as Doc) ?? {}) }) as Doc;
          if (v && typeof v === 'object' && '__del' in (v as object)) delete o[parts[parts.length - 1]];
          else o[parts[parts.length - 1]] = v;
        }
      },
      set: (r: { path: string }, d: Doc) => {
        wrote = true;
        this.data.set(r.path, { ...d });
      },
    };
    return fn(tx);
  }
}

const NOW = Date.UTC(2026, 9, 22, 10, 0);
const seed = (extra: Doc = {}) => {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', { fullName: 'Jean', managerIds: ['m1'], ...extra });
  return db;
};
let n = 0;
const args = (over: Partial<AlertArgs> = {}): AlertArgs => ({ uid: 'm1', role: 'manager', leadId: 'L1', alertKey: 'callback', sinceMs: NOW - 600_000, action: { kind: 'close', reasonCode: 'handled_elsewhere', comment: '' }, requestId: `req-${String(++n).padStart(6, '0')}`, nowMs: NOW, ...over });
const alerts = (db: FakeDb) => (db.data.get('cl_leads/L1') as { cockpitAlerts?: Record<string, unknown> }).cockpitAlerts;

describe('clôture d’une alerte', () => {
  it('motif obligatoire, écrit sur le lead avec auteur, date et situation concernée ; audit tracé', async () => {
    const db = seed();
    const a = args();
    expect(await applyAlertAction(db as never, a)).toMatchObject({ ok: true, replay: false, message: 'Alerte clôturée : Traité hors du CRM.' });
    expect(alerts(db)).toMatchObject({ callback: { closed: { code: 'handled_elsewhere', label: 'Traité hors du CRM', byId: 'm1', atMs: NOW, sinceMs: a.sinceMs }, postponed: null } });
    const audit = [...db.data.entries()].find(([k]) => k.startsWith('cl_audit/'))?.[1];
    expect(audit).toMatchObject({ action: 'cockpit.alert_close', actorId: 'm1', entityId: 'L1', after: { alert: 'callback', reasonCode: 'handled_elsewhere' } });
  });
  it('motif inconnu ou archivé : refusé, rien n’est écrit', async () => {
    const db = seed();
    expect(await applyAlertAction(db as never, args({ action: { kind: 'close', reasonCode: 'nope', comment: '' } }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(alerts(db)).toBeUndefined();
  });
  it('« Autre » exige un commentaire', async () => {
    const db = seed();
    expect(await applyAlertAction(db as never, args({ action: { kind: 'close', reasonCode: 'other', comment: ' ' } }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await applyAlertAction(db as never, args({ action: { kind: 'close', reasonCode: 'other', comment: 'Client injoignable ce jour' } }))).toMatchObject({ ok: true });
  });
});

describe('report d’une alerte', () => {
  it('rappel, documents, vente : reportable ; la date de retour est calculée par le serveur', async () => {
    const db = seed();
    expect(await applyAlertAction(db as never, args({ action: { kind: 'postpone', choice: '2h', comment: '' } }))).toMatchObject({ ok: true, message: 'Alerte reportée de 2 heures.' });
    expect(alerts(db)).toMatchObject({ callback: { closed: null, postponed: { untilMs: NOW + 2 * 3_600_000, byId: 'm1' } } });
  });
  it('lead en danger (SLA) : jamais reportable', async () => {
    const db = seed();
    expect(await applyAlertAction(db as never, args({ alertKey: 'sla', action: { kind: 'postpone', choice: '30m', comment: '' } }))).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('rétablir une alerte efface la décision', async () => {
    const db = seed();
    await applyAlertAction(db as never, args());
    await applyAlertAction(db as never, args({ action: { kind: 'reopen' } }));
    expect(alerts(db)).toEqual({});
  });
});

describe('droits et idempotence', () => {
  it('manager hors périmètre, télépro : refusés ; administrateur : tout lead', async () => {
    const db = seed();
    expect(await applyAlertAction(db as never, args({ uid: 'm2' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await applyAlertAction(db as never, args({ role: 'telepro' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await applyAlertAction(db as never, args({ uid: 'adm', role: 'admin' }))).toMatchObject({ ok: true });
  });
  it('lead introuvable', async () => {
    expect(await applyAlertAction(new FakeDb() as never, args())).toMatchObject({ ok: false, code: 'not_found' });
  });
  it('même demande rejouée : aucune seconde écriture ; demande d’un autre utilisateur : refusée', async () => {
    const db = seed();
    const a = args();
    await applyAlertAction(db as never, a);
    expect(await applyAlertAction(db as never, a)).toMatchObject({ ok: true, replay: true });
    expect([...db.data.keys()].filter((k) => k.startsWith('cl_audit/'))).toHaveLength(1);
    expect(await applyAlertAction(db as never, { ...a, uid: 'adm', role: 'admin' })).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('alerte inconnue : refusée', async () => {
    expect(await applyAlertAction(seed() as never, args({ alertKey: 'zzz' as never }))).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('état d’une alerte côté écran', () => {
  const closed = (sinceMs: number, atMs: number) => parseAlertStates({ callback: { closed: { sinceMs, code: 'x', label: 'x', comment: '', byId: 'm1', atMs }, postponed: null } });
  it('clôturée : cachée pour la situation décidée, visible pour une situation plus récente', () => {
    const s = closed(1_000, 5_000).callback;
    expect(isAlertHidden(s, 1_000, 9_000)).toBe(true);
    expect(isAlertHidden(s, 4_000, 9_000)).toBe(true);
    expect(isAlertHidden(s, 6_000, 9_000)).toBe(false);
  });
  it('reportée : cachée jusqu’à l’échéance, puis l’alerte revient seule', () => {
    const s = parseAlertStates({ docs: { closed: null, postponed: { sinceMs: 1_000, untilMs: 8_000, comment: '', byId: 'm1', atMs: 2_000 } } }).docs;
    expect(isAlertHidden(s, 1_000, 5_000)).toBe(true);
    expect(isAlertHidden(s, 1_000, 8_000)).toBe(false);
  });
  it('sans décision, ou champ mal formé : visible', () => {
    expect(isAlertHidden(undefined, 1, 2)).toBe(false);
    expect(parseAlertStates({ callback: { closed: { code: 3 } }, junk: 1 })).toEqual({});
    expect(parseAlertStates(null)).toEqual({});
  });
});

describe('couche HTTP', () => {
  const body = { leadId: 'L1', alertKey: 'callback', sinceMs: 1, requestId: 'req-000001', action: 'close', reasonCode: 'handled_elsewhere', comment: '' };
  const deps = (over: Partial<AlertHttpDeps> = {}): AlertHttpDeps => ({ verifyToken: async () => 'm1', resolveRole: async () => 'manager', run: vi.fn(async () => ({ ok: true as const, replay: false, message: 'ok' })), log: { warn: () => undefined, error: () => undefined }, ...over });
  const call = (b: unknown, d: AlertHttpDeps, over: Partial<{ method: string; authorization: string }> = {}) => handleAlertHttp({ method: 'POST', authorization: 'Bearer tok', rawBody: JSON.stringify(b), ...over }, d);

  it('200 ; l’identité vient du jeton, pas du corps', async () => {
    const d = deps();
    expect((await call({ ...body, uid: 'pirate', role: 'admin' }, d)).status).toBe(200);
    expect(d.run).toHaveBeenCalledWith(expect.objectContaining({ uid: 'm1', role: 'manager', leadId: 'L1', alertKey: 'callback' }));
    expect(JSON.stringify((d.run as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('pirate');
  });
  it('401 sans jeton ou jeton refusé ; 405 ; 403 sans accès', async () => {
    expect((await call(body, deps(), { authorization: '' })).status).toBe(401);
    expect((await call(body, deps({ verifyToken: async () => { throw new Error('x'); } }))).status).toBe(401);
    expect((await call(body, deps(), { method: 'GET' })).status).toBe(405);
    expect((await call(body, deps({ resolveRole: async () => null }))).status).toBe(403);
  });
  it('400 : corps illisible, alerte inconnue, report sans durée, motif absent', async () => {
    expect((await handleAlertHttp({ method: 'POST', authorization: 'Bearer t', rawBody: '{' }, deps())).status).toBe(400);
    expect((await call({ ...body, alertKey: 'x' }, deps())).status).toBe(400);
    expect((await call({ ...body, action: 'postpone', choice: '9y' }, deps())).status).toBe(400);
    expect((await call({ ...body, reasonCode: undefined }, deps())).status).toBe(400);
  });
  it('codes métier : 404, 403, 422 ; 500 sans fuite', async () => {
    for (const [code, status] of [['not_found', 404], ['forbidden', 403], ['invalid', 422]] as const) {
      expect((await call(body, deps({ run: async () => ({ ok: false, code, message: 'm' }) }))).status).toBe(status);
    }
    const out = await call(body, deps({ run: async () => { throw new Error('secret interne'); } }));
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('secret');
  });
});
