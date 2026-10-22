// Exports programmés (§22.10, fig. 34) — couche Firestore / Storage / email. Les règles (échéances, périodes, forme d'une
// exécution, message) sont dans src/domain/reports/schedule.ts ; le contenu d'un fichier vient de buildExport, le MÊME calcul
// que les écrans de rapport.
//
// Garanties :
//  - une exécution par rapport et par échéance : le document `cl_exportRuns/<rapport>_<échéance>` est créé (create) avant tout,
//    un second appel du planificateur trouve la place prise et ne fait rien ;
//  - les fichiers sont TOUJOURS anonymisés ; un manager ne reçoit que ses leads (managerIds) et aucune dépense ;
//  - le message ne contient qu'un lien : le fichier est lu par une fonction qui vérifie la connexion et les droits ;
//  - un envoi en échec est retenté (3 fois au plus, 10 minutes d'écart), puis l'échec reste visible dans l'historique ;
//  - les fichiers sont supprimés après 30 jours, l'historique reste.

import { type Firestore } from 'firebase-admin/firestore';
import { resolveLeadRole } from '../../src/config/roles';
import { COL } from '../../src/domain/collections';
import { toCsv } from '../../src/domain/csvFormat';
import type { CampaignView } from '../../src/domain/admin/campaignStats';
import type { Role } from '../../src/domain/enums';
import { setSlaRuntime, slaElapsedMs, type LeadListItem } from '../../src/domain/leads/leadList';
import type { ReportCampaign, ReportFilters, ReportSpend } from '../../src/domain/reports/direction';
import { buildExport, DEFAULT_LEAD_COLUMNS, printableHtml, type ExportInput } from '../../src/domain/reports/exports';
import {
  dueOccurrence,
  EMAIL_RETRY_MS,
  emailParams,
  emailsSettled,
  manualRunId,
  MAX_EMAIL_ATTEMPTS,
  parseSchedules,
  RETENTION_DAYS,
  rollingRange,
  runId,
  dateKey,
  type ExportRun,
  type RunFile,
  type RunRecipient,
  type ScheduledExport,
} from '../../src/domain/reports/schedule';
import { parseSlaSettings } from '../../src/domain/settings/settings';
import { scheduleOf } from '../../src/domain/settings/runtime';
import { toListItem } from '../../src/pages/leads/mapLead';
import type { MailSender } from './mailer';

const DAY_MS = 86_400_000;
/** Lecture bornée des leads, comme l'écran des rapports : au-delà, les chiffres seraient incomplets. */
export const LEAD_READ_LIMIT = 5000;
const SETTINGS_ID = 'exports';

