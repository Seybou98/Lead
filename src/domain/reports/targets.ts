// Objectifs et alertes KPI (§22.8, fig. 34). Fonctions pures, sans Firestore : réglages (lecture tolérante, saisie
// contrôlée), avancement d'un objectif (réalisé, projection au rythme observé, statut), évaluation des alertes.
//
// Objectif : un mois, un périmètre (tous, une campagne, un télépro, un produit), un indicateur, une cible. La
// projection est une ESTIMATION au rythme observé, jamais présentée comme un résultat. Alerte : un indicateur, un
// seuil sur sa valeur OU sur sa variation par rapport à la période précédente, et un VOLUME MINIMUM sous lequel elle
// ne se déclenche pas (§22.8 : pas de faux signal sur trois leads).

import { ratePct } from '../sales/outcome';
import type { LeadListItem } from '../leads/leadList';
import { CLOSED_LEAD_STATUSES } from '../enums';
import { countPeriod, previousRange, scopeLeads, type PeriodCounts, type ReportCampaign, type ReportFilters, type ReportSpend } from './direction';
import { waitingDossiers } from './documents';
import { slaTally } from './telepros';

const DAY = 86_400_000;

// ── Objectifs ────────────────────────────────────────────────────────────────

export const OBJECTIVE_METRICS = ['contacted', 'docsRequested', 'docsComplete', 'sales', 'costPerSale'] as const;
export type ObjectiveMetric = (typeof OBJECTIVE_METRICS)[number];
export const OBJECTIVE_METRIC_LABELS: Record<ObjectiveMetric, string> = {
  contacted: 'Contacts',
  docsRequested: 'Documents demandés',
  docsComplete: 'Dossiers complets',
  sales: 'Ventes',
  costPerSale: 'Coût par vente',
};
/** Cible à atteindre (« min ») ou à ne pas dépasser (« max »). */
export const OBJECTIVE_DIRECTION: Record<ObjectiveMetric, 'min' | 'max'> = { contacted: 'min', docsRequested: 'min', docsComplete: 'min', sales: 'min', costPerSale: 'max' };
export const OBJECTIVE_UNITS: Record<ObjectiveMetric, string> = { contacted: '', docsRequested: '', docsComplete: '', sales: '', costPerSale: '€' };

export const OBJECTIVE_SCOPES = ['global', 'campaign', 'owner', 'product'] as const;
export type ObjectiveScope = (typeof OBJECTIVE_SCOPES)[number];
export const OBJECTIVE_SCOPE_LABELS: Record<ObjectiveScope, string> = { global: 'Tous les leads', campaign: 'Campagne', owner: 'Télépro', product: 'Produit' };

export interface Objective {
  id: string;
  /** Mois visé, « AAAA-MM ». */
  month: string;
  scope: ObjectiveScope;
  /** Identifiant de la campagne, du télépro ou code du produit ; vide pour « tous les leads ». */
  scopeId: string;
  metric: ObjectiveMetric;
  /** Nombre (contacts, documents, dossiers, ventes) ou euros (coût par vente). */
  target: number;
  active: boolean;
}

// ── Alertes ──────────────────────────────────────────────────────────────────

