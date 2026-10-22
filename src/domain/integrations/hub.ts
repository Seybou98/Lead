// Hub d'intégrations (§24.10, figs. 40 à 42). Fonctions pures, sans Firestore ni navigateur : transformation des
// traces réelles (réception des leads, transmission au CRM principal, reprises manuelles) en un journal homogène,
// états des connecteurs, éléments à surveiller et erreurs à traiter. Rien n'est inventé : un connecteur qui n'existe pas
// en V1 (Meta, Google, SMS…) est montré « non connecté », jamais « opérationnel ».
//
// Les secrets, jetons et identifiants d'accès sont masqués dans toute charge utile (§24.10, §24.12).

import { SYNONYMS } from '../ingest/mapPayload';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type ConnectorId = 'webhook' | 'import' | 'manual' | 'api' | 'crm_main' | 'scheduler' | 'meta' | 'google_ads' | 'email' | 'sms' | 'whatsapp' | 'signature' | 'financing';

export interface ConnectorDef {
  id: ConnectorId;
  label: string;
  family: 'Acquisition' | 'Exploitation' | 'Communication' | 'Vente' | 'Pilotage';
  /** Connecteur réellement construit en V1 : il produit des traces. Les autres sont affichés « non connecté ». */
  live: boolean;
  description: string;
}

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: 'webhook', label: 'Réception des leads', family: 'Acquisition', live: true, description: 'Pabbly, formulaires du site, agences : réception unique des leads.' },
  { id: 'api', label: 'API de réception', family: 'Acquisition', live: true, description: 'Leads envoyés directement par un partenaire.' },
  { id: 'import', label: 'Import CSV', family: 'Acquisition', live: true, description: 'Fichiers importés par un manager ou un administrateur.' },
  { id: 'manual', label: 'Saisie manuelle', family: 'Acquisition', live: true, description: 'Leads saisis à la main.' },
  { id: 'crm_main', label: 'CRM principal', family: 'Exploitation', live: true, description: 'Création du dossier et retour des statuts.' },
  { id: 'scheduler', label: 'Planificateur serveur', family: 'Exploitation', live: true, description: 'Traitements toutes les 5 minutes : escalades, recyclage, file tampon, reprises.' },
  { id: 'meta', label: 'Meta Lead Ads', family: 'Acquisition', live: false, description: 'Connecteur direct non construit en V1 : les leads Meta arrivent par Pabbly.' },
  { id: 'google_ads', label: 'Google Ads', family: 'Acquisition', live: false, description: 'Non construit en V1.' },
  { id: 'email', label: 'Email', family: 'Communication', live: false, description: 'Aucun envoi automatique en V1 : messages préparés, envoyés à la main.' },
  { id: 'sms', label: 'SMS', family: 'Communication', live: false, description: 'Non construit en V1.' },
  { id: 'whatsapp', label: 'WhatsApp Business', family: 'Communication', live: false, description: 'Non construit en V1.' },
  { id: 'signature', label: 'Signature électronique', family: 'Vente', live: false, description: 'Non construit en V1.' },
  { id: 'financing', label: 'Financement (Floa, Domofinance…)', family: 'Vente', live: false, description: 'Non construit en V1.' },
];

export const CONNECTOR_LABEL = Object.fromEntries(CONNECTORS.map((c) => [c.id, c.label])) as Record<ConnectorId, string>;

export type EntryStatus = 'success' | 'pending' | 'error';
export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = { success: 'Réussie', pending: 'En attente', error: 'Erreur' };

