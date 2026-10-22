// Exports programmés (§22.10, fig. 34, onglet « Rapports programmés »). Fonctions pures, sans Firestore ni horloge : réglage
// d'un rapport récurrent (lecture tolérante, validation), calcul de son échéance et de sa période glissante dans le fuseau de
// l'entreprise, texte lisible, forme d'une exécution et paramètres du message envoyé.
//
// Un rapport programmé conserve la configuration et les filtres de sa création (§22.10). Il est TOUJOURS anonymisé : aucune
// donnée identifiante ne part par email. Le message contient un lien vers le CRM, jamais le fichier : la connexion et les droits
// sont vérifiés au téléchargement.

import { EXPORT_FORMATS, EXPORT_KINDS, EXPORT_KIND_LABELS, type ExportFormat, type ExportKind } from './exports';

export const SCHEDULE_TZ = 'Europe/Paris';
export const MAX_SCHEDULES = 20;
export const MAX_RECIPIENTS = 20;
/** Un fichier généré reste téléchargeable ce nombre de jours, puis il est supprimé. */
export const RETENTION_DAYS = 30;
/** Une échéance manquée (service arrêté) n'est rattrapée que pendant ce délai : au-delà, un rapport périmé n'aurait plus de sens. */
export const CATCH_UP_MS = 24 * 3_600_000;

const MIN = 60_000;

// ── Fuseau horaire ───────────────────────────────────────────────────────────

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(ms: number, tz: string = SCHEDULE_TZ): LocalParts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), h: Number(get('hour')) % 24, mi: Number(get('minute')), weekday: WEEKDAY[get('weekday')] ?? 1 };
}