export const ALERT_METRICS = ['costPerSale', 'costPerLead', 'contactRate', 'excludedRate', 'slaRate', 'docsConversion', 'cancelledRate', 'blockedDossiers'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export interface AlertMetricDef {
  label: string;
  /** Unité de la valeur : euros, pourcentage ou nombre. */
  unit: '€' | '%' | '';
  /** Libellé du volume minimum. */
  volumeLabel: string;
  definition: string;
  /** Une alerte sur la variation n'a pas de sens pour un stock (dossiers bloqués). */
  changeable: boolean;
}

export const ALERT_METRIC_DEFS: Record<AlertMetric, AlertMetricDef> = {
  costPerSale: { label: 'Coût par vente', unit: '€', volumeLabel: 'ventes', definition: 'Dépenses / ventes nettes de la période.', changeable: true },
  costPerLead: { label: 'Coût par lead valide', unit: '€', volumeLabel: 'leads valides', definition: 'Dépenses / leads valides (hors doublons, faux leads, exclus).', changeable: true },
  contactRate: { label: 'Taux de contact', unit: '%', volumeLabel: 'leads valides', definition: 'Leads contactés / leads valides.', changeable: true },
  excludedRate: { label: 'Leads exclus', unit: '%', volumeLabel: 'leads reçus', definition: 'Doublons, faux leads et leads exclus / leads reçus.', changeable: true },
  slaRate: { label: 'SLA respecté', unit: '%', volumeLabel: 'leads mesurés', definition: 'Leads pris en charge dans le délai du SLA / leads dont le délai est connu.', changeable: true },
  docsConversion: { label: 'Documents → complet', unit: '%', volumeLabel: 'dossiers demandés', definition: 'Dossiers complets / dossiers dont les pièces ont été demandées.', changeable: true },
  cancelledRate: { label: 'Ventes annulées', unit: '%', volumeLabel: 'ventes créées', definition: 'Ventes annulées / ventes créées (nettes + annulées).', changeable: true },
  blockedDossiers: { label: 'Dossiers bloqués', unit: '', volumeLabel: 'dossiers', definition: 'Dossiers en attente de pièces depuis plus de N jours (photographie actuelle).', changeable: false },
};

export const ALERT_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export type AlertOp = (typeof ALERT_OPS)[number];
export const ALERT_OP_LABELS: Record<AlertOp, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

export interface AlertRule {
  id: string;
  metric: AlertMetric;
  /** « Valeur » : seuil sur la valeur de la période. « Variation » : seuil sur l'écart avec la période précédente (en % pour un coût, en points pour un taux). */
  mode: 'value' | 'change';
  op: AlertOp;
  threshold: number;
  /** Volume minimum (de la période, et de la précédente en mode variation) sous lequel l'alerte ne se déclenche pas. */
  minVolume: number;
  /** Dossiers bloqués : nombre de jours d'attente. */
  days: number;
  level: 'warning' | 'critical';
  active: boolean;
}

/** Alertes d'origine : celles que le rapport Direction appliquait avant d'être réglables. */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  { id: 'a_cost_per_sale', metric: 'costPerSale', mode: 'change', op: 'gte', threshold: 20, minVolume: 3, days: 7, level: 'critical', active: true },
  { id: 'a_cost_per_lead', metric: 'costPerLead', mode: 'change', op: 'gte', threshold: 25, minVolume: 10, days: 7, level: 'warning', active: true },
  { id: 'a_contact_rate', metric: 'contactRate', mode: 'change', op: 'lte', threshold: -10, minVolume: 10, days: 7, level: 'warning', active: true },
  { id: 'a_docs_conversion', metric: 'docsConversion', mode: 'change', op: 'lte', threshold: -10, minVolume: 10, days: 7, level: 'warning', active: true },
  { id: 'a_cancelled', metric: 'cancelledRate', mode: 'value', op: 'gte', threshold: 20, minVolume: 5, days: 7, level: 'critical', active: true },
];

export interface ReportSettings {
  alerts: AlertRule[];
  objectives: Objective[];
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = { alerts: DEFAULT_ALERT_RULES.map((r) => ({ ...r })), objectives: [] };

export const MAX_ALERTS = 30;
export const MAX_OBJECTIVES = 100;
export const ALERT_ID = /^a_[a-z0-9_]{1,40}$/;
export const OBJECTIVE_ID = /^o_[a-z0-9_]{1,40}$/;
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 80): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function alertFrom(raw: unknown): AlertRule | null {
  const x = rec(raw);
  const metric = ALERT_METRICS.find((m) => m === x.metric);
  const op = ALERT_OPS.find((o) => o === x.op);
  const id = typeof x.id === 'string' ? x.id : '';
  if (!metric || !op || !ALERT_ID.test(id) || typeof x.threshold !== 'number' || !Number.isFinite(x.threshold)) return null;
  return {
    id,
    metric,
    mode: x.mode === 'change' && ALERT_METRIC_DEFS[metric].changeable ? 'change' : 'value',
    op,
    threshold: x.threshold,
    minVolume: Math.max(0, Math.round(num(x.minVolume, 0))),
    days: Math.min(60, Math.max(1, Math.round(num(x.days, 7)))),
    level: x.level === 'critical' ? 'critical' : 'warning',
    active: x.active !== false,
  };
}