export interface JournalEntry {
  /** Identifiant de corrélation affiché dans le détail. */
  id: string;
  atMs: number;
  connector: ConnectorId;
  /** Libellé lisible de la source (nom de la source de leads, par exemple). */
  sourceLabel: string | null;
  /** Identifiant de la source de leads (cl_sources) à l'origine de la trace. */
  sourceKey: string | null;
  operation: string;
  /** Référence métier : identifiant externe, sinon lead, sinon identifiant de la trace. */
  reference: string;
  leadId: string | null;
  status: EntryStatus;
  attempts: number | null;
  error: { code: string; message: string } | null;
  /** Charge utile, secrets masqués. */
  payload: string | null;
  actorId: string | null;
  /** Une reprise depuis le hub est possible (donnée brute rejetée, jamais rejouée). */
  replayable: boolean;
  /** Erreur ensuite résolue (reprise réussie) : n'est plus à traiter. */
  resolvedAtMs: number | null;
  kind: 'raw' | 'conversion' | 'audit';
  /** Identifiant du document d'origine (donnée brute ou lead). */
  sourceId: string;
  /** Durée de l'opération (réception → traitement, ou transmission) ; absente quand elle n'est pas connue. */
  durationMs?: number | null;
}

// ── Masquage ─────────────────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_ ]?key|apikey|bearer|credential|private[-_ ]?key|signature/i;
export const MASK = '••••••';

function maskDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 80).map(([k, x]) => [k, SECRET_KEY.test(k) ? MASK : maskDeep(x, depth + 1)]));
  }
  return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
}