/** Instant (epoch ms) dont l'heure locale est exactement celle demandée ; les jours hors du mois (jour 0, 32…) sont ramenés dans le calendrier. */
export function zonedToMs(y: number, m: number, d: number, h: number, mi: number, tz: string = SCHEDULE_TZ): number {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let guess = wanted;
  // Deux passes suffisent, y compris autour d'un changement d'heure : le décalage ne varie que d'une heure.
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export const startOfLocalDay = (ms: number, tz: string = SCHEDULE_TZ): number => {
  const p = localParts(ms, tz);
  return zonedToMs(p.y, p.m, p.d, 0, 0, tz);
};

/** Minuit local, `n` jours calendaires plus tôt ou plus tard. */
export function addLocalDays(ms: number, n: number, tz: string = SCHEDULE_TZ): number {
  const p = localParts(ms, tz);
  return zonedToMs(p.y, p.m, p.d + n, 0, 0, tz);
}

export const dateKey = (ms: number, tz: string = SCHEDULE_TZ): string => {
  const p = localParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

// ── Période glissante ────────────────────────────────────────────────────────

export const SCHEDULE_PERIODS = ['previous_day', 'last_7d', 'previous_week', 'last_30d', 'previous_month', 'month_to_date'] as const;
export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number];
export const SCHEDULE_PERIOD_LABELS: Record<SchedulePeriod, string> = {
  previous_day: 'Veille',
  last_7d: '7 derniers jours (jours complets)',
  previous_week: 'Semaine précédente (lundi au dimanche)',
  last_30d: '30 derniers jours (jours complets)',
  previous_month: 'Mois précédent',
  month_to_date: 'Mois en cours, jusqu’à l’exécution',
};

/** Bornes de la période pour une exécution à `atMs` : jours calendaires entiers dans le fuseau de l'entreprise, fin exclue. */
export function rollingRange(period: SchedulePeriod, atMs: number, tz: string = SCHEDULE_TZ): { fromMs: number; toMs: number } {
  const today = startOfLocalDay(atMs, tz);
  const p = localParts(atMs, tz);
  switch (period) {
    case 'previous_day': return { fromMs: addLocalDays(today, -1, tz), toMs: today };
    case 'last_7d': return { fromMs: addLocalDays(today, -7, tz), toMs: today };
    case 'last_30d': return { fromMs: addLocalDays(today, -30, tz), toMs: today };
    case 'previous_week': {
      const monday = addLocalDays(today, -(p.weekday - 1), tz);
      return { fromMs: addLocalDays(monday, -7, tz), toMs: monday };
    }
    case 'previous_month': return { fromMs: zonedToMs(p.y, p.m - 1, 1, 0, 0, tz), toMs: zonedToMs(p.y, p.m, 1, 0, 0, tz) };
    case 'month_to_date': return { fromMs: zonedToMs(p.y, p.m, 1, 0, 0, tz), toMs: atMs };
  }
}

// ── Réglage d'un rapport programmé ───────────────────────────────────────────

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = { daily: 'Tous les jours', weekly: 'Toutes les semaines', monthly: 'Tous les mois' };
export const WEEKDAY_LABELS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export interface ScheduledExport {
  /** Identifiant stable « s_… » : l'historique des exécutions y est rattaché. */
  id: string;
  name: string;
  kind: ExportKind;
  format: ExportFormat;
  frequency: ScheduleFrequency;
  /** 1 = lundi … 7 = dimanche (fréquence hebdomadaire). */
  weekday: number;
  /** 1 à 28 (fréquence mensuelle) : jamais un jour qui manque certains mois. */
  dayOfMonth: number;
  /** « HH:MM », heure de l'entreprise (Europe/Paris). */
  time: string;
  period: SchedulePeriod;
  mode: 'event' | 'cohort';
  sourceId: string;
  product: string;
  /** Données corrigées (hors doublons, faux leads, exclus) ou brutes. */
  corrected: boolean;
  /** Joint le détail des leads (anonymisé). */
  detail: boolean;
  /** Utilisateurs du CRM (administrateur ou manager) qui reçoivent le lien. */
  recipients: string[];
  active: boolean;
  /** Dernier jour d'exécution (« AAAA-MM-JJ », inclus) ; vide = sans fin. */
  endDate: string;
  createdAtMs: number;
}

export const SCHEDULE_ID = /^s_[a-z0-9_]{1,40}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Formats proposés pour un envoi programmé : le fichier généré côté serveur (CSV, ou page imprimable pour un PDF). */
export const SCHEDULE_FORMATS: readonly ExportFormat[] = EXPORT_FORMATS;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function scheduleFrom(raw: unknown): ScheduledExport | null {
  const x = rec(raw);
  const id = typeof x.id === 'string' ? x.id : '';
  const kind = EXPORT_KINDS.find((k) => k === x.kind);
  const format = EXPORT_FORMATS.find((f) => f === x.format);
  const frequency = SCHEDULE_FREQUENCIES.find((f) => f === x.frequency);
  const period = SCHEDULE_PERIODS.find((p) => p === x.period);
  const time = typeof x.time === 'string' && TIME.test(x.time) ? x.time : '';
  const name = str(x.name, 60);
  if (!SCHEDULE_ID.test(id) || !kind || !format || !frequency || !period || !time || name.length < 2) return null;
  const recipients = Array.isArray(x.recipients) ? [...new Set(x.recipients.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim().slice(0, 128)))].slice(0, MAX_RECIPIENTS) : [];
  return {
    id,
    name,
    kind,
    format,
    frequency,
    weekday: typeof x.weekday === 'number' && x.weekday >= 1 && x.weekday <= 7 ? Math.round(x.weekday) : 1,
    dayOfMonth: typeof x.dayOfMonth === 'number' && x.dayOfMonth >= 1 && x.dayOfMonth <= 28 ? Math.round(x.dayOfMonth) : 1,
    time,
    period,
    mode: x.mode === 'cohort' ? 'cohort' : 'event',
    sourceId: str(x.sourceId, 128),
    product: str(x.product, 80),
    corrected: x.corrected !== false,
    detail: x.detail === true,
    recipients,
    active: x.active !== false,
    endDate: typeof x.endDate === 'string' && DATE.test(x.endDate) ? x.endDate : '',
    createdAtMs: typeof x.createdAtMs === 'number' && Number.isFinite(x.createdAtMs) ? x.createdAtMs : 0,
  };
}