function objectiveFrom(raw: unknown): Objective | null {
  const x = rec(raw);
  const metric = OBJECTIVE_METRICS.find((m) => m === x.metric);
  const scope = OBJECTIVE_SCOPES.find((s) => s === x.scope);
  const id = typeof x.id === 'string' ? x.id : '';
  const month = typeof x.month === 'string' ? x.month : '';
  if (!metric || !scope || !OBJECTIVE_ID.test(id) || !MONTH.test(month) || typeof x.target !== 'number' || !Number.isFinite(x.target)) return null;
  const scopeId = scope === 'global' ? '' : str(x.scopeId, 128);
  if (scope !== 'global' && !scopeId) return null;
  return { id, month, scope, scopeId, metric, target: x.target, active: x.active !== false };
}

/** Lecture tolérante de `cl_settings/reports` : ce qui est mal formé est ignoré ; rien d'enregistré = alertes d'origine, aucun objectif. */
export function parseReportSettings(raw: unknown): ReportSettings {
  const r = rec(raw);
  if (!Array.isArray(r.alerts) && !Array.isArray(r.objectives)) return { alerts: DEFAULT_REPORT_SETTINGS.alerts.map((a) => ({ ...a })), objectives: [] };
  const seen = new Set<string>();
  const alerts: AlertRule[] = [];
  for (const a of Array.isArray(r.alerts) ? r.alerts : []) {
    const n = alertFrom(a);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      alerts.push(n);
    }
    if (alerts.length >= MAX_ALERTS) break;
  }
  const oseen = new Set<string>();
  const objectives: Objective[] = [];
  for (const o of Array.isArray(r.objectives) ? r.objectives : []) {
    const n = objectiveFrom(o);
    if (n && !oseen.has(n.id)) {
      oseen.add(n.id);
      objectives.push(n);
    }
    if (objectives.length >= MAX_OBJECTIVES) break;
  }
  return { alerts, objectives };
}

/** Saisie de l'écran : mêmes champs, types contrôlés, rien n'est corrigé en silence (la validation dit ce qui ne va pas). */
export function coerceReportInput(raw: unknown): ReportSettings {
  const r = rec(raw);
  const alerts = (Array.isArray(r.alerts) ? r.alerts : []).map((a): AlertRule => {
    const x = rec(a);
    return {
      id: str(x.id, 60),
      metric: x.metric as AlertMetric,
      mode: x.mode === 'change' ? 'change' : 'value',
      op: x.op as AlertOp,
      threshold: typeof x.threshold === 'number' ? x.threshold : Number.NaN,
      minVolume: typeof x.minVolume === 'number' ? x.minVolume : Number.NaN,
      days: typeof x.days === 'number' ? x.days : 7,
      level: x.level === 'critical' ? 'critical' : 'warning',
      active: x.active === true,
    };
  });
  const objectives = (Array.isArray(r.objectives) ? r.objectives : []).map((o): Objective => {
    const x = rec(o);
    return { id: str(x.id, 60), month: str(x.month, 7), scope: x.scope as ObjectiveScope, scopeId: str(x.scopeId, 128), metric: x.metric as ObjectiveMetric, target: typeof x.target === 'number' ? x.target : Number.NaN, active: x.active === true };
  });
  return { alerts, objectives };
}