/** Charge utile lisible : JSON indenté, clés sensibles masquées, longueur bornée. */
export function maskPayload(json: string | null | undefined, max = 4000): string | null {
  if (!json) return null;
  let text: string;
  try {
    text = JSON.stringify(maskDeep(JSON.parse(json)), null, 2);
  } catch {
    text = SECRET_KEY.test(json) ? MASK : json;
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Identifiant externe d'un payload de lead (mêmes synonymes que la réception). */
export function externalIdOf(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    for (const k of SYNONYMS.externalId ?? []) {
      const v = p?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
      if (typeof v === 'number') return String(v);
    }
  } catch {
    /* payload illisible : pas d'identifiant externe */
  }
  return null;
}

// ── Traces → entrées du journal ──────────────────────────────────────────────

export interface RawLeadTrace {
  id: string;
  receivedAtMs: number;
  channel: string;
  sourceId: string | null;
  payloadJson: string | null;
  leadId: string | null;
  processingState: string;
  rejectionCode?: string | null;
  rejectionReason?: string | null;
  actorId?: string | null;
  replayedAtMs?: number | null;
  /** Fin du traitement (accepté ou refusé) : sert à mesurer la durée de l'opération. */
  processedAtMs?: number | null;
}

/** Une donnée brute encore « reçue » au-delà de ce délai n'a pas été traitée : à reprendre. */
export const STUCK_AFTER_MS = 5 * MIN;

const CHANNEL_CONNECTOR: Record<string, ConnectorId> = { webhook: 'webhook', api: 'api', import: 'import', manual: 'manual' };
const OPERATION: Record<string, string> = { webhook: 'Lead reçu', api: 'Lead reçu', import: 'Lead importé', manual: 'Lead saisi' };

export function entryFromRaw(r: RawLeadTrace, nowMs: number, sourceName?: string | null): JournalEntry {
  const connector = CHANNEL_CONNECTOR[r.channel] ?? 'webhook';
  const stuck = r.processingState === 'received' && nowMs - r.receivedAtMs > STUCK_AFTER_MS;
  const status: EntryStatus = r.processingState === 'processed' ? 'success' : r.processingState === 'rejected' || stuck ? 'error' : 'pending';
  const error = r.processingState === 'rejected'
    ? { code: r.rejectionCode ?? 'rejected', message: r.rejectionReason ?? 'Lead refusé.' }
    : stuck ? { code: 'stuck', message: 'Reçu mais jamais traité : la réception a été interrompue.' } : null;
  const resolved = r.replayedAtMs ?? null;
  return {
    id: `raw_${r.id}`,
    atMs: r.receivedAtMs,
    connector,
    sourceLabel: sourceName ?? r.sourceId,
    sourceKey: r.sourceId,
    operation: OPERATION[r.channel] ?? 'Lead reçu',
    reference: externalIdOf(r.payloadJson) ?? r.leadId ?? r.id,
    leadId: r.leadId,
    status,
    attempts: 1,
    error,
    payload: maskPayload(r.payloadJson),
    actorId: r.actorId ?? null,
    replayable: error !== null && resolved === null,
    resolvedAtMs: resolved,
    kind: 'raw',
    sourceId: r.id,
    durationMs: r.processedAtMs != null && r.processedAtMs >= r.receivedAtMs ? r.processedAtMs - r.receivedAtMs : null,
  };
}

export interface ConversionTrace {
  leadId: string;
  state: string;
  attempts: number;
  lastError?: { code?: string; message?: string } | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  dossierId?: string | null;
  clientId?: string | null;
  saleId?: string | null;
}

export function entryFromConversion(c: ConversionTrace): JournalEntry {
  const status: EntryStatus = c.state === 'confirmed' ? 'success' : c.state === 'failed' ? 'error' : 'pending';
  const at = c.updatedAtMs ?? c.createdAtMs ?? 0;
  return {
    id: `conv_${c.leadId}`,
    atMs: at,
    connector: 'crm_main',
    sourceLabel: null,
    sourceKey: null,
    operation: 'Transmission dossier',
    reference: c.dossierId ?? c.leadId,
    leadId: c.leadId,
    status,
    attempts: c.attempts,
    error: status === 'error' ? { code: c.lastError?.code ?? 'failed', message: c.lastError?.message ?? 'Transmission échouée.' } : null,
    payload: maskPayload(JSON.stringify({ leadId: c.leadId, saleId: c.saleId ?? null, state: c.state, dossierId: c.dossierId ?? null, clientId: c.clientId ?? null })),
    actorId: null,
    // La reprise d'une transmission se fait sur l'écran Transmission, qui connaît le dossier et ses contrôles.
    replayable: false,
    resolvedAtMs: null,
    kind: 'conversion',
    sourceId: c.leadId,
    // Une transmission en cours n'a pas de durée : elle n'est pas terminée.
    durationMs: status !== 'pending' && c.createdAtMs !== null && c.updatedAtMs !== null && c.updatedAtMs >= c.createdAtMs ? c.updatedAtMs - c.createdAtMs : null,
  };
}

export interface ReplayAuditTrace {
  id: string;
  atMs: number;
  actorId: string;
  rawLeadId: string;
  outcome: string;
  leadId: string | null;
}

export function entryFromReplayAudit(a: ReplayAuditTrace): JournalEntry {
  return {
    id: `audit_${a.id}`,
    atMs: a.atMs,
    connector: 'webhook',
    sourceLabel: null,
    sourceKey: null,
    operation: 'Reprise manuelle',
    reference: a.leadId ?? a.rawLeadId,
    leadId: a.leadId,
    status: a.outcome === 'rejected' ? 'error' : 'success',
    attempts: 1,
    error: null,
    payload: null,
    actorId: a.actorId,
    replayable: false,
    resolvedAtMs: null,
    kind: 'audit',
    sourceId: a.id,
  };
}

// ── Statistiques et états ────────────────────────────────────────────────────

export const sortJournal = (entries: readonly JournalEntry[]): JournalEntry[] => [...entries].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));

export interface JournalStats {
  total: number;
  success: number;
  pending: number;
  error: number;
  /** Part des opérations réussies sur celles qui ont abouti ou échoué (hors « en attente »). */
  successRate: number | null;
}

export function statsOf(entries: readonly JournalEntry[]): JournalStats {
  const success = entries.filter((e) => e.status === 'success').length;
  const pending = entries.filter((e) => e.status === 'pending').length;
  const error = entries.filter((e) => e.status === 'error' && e.resolvedAtMs === null).length;
  const resolved = entries.filter((e) => e.status === 'error' && e.resolvedAtMs !== null).length;
  const done = success + error + resolved;
  return { total: entries.length, success: success + resolved, pending, error, successRate: done === 0 ? null : Math.round(((success + resolved) / done) * 1000) / 10 };
}

export type ConnectorState = 'operational' | 'attention' | 'inactive' | 'not_connected';
export const CONNECTOR_STATE_LABELS: Record<ConnectorState, string> = { operational: 'Opérationnel', attention: 'Attention', inactive: 'Aucune activité', not_connected: 'Non connecté' };