export interface ExportStorage {
  put(path: string, content: string, mime: string): Promise<void>;
  get(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

export interface RunnerDeps {
  storage: ExportStorage | null;
  /** null : EmailJS n'est pas configuré (les envois sont alors en erreur, avec la liste des variables manquantes). */
  send: MailSender | null;
  missingVars: string[];
  /** Adresse du CRM, sans barre finale (« https://crm-leads1.netlify.app »). */
  siteUrl: string;
  log?: { warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// ── Données ──────────────────────────────────────────────────────────────────

export interface StaffUser {
  uid: string;
  name: string;
  email: string;
  role: Role;
}

interface ReportData {
  leads: LeadListItem[];
  managersOf: Map<string, string[]>;
  reportCampaigns: ReportCampaign[];
  campaigns: CampaignView[];
  spends: ReportSpend[];
  names: ExportInput['names'];
  slaMs: number;
  truncated: boolean;
}

/** Utilisateurs actifs pouvant recevoir un rapport : administrateurs et managers. */
export async function readStaff(db: Firestore): Promise<StaffUser[]> {
  const snap = await db.collection('users').get();
  const out: StaffUser[] = [];
  for (const d of snap.docs) {
    if (String(d.get('status') ?? '').toLowerCase() !== 'active') continue;
    const role = resolveLeadRole(d.get('role'));
    if (role !== 'admin' && role !== 'manager') continue;
    const email = String(d.get('email') ?? '').trim();
    const name = String(d.get('name') || d.get('displayName') || `${d.get('firstName') ?? ''} ${d.get('lastName') ?? ''}`.trim() || email || d.id);
    out.push({ uid: d.id, name, email, role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

async function readReportData(db: Firestore, staffAll: readonly StaffUser[]): Promise<ReportData> {
  const [leadSnap, campSnap, srcSnap, spendSnap, slaSnap, userSnap] = await Promise.all([
    db.collection(COL.leads).limit(LEAD_READ_LIMIT).get(),
    db.collection(COL.campaigns).get(),
    db.collection(COL.sources).get(),
    db.collection(COL.adSpend).get(),
    db.collection(COL.settings).doc('sla').get(),
    db.collection('users').get(),
  ]);
  const sla = parseSlaSettings(slaSnap.exists ? slaSnap.data() : undefined);
  // Mêmes compteurs que le navigateur : délai du SLA et suspension hors horaires.
  setSlaRuntime({ slaMs: sla.firstAlertMin * 60_000, suspendOutsideHours: sla.suspendOutsideHours, schedule: scheduleOf(sla) });

  const leads: LeadListItem[] = [];
  const managersOf = new Map<string, string[]>();
  for (const d of leadSnap.docs) {
    const item = toListItem(d.id, d.data());
    if (!item) continue;
    leads.push(item);
    managersOf.set(d.id, strs(d.get('managerIds')));
  }
  const campaigns: CampaignView[] = campSnap.docs.map((d) => ({
    id: d.id,
    name: String(d.get('name') ?? d.id),
    sourceId: String(d.get('sourceId') ?? ''),
    externalId: (d.get('externalId') as string | null) ?? null,
    productCode: (d.get('productCode') as string | null) ?? null,
    zones: strs(d.get('zones')),
    status: (d.get('status') ?? 'draft') as CampaignView['status'],
    budgetCents: typeof d.get('budgetCents') === 'number' ? (d.get('budgetCents') as number) : null,
  }));
  const spends: ReportSpend[] = spendSnap.docs
    .map((d) => ({ campaignId: String(d.get('campaignId') ?? ''), amountCents: Number(d.get('amountCents') ?? 0), atMs: ms(d.get('date')) ?? ms(d.get('at')) ?? 0 }))
    .filter((x) => x.campaignId && Number.isFinite(x.amountCents));
  const users = new Map<string, string>();
  for (const d of userSnap.docs) users.set(d.id, String(d.get('name') || d.get('displayName') || `${d.get('firstName') ?? ''} ${d.get('lastName') ?? ''}`.trim() || d.get('email') || d.id));
  for (const s of staffAll) if (!users.has(s.uid)) users.set(s.uid, s.name);
  return {
    leads,
    managersOf,
    reportCampaigns: campaigns.map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId, productCode: c.productCode })),
    campaigns,
    spends,
    names: { users, campaigns: new Map(campaigns.map((c) => [c.id, c.name])), sources: new Map(srcSnap.docs.map((d) => [d.id, String(d.get('name') ?? d.id)])) },
    slaMs: sla.firstAlertMin * 60_000,
    truncated: leadSnap.size >= LEAD_READ_LIMIT,
  };
}

// ── Génération ───────────────────────────────────────────────────────────────

const slug = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rapport';

/** Fichier d'un périmètre : « all » = tout (administrateur) ; sinon les leads du manager, sans dépense. */
function fileFor(s: ScheduledExport, data: ReportData, scope: string, fromMs: number, toMs: number, nowMs: number): { content: string; mime: string; filename: string; rows: number } {
  const mine = scope === 'all' ? data.leads : data.leads.filter((l) => data.managersOf.get(l.id)?.includes(scope));
  const used = new Set(mine.map((l) => l.campaignId).filter((x): x is string => !!x));
  const reportCampaigns = scope === 'all' ? data.reportCampaigns : data.reportCampaigns.filter((c) => used.has(c.id));
  const campaigns = scope === 'all' ? data.campaigns : data.campaigns.filter((c) => used.has(c.id));
  const filters: ReportFilters = { fromMs, toMs, mode: s.mode, sourceId: s.sourceId, campaignId: '', product: s.product, owner: '' };
  const built = buildExport(
    { leads: mine, reportCampaigns, campaigns, spends: scope === 'all' ? data.spends : [], filters, nowMs, slaMs: data.slaMs, elapsed: slaElapsedMs, names: data.names },
    // Toujours anonymisé, quel que soit le destinataire : rien d'identifiant ne quitte le CRM par email.
    { kind: s.kind, raw: !s.corrected, detail: s.detail, anonymize: true, columns: DEFAULT_LEAD_COLUMNS, role: 'manager' }
  );
  const base = `${slug(s.name)}-${dateKey(fromMs)}${scope === 'all' ? '' : '-equipe'}`;
  if (s.format === 'csv') return { content: toCsv(['Export CRM Leads — Label Énergie'], built.rows), mime: 'text/csv; charset=utf-8', filename: `${base}.csv`, rows: built.rows.length };
  return { content: printableHtml(`${s.name} — ${built.summary[0].value}`, built.rows), mime: 'text/html; charset=utf-8', filename: `${base}.html`, rows: built.rows.length };
}

const pendingRecipient = (u: StaffUser): RunRecipient => ({ uid: u.uid, email: u.email, status: 'pending', attempts: 0, lastAttemptMs: null, error: null });

export interface RunArgs {
  id: string;
  occurrence: string;
  trigger: 'schedule' | 'manual';
  actorId: string | null;
  atMs: number;
  fromMs: number;
  toMs: number;
}

export type RunOutcome = { ok: true; run: ExportRun } | { ok: false; code: 'exists' | 'storage' | 'no_recipient' | 'error'; message: string };

const isAlreadyExists = (e: unknown): boolean => {
  const x = e as { code?: unknown; message?: unknown };
  return x?.code === 6 || x?.code === 'already-exists' || /already exists/i.test(String(x?.message ?? ''));
};

/** Crée l'exécution (une seule par échéance), génère les fichiers, les range dans Storage, puis envoie les messages. */
export async function executeRun(db: Firestore, s: ScheduledExport, a: RunArgs, deps: RunnerDeps, staffAll?: readonly StaffUser[]): Promise<RunOutcome> {
  const ref = db.collection(COL.exportRuns).doc(a.id);
  const base: ExportRun = {
    id: a.id,
    scheduleId: s.id,
    scheduleName: s.name,
    kind: s.kind,
    format: s.format,
    atMs: a.atMs,
    occurrence: a.occurrence,
    trigger: a.trigger,
    actorId: a.actorId,
    fromMs: a.fromMs,
    toMs: a.toMs,
    status: 'running',
    error: null,
    notes: [],
    files: [],
    expiresAtMs: a.atMs + RETENTION_DAYS * DAY_MS,
  };
  try {
    await ref.create(base);
  } catch (e) {
    if (isAlreadyExists(e)) return { ok: false, code: 'exists', message: 'Cette échéance a déjà été exécutée.' };
    throw e;
  }
  const fail = async (code: 'storage' | 'no_recipient' | 'error', message: string, notes: string[] = []): Promise<RunOutcome> => {
    await ref.set({ ...base, status: 'error', error: message, notes });
    return { ok: false, code, message };
  };

  try {
    if (!deps.storage) return await fail('storage', 'Stockage des fichiers indisponible : rien n’a été généré.');
    const staff = staffAll ?? (await readStaff(db));
    const byId = new Map(staff.map((u) => [u.uid, u]));
    const notes: string[] = [];
    const targets: StaffUser[] = [];
    for (const uid of s.recipients) {
      const u = byId.get(uid);
      if (!u) notes.push(`Destinataire ${uid} écarté : compte inactif, introuvable ou ni administrateur ni manager.`);
      else if (!u.email) notes.push(`${u.name} écarté : aucune adresse email sur son compte.`);
      else targets.push(u);
    }
    if (targets.length === 0) return await fail('no_recipient', 'Aucun destinataire valide : rien n’a été généré.', notes);

    const data = await readReportData(db, staff);
    if (data.truncated) notes.push(`Lecture limitée aux ${LEAD_READ_LIMIT} premiers leads : les chiffres peuvent être incomplets.`);
    // Un fichier complet pour les administrateurs, un fichier par manager (son périmètre).
    const scopes = new Map<string, StaffUser[]>();
    for (const u of targets) {
      const scope = u.role === 'admin' ? 'all' : u.uid;
      scopes.set(scope, [...(scopes.get(scope) ?? []), u]);
    }
    const files: RunFile[] = [];
    for (const [scope, users] of scopes) {
      const f = fileFor(s, data, scope, a.fromMs, a.toMs, a.atMs);
      const path = `cl_exports/${a.id}/${scope}-${f.filename}`;
      await deps.storage.put(path, f.content, f.mime);
      files.push({ scope, path, filename: f.filename, mime: f.mime, bytes: Buffer.byteLength(f.content, 'utf8'), rows: f.rows, recipients: users.map(pendingRecipient) });
    }
    const run: ExportRun = { ...base, status: 'ready', notes, files };
    await ref.set(run);
    return { ok: true, run: await sendRunEmails(db, run, deps, a.atMs) };
  } catch (e) {
    deps.log?.error('exports : génération en échec', e);
    return await fail('error', 'Erreur interne pendant la génération : voir les journaux du serveur.');
  }
}

// ── Envoi ────────────────────────────────────────────────────────────────────

const canTry = (r: RunRecipient, nowMs: number): boolean =>
  r.status === 'pending' || (r.status === 'error' && r.attempts < MAX_EMAIL_ATTEMPTS && (r.lastAttemptMs === null || nowMs - r.lastAttemptMs >= EMAIL_RETRY_MS));

export const downloadLink = (siteUrl: string, runId: string, scope: string): string => `${siteUrl.replace(/\/+$/, '')}/rapports/export/${encodeURIComponent(runId)}?f=${encodeURIComponent(scope)}`;

/** Envoie les messages en attente ou à retenter, puis enregistre l'état de chacun. */
export async function sendRunEmails(db: Firestore, run: ExportRun, deps: RunnerDeps, nowMs: number): Promise<ExportRun> {
  if (run.status !== 'ready' || emailsSettled(run)) return run;
  const names = new Map((await readStaff(db)).map((u) => [u.uid, u.name]));
  const files = run.files.map((f) => ({ ...f, recipients: f.recipients.map((r) => ({ ...r })) }));
  for (const f of files) {
    for (const r of f.recipients) {
      if (!canTry(r, nowMs)) continue;
      r.attempts += 1;
      r.lastAttemptMs = nowMs;
      if (!deps.send) {
        r.status = 'error';
        r.error = `Envoi impossible : EmailJS n’est pas configuré (variables manquantes : ${deps.missingVars.join(', ') || 'inconnues'}).`;
        continue;
      }
      if (!deps.siteUrl) {
        r.status = 'error';
        r.error = 'Envoi impossible : adresse du CRM inconnue (variable SITE_URL).';
        continue;
      }
      const res = await deps.send(emailParams({ run, file: f, recipient: { name: names.get(r.uid) ?? '', email: r.email }, link: downloadLink(deps.siteUrl, run.id, f.scope) }));
      if (res.ok) {
        r.status = 'sent';
        r.error = null;
      } else {
        r.status = 'error';
        r.error = res.error;
        deps.log?.warn('exports : envoi en échec', { run: run.id, uid: r.uid, attempt: r.attempts });
      }
    }
  }
  const next: ExportRun = { ...run, files };
  await db.collection(COL.exportRuns).doc(run.id).set(next);
  return next;
}

/** « Renvoyer » : remet à zéro les envois en échec définitif, puis les rejoue. */
export async function resendRun(db: Firestore, id: string, deps: RunnerDeps, nowMs: number): Promise<{ ok: true; run: ExportRun } | { ok: false; code: 'not_found' | 'invalid'; message: string }> {
  const ref = db.collection(COL.exportRuns).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'not_found', message: 'Exécution introuvable.' };
  const run = snap.data() as ExportRun;
  if (run.status !== 'ready') return { ok: false, code: 'invalid', message: 'Seule une exécution prête (fichiers disponibles) peut être renvoyée.' };
  const reset: ExportRun = { ...run, files: run.files.map((f) => ({ ...f, recipients: f.recipients.map((r) => (r.status === 'error' ? { ...r, status: 'pending' as const, attempts: 0, lastAttemptMs: null } : r)) })) };
  return { ok: true, run: await sendRunEmails(db, reset, deps, nowMs) };
}

// ── Planificateur ────────────────────────────────────────────────────────────

export interface RunnerReport {
  generated: number;
  skipped: number;
  failed: number;
  retried: number;
  purged: number;
}

/** Appelé toutes les 5 minutes : exécute les échéances dues, retente les envois en échec, supprime les fichiers périmés. */
export async function runDueExports(db: Firestore, nowMs: number, deps: RunnerDeps): Promise<RunnerReport> {
  const report: RunnerReport = { generated: 0, skipped: 0, failed: 0, retried: 0, purged: 0 };
  const settings = await db.collection(COL.settings).doc(SETTINGS_ID).get();
  const schedules = parseSchedules(settings.exists ? settings.data() : null);
  let staff: StaffUser[] | undefined;
  for (const s of schedules) {
    const due = dueOccurrence(s, nowMs);
    if (!due) continue;
    staff ??= await readStaff(db);
    const range = rollingRange(s.period, due.atMs);
    const out = await executeRun(db, s, { id: runId(s.id, due.key), occurrence: due.key, trigger: 'schedule', actorId: null, atMs: due.atMs, ...range }, deps, staff);
    if (out.ok) report.generated++;
    else if (out.code === 'exists') report.skipped++;
    else report.failed++;
  }

  // Envois à terminer ou à retenter (exécutions des deux derniers jours).
  const recent = await db.collection(COL.exportRuns).where('atMs', '>', nowMs - 2 * DAY_MS).get();
  for (const d of recent.docs) {
    const run = d.data() as ExportRun;
    if (run.status === 'ready' && !emailsSettled(run) && run.files.some((f) => f.recipients.some((r) => canTry(r, nowMs)))) {
      await sendRunEmails(db, run, deps, nowMs);
      report.retried++;
    }
  }

  // Purge des fichiers après 30 jours : l'historique reste, marqué « expiré ».
  const old = await db.collection(COL.exportRuns).where('expiresAtMs', '<=', nowMs).limit(50).get();
  for (const d of old.docs) {
    const run = d.data() as ExportRun;
    if (run.status === 'expired') continue;
    if (deps.storage) for (const f of run.files) await deps.storage.remove(f.path).catch((e) => deps.log?.warn('exports : suppression impossible', { path: f.path, e: String(e) }));
    await d.ref.set({ ...run, status: 'expired' });
    report.purged++;
  }
  return report;
}

/** « Exécuter maintenant » : une exécution hors échéance, sur la période glissante du rapport, tracée à son auteur. */
export async function runNow(db: Firestore, scheduleId: string, actorId: string, nowMs: number, deps: RunnerDeps): Promise<RunOutcome | { ok: false; code: 'not_found'; message: string }> {
  const settings = await db.collection(COL.settings).doc(SETTINGS_ID).get();
  const s = parseSchedules(settings.exists ? settings.data() : null).find((x) => x.id === scheduleId);
  if (!s) return { ok: false, code: 'not_found', message: 'Rapport programmé introuvable (enregistrez-le d’abord).' };
  const range = rollingRange(s.period, nowMs);
  return executeRun(db, s, { id: manualRunId(s.id, nowMs), occurrence: `m${nowMs}`, trigger: 'manual', actorId, atMs: nowMs, ...range }, deps);
}

// ── Lecture : historique et téléchargement ───────────────────────────────────

/** Historique : l'administrateur voit tout ; un manager, les exécutions dont un fichier lui est destiné. Les chemins de stockage ne sortent pas. */
export async function listRuns(db: Firestore, role: Role, uid: string): Promise<ExportRun[]> {
  const snap = await db.collection(COL.exportRuns).orderBy('atMs', 'desc').limit(100).get();
  const runs = snap.docs.map((d) => d.data() as ExportRun);
  const visible = role === 'admin' ? runs : runs.map((r) => ({ ...r, files: r.files.filter((f) => f.recipients.some((x) => x.uid === uid)) })).filter((r) => r.files.length > 0);
  return visible.map((r) => ({ ...r, files: r.files.map((f) => ({ ...f, path: '' })) }));
}

export type DownloadOutcome = { ok: true; filename: string; mime: string; content: string } | { ok: false; code: 'not_found' | 'forbidden' | 'expired' | 'storage'; message: string };

/** Fichier d'une exécution : administrateur, ou destinataire de CE fichier (manager). Tout autre compte reçoit « introuvable ». */
export async function readDownload(db: Firestore, args: { runId: string; scope: string; uid: string; role: Role }, deps: Pick<RunnerDeps, 'storage'>): Promise<DownloadOutcome> {
  const snap = await db.collection(COL.exportRuns).doc(args.runId).get();
  const notFound: DownloadOutcome = { ok: false, code: 'not_found', message: 'Fichier introuvable ou réservé à ses destinataires.' };
  if (!snap.exists) return notFound;
  const run = snap.data() as ExportRun;
  const file = run.files.find((f) => f.scope === args.scope);
  if (!file) return notFound;
  const allowed = args.role === 'admin' || (args.role === 'manager' && file.recipients.some((r) => r.uid === args.uid));
  if (!allowed) return notFound;
  if (run.status === 'expired') return { ok: false, code: 'expired', message: `Ce fichier a été supprimé (conservation de ${RETENTION_DAYS} jours).` };
  if (run.status !== 'ready') return notFound;
  if (!deps.storage) return { ok: false, code: 'storage', message: 'Stockage des fichiers indisponible.' };
  const content = await deps.storage.get(file.path);
  if (content === null) return { ok: false, code: 'expired', message: 'Ce fichier n’est plus disponible.' };
  return { ok: true, filename: file.filename, mime: file.mime, content };
}