export function validateReportSettings(s: ReportSettings): string[] {
  const e: string[] = [];
  if (s.alerts.length > MAX_ALERTS) e.push(`Alertes : ${MAX_ALERTS} au plus.`);
  if (s.objectives.length > MAX_OBJECTIVES) e.push(`Objectifs : ${MAX_OBJECTIVES} au plus.`);
  const ids = new Set<string>();
  for (const a of s.alerts) {
    const name = ALERT_METRIC_DEFS[a.metric]?.label ?? 'Alerte';
    if (!ALERT_ID.test(a.id) || ids.has(a.id)) e.push(`${name} : identifiant d'alerte invalide ou en double.`);
    ids.add(a.id);
    if (!ALERT_METRIC_DEFS[a.metric]) { e.push('Alerte : indicateur inconnu.'); continue; }
    if (!ALERT_OPS.includes(a.op)) e.push(`${name} : comparaison inconnue.`);
    if (!Number.isFinite(a.threshold)) e.push(`${name} : le seuil doit être un nombre.`);
    if (!Number.isInteger(a.minVolume) || a.minVolume < 0 || a.minVolume > 100_000) e.push(`${name} : le volume minimum est un nombre entier positif ou nul.`);
    if (a.mode === 'change' && !ALERT_METRIC_DEFS[a.metric].changeable) e.push(`${name} : une variation n'a pas de sens pour cet indicateur.`);
    if (a.metric === 'blockedDossiers' && (!Number.isInteger(a.days) || a.days < 1 || a.days > 60)) e.push(`${name} : l'attente est de 1 à 60 jours.`);
    if (ALERT_METRIC_DEFS[a.metric].unit === '%' && a.mode === 'value' && (a.threshold < 0 || a.threshold > 100)) e.push(`${name} : un taux se règle entre 0 et 100 %.`);
  }
  const oids = new Set<string>();
  const keys = new Set<string>();
  for (const o of s.objectives) {
    if (!OBJECTIVE_ID.test(o.id) || oids.has(o.id)) e.push("Objectif : identifiant invalide ou en double.");
    oids.add(o.id);
    const name = OBJECTIVE_METRIC_LABELS[o.metric];
    if (!name) { e.push('Objectif : indicateur inconnu.'); continue; }
    if (!OBJECTIVE_SCOPES.includes(o.scope)) { e.push(`${name} : périmètre inconnu.`); continue; }
    if (!MONTH.test(o.month)) e.push(`${name} : le mois doit être au format AAAA-MM.`);
    if (o.scope !== 'global' && !o.scopeId) e.push(`${name} : choisissez ${o.scope === 'campaign' ? 'la campagne' : o.scope === 'owner' ? 'le télépro' : 'le produit'}.`);
    if (!Number.isFinite(o.target) || o.target <= 0) e.push(`${name} : la cible doit être un nombre supérieur à 0.`);
    if (OBJECTIVE_DIRECTION[o.metric] === 'min' && !Number.isInteger(o.target)) e.push(`${name} : la cible est un nombre entier.`);
    if (o.metric === 'costPerSale' && o.scope === 'owner') e.push('Coût par vente : une dépense ne se rattache pas à un télépro, fixez cet objectif par campagne, par produit ou pour tous les leads.');
    const key = `${o.month}|${o.scope}|${o.scopeId}|${o.metric}`;
    if (keys.has(key)) e.push(`${name} : un objectif existe déjà pour ce mois et ce périmètre.`);
    keys.add(key);
  }
  return [...new Set(e)];
}

/** Forme enregistrée : le minimum, sans valeur invalide. */
export function toStoredReports(s: ReportSettings): { alerts: AlertRule[]; objectives: Objective[] } {
  return { alerts: s.alerts.map((a) => ({ ...a })), objectives: s.objectives.map((o) => ({ ...o })) };
}

export function newTargetId(prefix: 'a' | 'o', taken: ReadonlySet<string>): string {
  for (let i = taken.size + 1; ; i++) {
    const id = `${prefix}_${i}`;
    if (!taken.has(id)) return id;
  }
}

// ── Avancement d'un objectif ─────────────────────────────────────────────────

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Bornes du mois (fuseau du navigateur), la fin est exclue. */
export function monthRange(month: string): { fromMs: number; toMs: number } {
  const [y, m] = month.split('-').map(Number);
  return { fromMs: new Date(y, m - 1, 1).getTime(), toMs: new Date(y, m, 1).getTime() };
}

export type ObjectiveStatus = 'achieved' | 'on_track' | 'at_risk' | 'behind' | 'missed' | 'upcoming' | 'na';
export const OBJECTIVE_STATUS_LABELS: Record<ObjectiveStatus, string> = {
  achieved: 'Atteint',
  on_track: 'En bonne voie',
  at_risk: 'À risque',
  behind: 'En retard',
  missed: 'Non atteint',
  upcoming: 'À venir',
  na: 'Non calculable',
};