/** Lecture tolérante de `cl_settings/exports` : ce qui est mal formé est ignoré, rien n'est inventé. */
export function parseSchedules(raw: unknown): ScheduledExport[] {
  const list = rec(raw).schedules;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ScheduledExport[] = [];
  for (const r of list) {
    const s = scheduleFrom(r);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
    if (out.length >= MAX_SCHEDULES) break;
  }
  return out;
}

/** Saisie de l'écran : mêmes champs, types contrôlés, rien n'est corrigé en silence (la validation dit ce qui ne va pas). */
export function coerceSchedulesInput(raw: unknown): ScheduledExport[] {
  const list = rec(raw).schedules;
  return (Array.isArray(list) ? list : []).map((r): ScheduledExport => {
    const x = rec(r);
    return {
      id: str(x.id, 60),
      name: str(x.name, 80),
      kind: x.kind as ExportKind,
      format: x.format as ExportFormat,
      frequency: x.frequency as ScheduleFrequency,
      weekday: typeof x.weekday === 'number' ? x.weekday : Number.NaN,
      dayOfMonth: typeof x.dayOfMonth === 'number' ? x.dayOfMonth : Number.NaN,
      time: str(x.time, 8),
      period: x.period as SchedulePeriod,
      mode: x.mode === 'cohort' ? 'cohort' : 'event',
      sourceId: str(x.sourceId, 128),
      product: str(x.product, 80),
      corrected: x.corrected === true,
      detail: x.detail === true,
      recipients: Array.isArray(x.recipients) ? x.recipients.filter((v): v is string => typeof v === 'string').map((v) => v.trim()) : [],
      active: x.active === true,
      endDate: str(x.endDate, 10),
      createdAtMs: typeof x.createdAtMs === 'number' && Number.isFinite(x.createdAtMs) ? x.createdAtMs : 0,
    };
  });
}

export function validateSchedules(list: readonly ScheduledExport[]): string[] {
  const e: string[] = [];
  if (list.length > MAX_SCHEDULES) e.push(`${MAX_SCHEDULES} rapports programmés au plus.`);
  const ids = new Set<string>();
  for (const s of list) {
    const label = s.name || 'Rapport programmé';
    if (!SCHEDULE_ID.test(s.id) || ids.has(s.id)) e.push(`${label} : identifiant invalide ou en double.`);
    ids.add(s.id);
    if (s.name.length < 2 || s.name.length > 60) e.push('Un rapport programmé a un nom de 2 à 60 caractères.');
    if (!EXPORT_KINDS.includes(s.kind)) e.push(`${label} : type de rapport inconnu.`);
    if (!EXPORT_FORMATS.includes(s.format)) e.push(`${label} : format inconnu.`);
    if (!SCHEDULE_FREQUENCIES.includes(s.frequency)) e.push(`${label} : fréquence inconnue.`);
    if (s.frequency === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday >= 1 && s.weekday <= 7)) e.push(`${label} : choisissez le jour de la semaine.`);
    if (s.frequency === 'monthly' && !(Number.isInteger(s.dayOfMonth) && s.dayOfMonth >= 1 && s.dayOfMonth <= 28)) e.push(`${label} : le jour du mois va de 1 à 28.`);
    if (!TIME.test(s.time)) e.push(`${label} : l’heure est au format HH:MM.`);
    if (!SCHEDULE_PERIODS.includes(s.period)) e.push(`${label} : période inconnue.`);
    if (s.recipients.length === 0) e.push(`${label} : choisissez au moins un destinataire.`);
    if (s.recipients.length > MAX_RECIPIENTS || new Set(s.recipients).size !== s.recipients.length) e.push(`${label} : ${MAX_RECIPIENTS} destinataires au plus, sans doublon.`);
    if (s.endDate && !DATE.test(s.endDate)) e.push(`${label} : la date de fin est au format AAAA-MM-JJ.`);
  }
  return [...new Set(e)];
}