export interface ConnectorCard {
  def: ConnectorDef;
  state: ConnectorState;
  lastAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  /** Durée moyenne des opérations dont la durée est connue ; null sinon. */
  avgDurationMs?: number | null;
  /** Opérations des dernières 24 h. */
  daily: number;
  errors24h: number;
  pending: number;
}

/** Au-delà de ce retard, le planificateur est signalé comme arrêté (il passe toutes les 5 minutes). */
export const SCHEDULER_STALE_MS = 15 * MIN;

export function connectorCards(entries: readonly JournalEntry[], nowMs: number, schedulerLastRunMs: number | null): ConnectorCard[] {
  return CONNECTORS.map((def): ConnectorCard => {
    if (!def.live) return { def, state: 'not_connected', lastAtMs: null, lastSuccessAtMs: null, lastFailureAtMs: null, daily: 0, errors24h: 0, pending: 0 };
    if (def.id === 'scheduler') {
      const fresh = schedulerLastRunMs !== null && nowMs - schedulerLastRunMs <= SCHEDULER_STALE_MS;
      return { def, state: schedulerLastRunMs === null ? 'inactive' : fresh ? 'operational' : 'attention', lastAtMs: schedulerLastRunMs, lastSuccessAtMs: fresh ? schedulerLastRunMs : null, lastFailureAtMs: null, daily: 0, errors24h: 0, pending: 0 };
    }
    // « Réception des leads » regroupe le webhook : l'API a sa propre carte.
    const mine = entries.filter((e) => e.connector === def.id);
    const recent = mine.filter((e) => nowMs - e.atMs <= DAY);
    const errors24h = recent.filter((e) => e.status === 'error' && e.resolvedAtMs === null).length;
    const lastSuccess = mine.filter((e) => e.status === 'success').reduce<number | null>((m, e) => (m === null || e.atMs > m ? e.atMs : m), null);
    const lastFailure = mine.filter((e) => e.status === 'error').reduce<number | null>((m, e) => (m === null || e.atMs > m ? e.atMs : m), null);
    const pending = mine.filter((e) => e.status === 'pending').length;
    const last = mine.reduce<number | null>((m, e) => (m === null || e.atMs > m ? e.atMs : m), null);
    const state: ConnectorState = mine.length === 0 ? 'inactive' : errors24h > 0 || pending > 0 ? 'attention' : 'operational';
    const timed = mine.map((e) => e.durationMs).filter((d): d is number => typeof d === 'number');
    const avgDurationMs = timed.length ? Math.round(timed.reduce((s, d) => s + d, 0) / timed.length) : null;
    return { def, state, lastAtMs: last, lastSuccessAtMs: lastSuccess, lastFailureAtMs: lastFailure, avgDurationMs, daily: recent.length, errors24h, pending };
  });
}

export interface WatchItem {
  id: string;
  connector: ConnectorId;
  title: string;
  detail: string;
  sinceMs: number;
  level: 'critical' | 'warning';
}

// ── Retour des statuts du CRM principal (§24.8) ──────────────────────────────

/** Trace du dernier passage de la lecture des statuts du CRM principal (écrite par le planificateur). */
export interface StatusReturnTrace {
  atMs: number;
  /** Dossiers lus, étapes changées, ventes annulées côté CRM principal. */
  read: number;
  changed: number;
  cancelled: number;
  errorCount: number;
  errors: string[];
  durationMs: number | null;
}

export function parseStatusReturn(raw: unknown): StatusReturnTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const at = typeof x.atMs === 'number' ? x.atMs : (x.at as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
  if (at === null) return null;
  return { atMs: at, read: n(x.read), changed: n(x.changed), cancelled: n(x.cancelled), errorCount: n(x.errorCount), errors: Array.isArray(x.errors) ? x.errors.filter((e): e is string => typeof e === 'string').slice(0, 5) : [], durationMs: typeof x.durationMs === 'number' ? x.durationMs : null };
}