export interface ObjectiveProgress {
  objective: Objective;
  /** Réalisé : nombre, ou euros pour le coût par vente ; null si non calculable. */
  actual: number | null;
  /** Réalisé / cible en % (pour un coût : cible / réalisé). */
  pct: number | null;
  /** Estimation de fin de mois au rythme observé ; null hors mois en cours ou pour un coût. */
  projected: number | null;
  status: ObjectiveStatus;
  /** Part du mois écoulée (%). */
  elapsedPct: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function actualOf(metric: ObjectiveMetric, c: PeriodCounts): number | null {
  switch (metric) {
    case 'contacted': return c.counts.contacted;
    case 'docsRequested': return c.counts.docsRequested;
    case 'docsComplete': return c.counts.docsComplete;
    case 'sales': return c.counts.sales;
    case 'costPerSale': return c.spendCents !== null && c.counts.sales > 0 ? Math.round(c.spendCents / c.counts.sales) / 100 : null;
  }
}

/** Mesure d'un objectif sur les leads fournis : même règle de comptage que les rapports (mode événement). */
export function objectiveProgress(o: Objective, args: { leads: readonly LeadListItem[]; spends: readonly ReportSpend[]; campaigns: readonly ReportCampaign[]; nowMs: number }): ObjectiveProgress {
  const { fromMs, toMs } = monthRange(o.month);
  const scope = { sourceId: '', campaignId: o.scope === 'campaign' ? o.scopeId : '', product: o.scope === 'product' ? o.scopeId : '', owner: o.scope === 'owner' ? o.scopeId : '' };
  const f: ReportFilters = { fromMs, toMs, mode: 'event', ...scope };
  const counts = countPeriod(scopeLeads(args.leads, scope, args.campaigns), args.spends, args.campaigns, f, fromMs, toMs);
  const actual = actualOf(o.metric, counts);
  const elapsedPct = args.nowMs >= toMs ? 100 : args.nowMs <= fromMs ? 0 : round1(((args.nowMs - fromMs) / (toMs - fromMs)) * 100);
  const base = { objective: o, actual, elapsedPct };

  if (args.nowMs < fromMs) return { ...base, pct: null, projected: null, status: 'upcoming' };
  if (OBJECTIVE_DIRECTION[o.metric] === 'max') {
    if (actual === null) return { ...base, pct: null, projected: null, status: 'na' };
    const pct = actual > 0 ? round1((o.target / actual) * 100) : null;
    const over = actual / o.target;
    return { ...base, pct, projected: null, status: actual <= o.target ? (args.nowMs >= toMs ? 'achieved' : 'on_track') : args.nowMs >= toMs ? 'missed' : over <= 1.2 ? 'at_risk' : 'behind' };
  }
  const value = actual ?? 0;
  const pct = round1((value / o.target) * 100);
  if (value >= o.target) return { ...base, pct, projected: null, status: 'achieved' };
  if (args.nowMs >= toMs) return { ...base, pct, projected: null, status: 'missed' };
  const elapsedDays = Math.max(1, Math.ceil((args.nowMs - fromMs) / DAY));
  const totalDays = Math.max(1, Math.round((toMs - fromMs) / DAY));
  const projected = Math.round((value / elapsedDays) * totalDays);
  const ratio = projected / o.target;
  return { ...base, pct, projected, status: ratio >= 0.95 ? 'on_track' : ratio >= 0.7 ? 'at_risk' : 'behind' };
}

/** Objectifs actifs d'un mois pour un périmètre donné (filtres du rapport). */
export function objectivesFor(objectives: readonly Objective[], month: string, filters: { sourceId?: string; campaignId?: string; product?: string; owner?: string }): Objective[] {
  const active = objectives.filter((o) => o.active && o.month === month);
  const picks = [filters.campaignId && 'campaign', filters.product && 'product', filters.owner && 'owner'].filter(Boolean);
  if (filters.sourceId || picks.length > 1) return [];
  if (picks.length === 0) return active.filter((o) => o.scope === 'global');
  const scope = picks[0] as ObjectiveScope;
  const id = scope === 'campaign' ? filters.campaignId : scope === 'product' ? filters.product : filters.owner;
  return active.filter((o) => o.scope === scope && o.scopeId === id);
}

/** Le rapport couvre-t-il exactement un mois civil ? Renvoie sa clé, sinon null (les objectifs se lisent par mois). */
export function singleMonthOf(f: { fromMs: number; toMs: number }): string | null {
  const key = monthKey(f.fromMs);
  const r = monthRange(key);
  return r.fromMs === f.fromMs && r.toMs === f.toMs ? key : null;
}

// ── Alertes ──────────────────────────────────────────────────────────────────

export interface SlaTallyLike {
  measured: number;
  respected: number;
}

export interface AlertInputs {
  cur: PeriodCounts;
  prev: PeriodCounts;
  sla: SlaTallyLike;
  prevSla: SlaTallyLike;
  /** Dossiers en attente de pièces depuis plus de N jours : nombre par durée demandée. */
  blocked: (days: number) => number;
}

export interface KpiAlert {
  id: string;
  level: 'critical' | 'warning' | 'ok';
  title: string;
  detail: string;
  /** Indicateur et règle à l'origine de l'alerte (absent pour « aucune alerte »). */
  metric?: AlertMetric;
  /** Valeur mesurée, pour l'afficher à côté du seuil. */
  value?: number;
  volume?: number;
  /** Dossiers bloqués : durée d'attente de la règle, pour ouvrir la liste correspondante. */
  days?: number;
}

function measure(metric: AlertMetric, c: PeriodCounts, sla: SlaTallyLike): { value: number | null; volume: number } {
  switch (metric) {
    case 'costPerSale': return { value: c.spendCents !== null && c.counts.sales > 0 ? c.spendCents / c.counts.sales / 100 : null, volume: c.counts.sales };
    case 'costPerLead': return { value: c.spendCents !== null && c.counts.valid > 0 ? c.spendCents / c.counts.valid / 100 : null, volume: c.counts.valid };
    case 'contactRate': return { value: ratePct(c.counts.contacted, c.counts.valid), volume: c.counts.valid };
    case 'excludedRate': return { value: ratePct(c.counts.received - c.counts.valid, c.counts.received), volume: c.counts.received };
    case 'slaRate': return { value: ratePct(sla.respected, sla.measured), volume: sla.measured };
    case 'docsConversion': return { value: ratePct(c.counts.docsComplete, c.counts.docsRequested), volume: c.counts.docsRequested };
    case 'cancelledRate': return { value: ratePct(c.cancelled, c.counts.sales + c.cancelled), volume: c.counts.sales + c.cancelled };
    case 'blockedDossiers': return { value: null, volume: 0 };
  }
}

const compare = (v: number, op: AlertOp, t: number) => (op === 'gt' ? v > t : op === 'gte' ? v >= t : op === 'lt' ? v < t : v <= t);
const fmt = (n: number, unit: AlertMetricDef['unit']) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: unit === '€' ? 2 : 1 })}${unit === '€' ? ' €' : unit === '%' ? ' %' : ''}`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}`;

