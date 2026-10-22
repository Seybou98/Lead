import { describe, expect, it, vi } from 'vitest';
import { zonedToMs, type ExportRun, type ScheduledExport } from '../../src/domain/reports/schedule';
import { listRuns, readDownload, resendRun, runDueExports, runNow, type ExportStorage, type RunnerDeps } from './exportRunner';
import type { MailSender } from './mailer';

// ── Base en mémoire (juste ce que le moteur utilise) ─────────────────────────
type Doc = Record<string, unknown>;
const pathGet = (d: Doc, p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Doc)[k] : undefined), d);
type Filter = { field: string; op: string; value: number };

class FakeDb {
  data = new Map<string, Doc>();
  seed(col: string, id: string, d: Doc) { this.data.set(`${col}/${id}`, d); }
  private snap(col: string, id: string) {
    const key = `${col}/${id}`;
    const d = this.data.get(key);
    return {
      id,
      exists: d !== undefined,
      data: () => (d ? d : undefined),
      get: (f: string) => (d ? pathGet(d, f) : undefined),
      ref: { set: async (v: Doc) => { this.data.set(key, structuredClone(v)); } },
    };
  }
  collection(col: string) {
    const rows = () => [...this.data.keys()].filter((k) => k.startsWith(`${col}/`)).map((k) => k.slice(col.length + 1));
    const query = (filters: Filter[], order: { field: string; dir: 'asc' | 'desc' } | null, lim: number | null) => ({
      where: (field: string, op: string, value: number) => query([...filters, { field, op, value }], order, lim),
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => query(filters, { field, dir }, lim),
      limit: (n: number) => query(filters, order, n),
      get: async () => {
        let ids = rows().filter((id) => filters.every((f) => { const v = pathGet(this.data.get(`${col}/${id}`)!, f.field) as number; return v !== undefined && (f.op === '>' ? v > f.value : f.op === '<=' ? v <= f.value : false); }));
        if (order) ids = ids.sort((a, b) => { const x = pathGet(this.data.get(`${col}/${a}`)!, order.field) as number; const y = pathGet(this.data.get(`${col}/${b}`)!, order.field) as number; return order.dir === 'desc' ? y - x : x - y; });
        if (lim !== null) ids = ids.slice(0, lim);
        const docs = ids.map((id) => this.snap(col, id));
        return { docs, size: docs.length };
      },
    });
    return {
      ...query([], null, null),
      doc: (id: string) => ({
        get: async () => this.snap(col, id),
        set: async (v: Doc) => { this.data.set(`${col}/${id}`, structuredClone(v)); },
        create: async (v: Doc) => {
          if (this.data.has(`${col}/${id}`)) throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
          this.data.set(`${col}/${id}`, structuredClone(v));
        },
      }),
    };
  }
}

const ts = (n: number) => ({ toMillis: () => n });
const paris = (y: number, m: number, d: number, h = 0, mi = 0) => zonedToMs(y, m, d, h, mi);
const MONDAY = paris(2026, 10, 26, 8, 2); // lundi 26 octobre 2026, 08:02
const SITE = 'https://crm.example.test';

function memStorage(): ExportStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, put: async (p, c) => { files.set(p, c); }, get: async (p) => files.get(p) ?? null, remove: async (p) => { files.delete(p); } };
}

const schedule = (over: Partial<ScheduledExport> = {}): ScheduledExport => ({
  id: 's_1', name: 'Leads de la semaine', kind: 'leads', format: 'csv', frequency: 'weekly', weekday: 1, dayOfMonth: 1, time: '08:00', period: 'previous_week', mode: 'event', sourceId: '', product: '', corrected: true, detail: true,
  recipients: ['adm', 'm1'], active: true, endDate: '', createdAtMs: paris(2026, 10, 1), ...over,
});