/** Le retour des statuts a-t-il échoué au dernier passage, ou ne passe-t-il plus ? Dépend du planificateur : arrêté, c'est lui qu'on signale. */
export function statusReturnWatch(t: StatusReturnTrace | null, nowMs: number, schedulerLastRunMs: number | null): WatchItem | null {
  if (!t) return null;
  if (schedulerLastRunMs !== null && nowMs - schedulerLastRunMs > SCHEDULER_STALE_MS) return null;
  if (t.errorCount === 0) return null;
  return { id: 'status_return', connector: 'crm_main', title: 'Retour des statuts du CRM principal : erreurs', detail: `${t.errorCount} erreur${t.errorCount > 1 ? 's' : ''} au dernier passage${t.errors[0] ? ` (${t.errors[0]})` : ''}. Les étapes des dossiers peuvent être en retard.`, sinceMs: t.atMs, level: t.errorCount >= 5 ? 'critical' : 'warning' };
}

/** « À surveiller » : erreurs non résolues regroupées par connecteur et par cause, et traces en attente depuis longtemps. */
export function watchItems(entries: readonly JournalEntry[], nowMs: number, schedulerLastRunMs: number | null, statusReturn: StatusReturnTrace | null = null): WatchItem[] {
  const out: WatchItem[] = [];
  const open = entries.filter((e) => e.status === 'error' && e.resolvedAtMs === null);
  const groups = new Map<string, JournalEntry[]>();
  for (const e of open) {
    const key = `${e.connector}|${e.error?.code ?? 'error'}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, list] of groups) {
    const first = list.reduce((m, e) => Math.min(m, e.atMs), Infinity);
    const last = list[0];
    out.push({
      id: key,
      connector: last.connector,
      title: `${CONNECTOR_LABEL[last.connector]} : ${last.error?.message ?? 'erreur'}`,
      detail: `${list.length} élément${list.length > 1 ? 's' : ''} en erreur${list.some((e) => (e.attempts ?? 0) >= 5) ? ', tentatives épuisées' : ''}.`,
      sinceMs: first,
      level: list.length >= 5 || list.some((e) => (e.attempts ?? 0) >= 5 || nowMs - e.atMs > DAY) ? 'critical' : 'warning',
    });
  }
  if (schedulerLastRunMs !== null && nowMs - schedulerLastRunMs > SCHEDULER_STALE_MS) {
    out.push({ id: 'scheduler_stale', connector: 'scheduler', title: 'Planificateur serveur arrêté', detail: 'Aucun passage depuis plus de 15 minutes : escalades, recyclage et reprises ne tournent plus.', sinceMs: schedulerLastRunMs, level: 'critical' });
  }
  const sr = statusReturnWatch(statusReturn, nowMs, schedulerLastRunMs);
  if (sr) out.push(sr);
  const stalePending = entries.filter((e) => e.status === 'pending' && nowMs - e.atMs > HOUR);
  if (stalePending.length > 0) out.push({ id: 'pending_old', connector: stalePending[0].connector, title: `${stalePending.length} opération${stalePending.length > 1 ? 's' : ''} en attente depuis plus d’une heure`, detail: 'Transmission en cours ou à reprendre.', sinceMs: Math.min(...stalePending.map((e) => e.atMs)), level: 'warning' });
  return out.sort((a, b) => (a.level === b.level ? b.sinceMs - a.sinceMs : a.level === 'critical' ? -1 : 1));
}

// ── Filtres du journal ───────────────────────────────────────────────────────

export type PeriodFilter = 'today' | '7d' | '30d' | 'all';
export const PERIOD_FILTER_LABELS: Record<PeriodFilter, string> = { today: 'Aujourd’hui', '7d': '7 derniers jours', '30d': '30 derniers jours', all: 'Tout' };

export interface JournalFilters {
  period: PeriodFilter;
  connector: ConnectorId | '';
  operation: string;
  status: EntryStatus | '';
  search: string;
}

export const NO_FILTERS: JournalFilters = { period: 'today', connector: '', operation: '', status: '', search: '' };

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function periodStart(p: PeriodFilter, nowMs: number): number {
  if (p === 'all') return 0;
  if (p === 'today') return new Date(nowMs).setHours(0, 0, 0, 0);
  return nowMs - (p === '7d' ? 7 : 30) * DAY;
}

export function filterEntries(entries: readonly JournalEntry[], f: JournalFilters, nowMs: number): JournalEntry[] {
  const from = periodStart(f.period, nowMs);
  const q = normalize(f.search);
  return entries.filter((e) => {
    if (e.atMs < from) return false;
    if (f.connector && e.connector !== f.connector) return false;
    if (f.operation && e.operation !== f.operation) return false;
    if (f.status && e.status !== f.status) return false;
    if (q && ![e.reference, e.leadId ?? '', e.id, e.sourceId, e.sourceLabel ?? ''].some((x) => normalize(x).includes(q))) return false;
    return true;
  });
}

// ── Erreurs et reprises ──────────────────────────────────────────────────────

export type Priority = 'critical' | 'to_check';
export const PRIORITY_LABELS: Record<Priority, string> = { critical: 'Critique', to_check: 'À vérifier' };

export function priorityOf(e: JournalEntry, nowMs: number): Priority {
  return (e.attempts ?? 0) >= 5 || nowMs - e.atMs > DAY || e.connector === 'crm_main' ? 'critical' : 'to_check';
}

export const ERROR_CATEGORY: Record<string, string> = {
  no_contact: 'Donnée invalide',
  unknown_source: 'Configuration',
  source_disabled: 'Configuration',
  stuck: 'Réception interrompue',
  duplicate_dossier: 'Doublon',
};
export const errorCategory = (e: JournalEntry): string => ERROR_CATEGORY[e.error?.code ?? ''] ?? 'Erreur technique';

/** Erreurs encore à traiter (onglet « À traiter ») ou résolues (onglet « Résolues »). */
export function errorList(entries: readonly JournalEntry[], tab: 'open' | 'resolved'): JournalEntry[] {
  return sortJournal(entries.filter((e) => e.status === 'error' && (tab === 'open' ? e.resolvedAtMs === null : e.resolvedAtMs !== null)));
}

export interface ErrorSummary {
  open: number;
  /** Erreurs dont la reprise est possible depuis le hub. */
  replayable: number;
  /** Erreurs critiques : tentatives épuisées, plus d'un jour, ou transmission au CRM principal. */
  critical: number;
  resolvedThisMonth: number;
}

export function errorSummary(entries: readonly JournalEntry[], nowMs: number): ErrorSummary {
  const open = entries.filter((e) => e.status === 'error' && e.resolvedAtMs === null);
  const monthStart = new Date(nowMs);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  return {
    open: open.length,
    replayable: open.filter((e) => e.replayable).length,
    critical: open.filter((e) => priorityOf(e, nowMs) === 'critical').length,
    resolvedThisMonth: entries.filter((e) => e.resolvedAtMs !== null && e.resolvedAtMs >= monthStart.getTime()).length,
  };
}

/** CSV de diagnostic : aucune charge utile, aucun secret (§24.10 « exporter un diagnostic »). */
export function diagnosticRows(entries: readonly JournalEntry[]): (string | number)[][] {
  return [
    ['Date', 'Connecteur', 'Source', 'Opération', 'Référence', 'Lead', 'Statut', 'Tentatives', 'Code erreur', 'Erreur', 'Acteur', 'Résolue le'],
    ...entries.map((e) => [new Date(e.atMs).toLocaleString('fr-FR'), CONNECTOR_LABEL[e.connector], e.sourceLabel ?? '', e.operation, e.reference, e.leadId ?? '', ENTRY_STATUS_LABELS[e.status], e.attempts ?? '', e.error?.code ?? '', e.error?.message ?? '', e.actorId ?? '', e.resolvedAtMs ? new Date(e.resolvedAtMs).toLocaleString('fr-FR') : '']),
  ];
}