/** Texte lisible d'une règle : « Coût par vente > 500 € ET au moins 10 ventes ». */
export function ruleText(r: AlertRule): string {
  const d = ALERT_METRIC_DEFS[r.metric];
  if (r.metric === 'blockedDossiers') return `${d.label} : plus de ${r.days} jours d'attente, au moins ${r.threshold} dossier${r.threshold > 1 ? 's' : ''}`;
  const unit = r.mode === 'change' ? (d.unit === '€' ? '%' : 'pts') : d.unit;
  const what = r.mode === 'change' ? `variation du ${d.label.toLowerCase()}` : d.label;
  const t = `${r.threshold.toLocaleString('fr-FR')}${unit === 'pts' ? ' pts' : unit === '' ? '' : unit === '€' ? ' €' : ' %'}`;
  return `${what} ${ALERT_OP_LABELS[r.op]} ${t}${r.minVolume > 0 ? ` ET au moins ${r.minVolume} ${d.volumeLabel}` : ''}`;
}

/**
 * Alertes déclenchées. Une règle inactive est ignorée ; une valeur non calculable ou un volume insuffisant ne
 * déclenchent jamais (§22.8). S'il n'y en a aucune, une seule ligne « Aucune alerte » le dit.
 */
export function evaluateAlerts(rules: readonly AlertRule[], i: AlertInputs): KpiAlert[] {
  const out: KpiAlert[] = [];
  for (const r of rules) {
    if (!r.active) continue;
    const d = ALERT_METRIC_DEFS[r.metric];
    if (r.metric === 'blockedDossiers') {
      const n = i.blocked(r.days);
      if (compare(n, r.op, r.threshold) && n > 0) out.push({ id: r.id, level: r.level, metric: r.metric, value: n, volume: n, days: r.days, title: `${n} dossier${n > 1 ? 's' : ''} en attente depuis plus de ${r.days} jours`, detail: `Seuil : ${ruleText(r)}.` });
      continue;
    }
    const cur = measure(r.metric, i.cur, i.sla);
    if (cur.value === null || cur.volume < r.minVolume) continue;
    if (r.mode === 'value') {
      if (compare(cur.value, r.op, r.threshold)) out.push({ id: r.id, level: r.level, metric: r.metric, value: cur.value, volume: cur.volume, title: `${d.label} : ${fmt(cur.value, d.unit)}`, detail: `Seuil : ${ruleText(r)}. ${cur.volume} ${d.volumeLabel} sur la période.` });
      continue;
    }
    const prev = measure(r.metric, i.prev, i.prevSla);
    if (prev.value === null || prev.volume < r.minVolume) continue;
    // Coût : variation relative ; taux : écart en points. Une base nulle ne permet pas de variation relative.
    const delta = d.unit === '€' ? (prev.value === 0 ? null : Math.round(((cur.value - prev.value) / prev.value) * 1000) / 10) : Math.round((cur.value - prev.value) * 10) / 10;
    if (delta === null || !compare(delta, r.op, r.threshold)) continue;
    out.push({
      id: r.id,
      level: r.level,
      metric: r.metric,
      value: cur.value,
      volume: cur.volume,
      title: `${d.label} ${signed(delta)} ${d.unit === '€' ? '%' : 'pts'}`,
      detail: `${fmt(cur.value, d.unit)} contre ${fmt(prev.value, d.unit)} la période précédente (${cur.volume} contre ${prev.volume} ${d.volumeLabel}).`,
    });
  }
  if (out.length === 0) out.push({ id: 'ok', level: 'ok', title: 'Aucune alerte', detail: rules.some((r) => r.active) ? 'Aucun seuil dépassé, ou volume trop faible pour conclure.' : 'Aucune alerte n’est activée : réglez-les dans Paramètres → Objectifs et alertes.' });
  return out;
}