function world(over: Partial<ScheduledExport> = {}) {
  const db = new FakeDb();
  db.seed('cl_settings', 'exports', { schedules: [schedule(over)] });
  db.seed('users', 'adm', { status: 'active', role: 'admin', name: 'Admin', email: 'adm@x.fr' });
  db.seed('users', 'm1', { status: 'active', role: 'manager', name: 'Manager Un', email: 'm1@x.fr' });
  db.seed('users', 'm2', { status: 'active', role: 'manager', name: 'Manager Deux', email: 'm2@x.fr' });
  db.seed('users', 't1', { status: 'active', role: 'telepro', name: 'Télépro', email: 't1@x.fr' });
  db.seed('cl_campaigns', 'c1', { name: 'Campagne PAC', sourceId: 'src1', productCode: 'PAC', status: 'active' });
  db.seed('cl_sources', 'src1', { name: 'Meta' });
  const lead = (fullName: string, phone: string, managerIds: string[], day: number) => ({ fullName, phone, email: `${fullName.split(' ')[0].toLowerCase()}@mail.fr`, status: 'new', productCode: 'PAC', managerIds, origin: { campaignId: 'c1', receivedAt: ts(paris(2026, 10, day, 10)) } });
  db.seed('cl_leads', 'L1', lead('Jean Dupont', '0612345678', ['m1'], 14));
  db.seed('cl_leads', 'L2', lead('Awa Diallo', '0698765432', ['m2'], 15));
  db.seed('cl_leads', 'L3', lead('Paul Martin', '0611223344', ['m1'], 1)); // hors période
  return db;
}

function deps(over: Partial<RunnerDeps> = {}) {
  const storage = memStorage();
  const send = vi.fn<MailSender>(async () => ({ ok: true }));
  const d: RunnerDeps = { storage, send, missingVars: [], siteUrl: SITE, log: { warn: () => undefined, error: () => undefined }, ...over };
  return { d, storage, send };
}

const runsOf = (db: FakeDb): ExportRun[] => [...db.data.entries()].filter(([k]) => k.startsWith('cl_exportRuns/')).map(([, v]) => v as unknown as ExportRun);