export function newScheduleId(taken: ReadonlySet<string>): string {
  for (let i = taken.size + 1; ; i++) {
    const id = `s_${i}`;
    if (!taken.has(id)) return id;
  }
}

// ── Échéances ────────────────────────────────────────────────────────────────

export interface Occurrence {
  atMs: number;
  /** Clé stable de l'échéance (« AAAAMMJJHHMM », heure de l'entreprise) : une exécution par rapport et par échéance. */
  key: string;
}

const occKey = (y: number, m: number, d: number, time: string): string => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${time.replace(':', '')}`;

function matches(s: ScheduledExport, y: number, m: number, d: number): boolean {
  if (s.frequency === 'daily') return true;
  if (s.frequency === 'monthly') return d === s.dayOfMonth;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (wd === 0 ? 7 : wd) === s.weekday;
}

function occurrenceOn(s: ScheduledExport, y: number, m: number, d: number): Occurrence {
  const [hh, mm] = s.time.split(':').map(Number);
  return { atMs: zonedToMs(y, m, d, hh, mm), key: occKey(y, m, d, s.time) };
}

/**
 * Dernière échéance déjà passée, à exécuter maintenant : jamais avant la création du rapport, jamais après sa date de fin,
 * et pas plus de 24 h après l'heure prévue (un service arrêté ne rejoue pas de vieux rapports). Null si rien n'est dû.
 */
export function dueOccurrence(s: ScheduledExport, nowMs: number): Occurrence | null {
  if (!s.active) return null;
  const today = localParts(nowMs);
  for (let back = 0; back <= 35; back++) {
    const dt = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (!matches(s, y, m, d)) continue;
    const occ = occurrenceOn(s, y, m, d);
    if (occ.atMs > nowMs) continue;
    if (occ.atMs <= s.createdAtMs) return null;
    if (nowMs - occ.atMs > CATCH_UP_MS) return null;
    if (s.endDate && dateKey(occ.atMs) > s.endDate) return null;
    return occ;
  }
  return null;
}

/** Prochaine échéance (pour l'affichage) ; null si le rapport est terminé ou suspendu. */
export function nextOccurrence(s: ScheduledExport, nowMs: number): Occurrence | null {
  if (!s.active) return null;
  const today = localParts(nowMs);
  for (let fwd = 0; fwd <= 400; fwd++) {
    const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + fwd));
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (!matches(s, y, m, d)) continue;
    const occ = occurrenceOn(s, y, m, d);
    if (occ.atMs <= nowMs) continue;
    if (s.endDate && dateKey(occ.atMs) > s.endDate) return null;
    return occ;
  }
  return null;
}

/** « Tous les lundis à 08:00 · Europe/Paris ». */
export function describeSchedule(s: Pick<ScheduledExport, 'frequency' | 'weekday' | 'dayOfMonth' | 'time'>): string {
  const when = s.frequency === 'daily' ? 'Tous les jours' : s.frequency === 'weekly' ? `Tous les ${WEEKDAY_LABELS[s.weekday] ?? '?'}s` : s.dayOfMonth === 1 ? 'Le 1er de chaque mois' : `Le ${s.dayOfMonth} de chaque mois`;
  return `${when} à ${s.time}`;
}

// ── Exécutions ───────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'ready' | 'error' | 'expired';
export const RUN_STATUS_LABELS: Record<RunStatus, string> = { running: 'En cours', ready: 'Prêt', error: 'Erreur', expired: 'Expiré' };

export interface RunRecipient {
  uid: string;
  email: string;
  status: 'pending' | 'sent' | 'error';
  attempts: number;
  lastAttemptMs: number | null;
  error: string | null;
}

export interface RunFile {
  /** « all » : fichier complet (administrateur) ; sinon l'identifiant du manager dont c'est le périmètre. */
  scope: string;
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  rows: number;
  recipients: RunRecipient[];
}

export interface ExportRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  kind: ExportKind;
  format: ExportFormat;
  atMs: number;
  occurrence: string;
  trigger: 'schedule' | 'manual';
  actorId: string | null;
  fromMs: number;
  toMs: number;
  status: RunStatus;
  error: string | null;
  /** Destinataires écartés (compte inactif, sans email…) : dits dans l'historique plutôt que perdus. */
  notes: string[];
  files: RunFile[];
  expiresAtMs: number;
}

/** Tentatives d'envoi d'un message : au-delà, l'échec est définitif et visible dans l'historique. */
export const MAX_EMAIL_ATTEMPTS = 3;
/** Délai minimal entre deux tentatives d'envoi du même message. */
export const EMAIL_RETRY_MS = 10 * MIN;

export const runId = (scheduleId: string, key: string): string => `${scheduleId}_${key}`;
export const manualRunId = (scheduleId: string, atMs: number): string => `${scheduleId}_m${atMs}`;

/** Tous les messages sont partis, ou ont épuisé leurs tentatives : plus rien à renvoyer. */
export const emailsSettled = (run: ExportRun): boolean => run.files.every((f) => f.recipients.every((r) => r.status === 'sent' || (r.status === 'error' && r.attempts >= MAX_EMAIL_ATTEMPTS)));

export function runLabel(run: Pick<ExportRun, 'fromMs' | 'toMs'>): string {
  const d = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: SCHEDULE_TZ });
  return `${d(run.fromMs)} au ${d(Math.max(run.fromMs, run.toMs - 1))}`;
}

// ── Message ──────────────────────────────────────────────────────────────────

/**
 * Paramètres transmis au modèle EmailJS. Les noms sont volontairement redondants (to_email / email / user_email, message /
 * body…) : le modèle de l'entreprise n'est pas connu d'avance, il suffit qu'il en utilise un.
 */
export function emailParams(args: { run: ExportRun; file: RunFile; recipient: { name: string; email: string }; link: string }): Record<string, string> {
  const { run, file, recipient, link } = args;
  const title = `${run.scheduleName} — ${EXPORT_KIND_LABELS[run.kind]}`;
  const period = runLabel(run);
  const message = `Votre rapport « ${run.scheduleName} » est disponible pour la période du ${period}. Il contient ${file.rows} ligne${file.rows > 1 ? 's' : ''}, sans donnée personnelle directement identifiante. Connectez-vous au CRM pour le télécharger : ${link} (lien valable ${RETENTION_DAYS} jours, accès réservé aux destinataires).`;
  return {
    to_email: recipient.email,
    email: recipient.email,
    user_email: recipient.email,
    to_name: recipient.name || recipient.email,
    // « name » et « time » sont ceux du modèle de contact d'origine : l'expéditeur affiché est le CRM, l'heure celle de génération.
    name: 'CRM Leads — Label Énergie',
    user_name: recipient.name || recipient.email,
    reply_to: recipient.email,
    subject: `Rapport programmé : ${title}`,
    title,
    report_name: run.scheduleName,
    report_type: EXPORT_KIND_LABELS[run.kind],
    period,
    rows: String(file.rows),
    format: file.filename.endsWith('.csv') ? 'CSV' : 'Page imprimable (PDF)',
    link,
    download_link: link,
    download_url: link,
    url: link,
    message,
    body: message,
    generated_at: new Date(run.atMs).toLocaleString('fr-FR', { timeZone: SCHEDULE_TZ }),
    time: new Date(run.atMs).toLocaleString('fr-FR', { timeZone: SCHEDULE_TZ }),
    expires_in_days: String(RETENTION_DAYS),
  };
}