/**
 * Données d'évaluation des alertes pour un rapport : volumes de la période et de la précédente (déjà comptés par le
 * rapport Direction), SLA des deux périodes, et dossiers bloqués du périmètre. Même périmètre que les cartes affichées.
 */
export function alertInputs(args: {
  current: PeriodCounts;
  previous: PeriodCounts;
  leads: readonly LeadListItem[];
  campaigns: readonly ReportCampaign[];
  filters: ReportFilters;
  nowMs: number;
  slaMs: number;
  elapsed?: (fromMs: number, toMs: number) => number;
}): AlertInputs {
  const elapsed = args.elapsed ?? ((a, b) => Math.max(0, b - a));
  const scoped = scopeLeads(args.leads, args.filters, args.campaigns);
  const prevR = previousRange(args.filters);
  const live = scoped.filter((l) => !l.duplicate && !l.excluded && l.status !== 'fake_lead' && !CLOSED_LEAD_STATUSES.includes(l.status));
  return {
    cur: args.current,
    prev: args.previous,
    sla: slaTally(scoped, args.filters, args.nowMs, args.slaMs, elapsed),
    prevSla: slaTally(scoped, prevR, args.nowMs, args.slaMs, elapsed),
    blocked: (days) => waitingDossiers(live, args.nowMs, days).length,
  };
}