describe('exports programmés : génération', () => {
  it('une échéance due produit un fichier par périmètre, stocké puis envoyé par lien', async () => {
    const db = world();
    const { d, storage, send } = deps();
    const report = await runDueExports(db as never, MONDAY, d);
    expect(report).toMatchObject({ generated: 1, skipped: 0, failed: 0 });
    const [run] = runsOf(db);
    expect(run).toMatchObject({ id: 's_1_202610260800', status: 'ready', trigger: 'schedule', kind: 'leads' });
    expect(run.fromMs).toBe(paris(2026, 10, 19));
    expect(run.toMs).toBe(paris(2026, 10, 26));
    expect(run.files.map((f) => f.scope).sort()).toEqual(['all', 'm1']);
    expect(storage.files.size).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(run.files.every((f) => f.recipients.every((r) => r.status === 'sent'))).toBe(true);
  });
  it('période = semaine précédente : seuls les leads du 19 au 25 octobre sont dans le fichier', async () => {
    const db = world();
    const { d, storage } = deps();
    // On avance l'échéance au lundi 19 : la période est alors du 12 au 18 octobre (L1 et L2).
    await runDueExports(db as never, paris(2026, 10, 19, 8, 2), d);
    const all = [...storage.files.entries()].find(([p]) => p.includes('/all-'))![1];
    expect(all).toContain('Lead-');
    expect(all.split('\r\n').filter((l) => l.startsWith('Lead-'))).toHaveLength(2);
  });
  it('anonymisé : ni nom, ni téléphone, ni email dans aucun fichier', async () => {
    const db = world();
    const { d, storage } = deps();
    await runDueExports(db as never, paris(2026, 10, 19, 8, 2), d);
    for (const c of storage.files.values()) {
      expect(c).not.toMatch(/Dupont|Diallo|0612345678|0698765432|@mail\.fr/);
    }
  });
  it('un manager ne reçoit que les leads de son périmètre ; l’administrateur reçoit tout', async () => {
    const db = world();
    const { d, storage } = deps();
    await runDueExports(db as never, paris(2026, 10, 19, 8, 2), d);
    const m1 = [...storage.files.entries()].find(([p]) => p.includes('/m1-'))![1];
    const all = [...storage.files.entries()].find(([p]) => p.includes('/all-'))![1];
    expect(m1.split('\r\n').filter((l) => l.startsWith('Lead-'))).toHaveLength(1);
    expect(all.split('\r\n').filter((l) => l.startsWith('Lead-'))).toHaveLength(2);
  });
  it('le message contient le lien vers le CRM, pas le fichier', async () => {
    const db = world();
    const { d, send } = deps();
    await runDueExports(db as never, MONDAY, d);
    const params = send.mock.calls.map((c) => c[0]);
    const admin = params.find((p) => p.to_email === 'adm@x.fr')!;
    expect(admin.link).toMatch(/^https:\/\/crm\.example\.test\/rapports\/export\/s_1_202610260800\?f=(all|m1)$/);
    expect(JSON.stringify(admin)).not.toContain('Lead-');
  });
  it('rejouer le planificateur ne refait rien : une exécution par échéance', async () => {
    const db = world();
    const { d, send } = deps();
    await runDueExports(db as never, MONDAY, d);
    const again = await runDueExports(db as never, MONDAY + 5 * 60_000, d);
    expect(again).toMatchObject({ generated: 0, skipped: 1 });
    expect(runsOf(db)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rien n’est dû avant l’heure, ni pour un rapport suspendu', async () => {
    const db = world();
    expect(await runDueExports(db as never, paris(2026, 10, 26, 7, 59), deps().d)).toMatchObject({ generated: 0, skipped: 0 });
    const db2 = world({ active: false });
    expect(await runDueExports(db2 as never, MONDAY, deps().d)).toMatchObject({ generated: 0 });
  });
  it('destinataire inactif ou sans email : écarté et dit dans l’historique ; aucun destinataire valide : rien généré', async () => {
    const db = world({ recipients: ['adm', 'ghost'] });
    const { d } = deps();
    await runDueExports(db as never, MONDAY, d);
    expect(runsOf(db)[0].notes.join(' ')).toMatch(/ghost/);
    const db2 = world({ recipients: ['t1', 'ghost'] });
    const { d: d2, storage } = deps();
    expect(await runDueExports(db2 as never, MONDAY, d2)).toMatchObject({ generated: 0, failed: 1 });
    expect(runsOf(db2)[0]).toMatchObject({ status: 'error' });
    expect(storage.files.size).toBe(0);
  });
  it('stockage indisponible : l’exécution est en erreur, rien n’est envoyé', async () => {
    const db = world();
    const { d, send } = deps({ storage: null });
    expect(await runDueExports(db as never, MONDAY, d)).toMatchObject({ failed: 1 });
    expect(runsOf(db)[0]).toMatchObject({ status: 'error' });
    expect(send).not.toHaveBeenCalled();
  });
  it('format PDF : page imprimable HTML', async () => {
    const db = world({ format: 'pdf' });
    const { d, storage } = deps();
    await runDueExports(db as never, MONDAY, d);
    const [run] = runsOf(db);
    expect(run.files[0].filename.endsWith('.html')).toBe(true);
    expect([...storage.files.values()][0]).toContain('<!doctype html>');
  });
});

describe('exports programmés : envoi, nouvelles tentatives', () => {
  it('un envoi en échec est retenté après 10 minutes, puis réussit', async () => {
    const db = world({ recipients: ['adm'] });
    const send = vi.fn<MailSender>().mockResolvedValueOnce({ ok: false, error: 'EmailJS 500' }).mockResolvedValue({ ok: true });
    const { d } = deps({ send });
    await runDueExports(db as never, MONDAY, d);
    expect(runsOf(db)[0].files[0].recipients[0]).toMatchObject({ status: 'error', attempts: 1, error: 'EmailJS 500' });
    await runDueExports(db as never, MONDAY + 5 * 60_000, d); // trop tôt
    expect(send).toHaveBeenCalledTimes(1);
    await runDueExports(db as never, MONDAY + 10 * 60_000, d);
    expect(send).toHaveBeenCalledTimes(2);
    expect(runsOf(db)[0].files[0].recipients[0]).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });
  it('trois échecs : échec définitif visible, plus aucune tentative', async () => {
    const db = world({ recipients: ['adm'] });
    const send = vi.fn<MailSender>(async () => ({ ok: false, error: 'EmailJS 403' }));
    const { d } = deps({ send });
    for (let i = 0; i < 6; i++) await runDueExports(db as never, MONDAY + i * 10 * 60_000, d);
    expect(send).toHaveBeenCalledTimes(3);
    expect(runsOf(db)[0].files[0].recipients[0]).toMatchObject({ status: 'error', attempts: 3 });
  });
  it('EmailJS non configuré : erreur explicite avec les variables manquantes', async () => {
    const db = world({ recipients: ['adm'] });
    const { d } = deps({ send: null, missingVars: ['EMAILJS_PRIVATE_KEY'] });
    await runDueExports(db as never, MONDAY, d);
    expect(runsOf(db)[0].files[0].recipients[0].error).toMatch(/EMAILJS_PRIVATE_KEY/);
  });
  it('adresse du CRM inconnue : aucun lien bancal envoyé', async () => {
    const db = world({ recipients: ['adm'] });
    const { d, send } = deps({ siteUrl: '' });
    await runDueExports(db as never, MONDAY, d);
    expect(send).not.toHaveBeenCalled();
    expect(runsOf(db)[0].files[0].recipients[0].error).toMatch(/SITE_URL/);
  });
  it('« Renvoyer » remet les échecs définitifs à zéro et rejoue', async () => {
    const db = world({ recipients: ['adm'] });
    const send = vi.fn<MailSender>(async () => ({ ok: false, error: 'EmailJS 403' }));
    const { d } = deps({ send });
    for (let i = 0; i < 4; i++) await runDueExports(db as never, MONDAY + i * 10 * 60_000, d);
    send.mockResolvedValue({ ok: true });
    const out = await resendRun(db as never, 's_1_202610260800', d, MONDAY + 60 * 60_000);
    expect(out.ok).toBe(true);
    expect(runsOf(db)[0].files[0].recipients[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await resendRun(db as never, 'inconnu', d, MONDAY)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('exports programmés : conservation', () => {
  it('après 30 jours, les fichiers sont supprimés et l’historique reste « expiré »', async () => {
    const db = world({ recipients: ['adm'] });
    const { d, storage } = deps();
    await runDueExports(db as never, MONDAY, d);
    expect(storage.files.size).toBe(1);
    const later = MONDAY + 31 * 86_400_000;
    // Un rapport suspendu ne génère rien, mais la purge a bien lieu.
    db.seed('cl_settings', 'exports', { schedules: [] });
    expect(await runDueExports(db as never, later, d)).toMatchObject({ purged: 1 });
    expect(storage.files.size).toBe(0);
    expect(runsOf(db)[0].status).toBe('expired');
    expect(await runDueExports(db as never, later + 1000, d)).toMatchObject({ purged: 0 });
  });
});

describe('exports programmés : exécution manuelle', () => {
  it('« Exécuter maintenant » : période glissante, auteur tracé, identifiant propre', async () => {
    const db = world({ recipients: ['adm'] });
    const { d } = deps();
    const out = await runNow(db as never, 's_1', 'adm', MONDAY, d);
    expect(out.ok).toBe(true);
    expect(runsOf(db)[0]).toMatchObject({ id: `s_1_m${MONDAY}`, trigger: 'manual', actorId: 'adm', status: 'ready' });
  });
  it('rapport inconnu : introuvable', async () => {
    expect(await runNow(world() as never, 's_9', 'adm', MONDAY, deps().d)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('exports programmés : historique et téléchargement', () => {
  async function ready() {
    const db = world();
    const ctx = deps();
    await runDueExports(db as never, MONDAY, ctx.d);
    const run = runsOf(db)[0];
    return { db, ...ctx, run };
  }
  it('l’administrateur lit tout fichier ; le manager destinataire lit le sien seulement', async () => {
    const { db, d, run } = await ready();
    const get = (uid: string, role: 'admin' | 'manager', scope: string) => readDownload(db as never, { runId: run.id, scope, uid, role }, d);
    expect(await get('adm', 'admin', 'all')).toMatchObject({ ok: true });
    expect(await get('adm', 'admin', 'm1')).toMatchObject({ ok: true });
    expect(await get('m1', 'manager', 'm1')).toMatchObject({ ok: true, mime: expect.stringContaining('text/csv') });
    expect(await get('m1', 'manager', 'all')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await get('m2', 'manager', 'm1')).toMatchObject({ ok: false, code: 'not_found' });
  });
  it('fichier inexistant : introuvable ; exécution expirée : dit supprimé', async () => {
    const { db, d, run } = await ready();
    expect(await readDownload(db as never, { runId: 'x', scope: 'all', uid: 'adm', role: 'admin' }, d)).toMatchObject({ code: 'not_found' });
    expect(await readDownload(db as never, { runId: run.id, scope: 'zz', uid: 'adm', role: 'admin' }, d)).toMatchObject({ code: 'not_found' });
    db.seed('cl_exportRuns', run.id, { ...run, status: 'expired' });
    expect(await readDownload(db as never, { runId: run.id, scope: 'all', uid: 'adm', role: 'admin' }, d)).toMatchObject({ ok: false, code: 'expired' });
  });
  it('historique : l’administrateur voit tout, le manager ses fichiers ; jamais les chemins de stockage', async () => {
    const { db } = await ready();
    const admin = await listRuns(db as never, 'admin', 'adm');
    expect(admin[0].files).toHaveLength(2);
    expect(admin[0].files.every((f) => f.path === '')).toBe(true);
    const m1 = await listRuns(db as never, 'manager', 'm1');
    expect(m1[0].files.map((f) => f.scope)).toEqual(['m1']);
    expect(await listRuns(db as never, 'manager', 'm2')).toEqual([]);
  });
});
