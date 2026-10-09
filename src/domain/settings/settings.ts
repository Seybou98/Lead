// Paramétrage administrateur (§14, §19.4, fig. 18) : SLA et horaires, cycles NR, rappels et relances documentaires.
// Fonctions PURES : lecture tolérante d'un document de configuration, validation (écran), valeurs effectives. L'écran,
// le serveur (qualification, documents, planificateur, ingestion) et le navigateur (compteurs) lisent TOUS la même
// définition, donc une valeur affichée à l'administrateur est celle qui s'applique réellement.

import type { WorkSlotLike } from '../engine/schedule';
import { parseHHmm } from '../engine/schedule';
import { DEFAULT_CONVERSION_RULES, type ConversionRules } from '../conversion/controls';

const MIN = 1;

// ── SLA et horaires (fig. 18) ────────────────────────────────────────────────

export const OUTSIDE_HOURS = ['hold', 'immediate', 'duty_team'] as const;
export type OutsideHours = (typeof OUTSIDE_HOURS)[number];
export const OUTSIDE_HOURS_LABELS: Record<OutsideHours, string> = {
  immediate: 'Attribuer immédiatement',
  hold: "Mettre en attente jusqu'à l'ouverture",
  duty_team: "Affecter à l'équipe de garde",
};

export interface SlaSettings {
  /** Première alerte (+5 min par défaut) : c'est aussi le délai du SLA de prise en charge. */
  firstAlertMin: number;
  /** Retard critique (+10 min) : alerte rouge. */
  criticalMin: number;
  /** Réattribution (+15 min), si elle est activée. */
  reassignMin: number;
  autoReassign: boolean;
  maxReassignments: number;
  fallbackTeamId: string | null;
  /** Le temps hors horaires ne compte pas comme retard du télépro (§19.4, valeur par défaut du cahier). */
  suspendOutsideHours: boolean;
  outsideHours: OutsideHours;
  schedule: { timezone: string; weekly: WorkSlotLike[]; closedDates: string[] };
}

export const DEFAULT_SLA_SETTINGS: SlaSettings = {
  firstAlertMin: 5,
  criticalMin: 10,
  reassignMin: 15,
  autoReassign: false,
  maxReassignments: 2,
  fallbackTeamId: null,
  suspendOutsideHours: true,
  outsideHours: 'hold',
  schedule: { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })), closedDates: [] },
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback);
const HHMM = /^(\d{1,2}):(\d{2})$/;

function validSlot(s: unknown): s is WorkSlotLike {
  const x = rec(s);
  if (typeof x.day !== 'number' || !Number.isInteger(x.day) || x.day < 0 || x.day > 6) return false;
  if (typeof x.start !== 'string' || typeof x.end !== 'string' || !HHMM.test(x.start) || !HHMM.test(x.end)) return false;
  try {
    return parseHHmm(x.start) < parseHHmm(x.end);
  } catch {
    return false;
  }
}

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isRealDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Lecture tolérante : toute valeur absente ou invalide retombe sur le défaut, jamais d'exception. */
export function parseSlaSettings(raw: unknown): SlaSettings {
  const d = DEFAULT_SLA_SETTINGS;
  const r = rec(raw);
  const sched = rec(r.schedule);
  const weekly = Array.isArray(sched.weekly) ? sched.weekly.filter(validSlot) : [];
  const tz = typeof sched.timezone === 'string' && isValidTimezone(sched.timezone) ? sched.timezone : d.schedule.timezone;
  return {
    firstAlertMin: num(r.firstAlertMin, d.firstAlertMin, 1, 240),
    criticalMin: num(r.criticalMin, d.criticalMin, 1, 480),
    reassignMin: num(r.reassignMin, d.reassignMin, 1, 960),
    autoReassign: r.autoReassign === true,
    maxReassignments: num(r.maxReassignments, d.maxReassignments, 0, 10),
    fallbackTeamId: typeof r.fallbackTeamId === 'string' && r.fallbackTeamId ? r.fallbackTeamId : null,
    suspendOutsideHours: typeof r.suspendOutsideHours === 'boolean' ? r.suspendOutsideHours : d.suspendOutsideHours,
    outsideHours: (OUTSIDE_HOURS as readonly unknown[]).includes(r.outsideHours) ? (r.outsideHours as OutsideHours) : d.outsideHours,
    schedule: {
      timezone: tz,
      weekly: weekly.length > 0 ? weekly.map((s) => ({ day: s.day, start: s.start, end: s.end })) : d.schedule.weekly,
      closedDates: Array.isArray(sched.closedDates) ? [...new Set(sched.closedDates.filter((x): x is string => typeof x === 'string' && isRealDate(x)))].sort() : [],
    },
  };
}

/** Erreurs d'une saisie (liste vide = enregistrable). Messages lisibles tels quels par l'administrateur. */
export function validateSlaSettings(s: SlaSettings): string[] {
  const e: string[] = [];
  const int = (v: number) => Number.isInteger(v);
  if (!int(s.firstAlertMin) || s.firstAlertMin < 1) e.push('La première alerte doit être d’au moins 1 minute.');
  if (!(s.criticalMin > s.firstAlertMin)) e.push('Le retard critique doit venir après la première alerte.');
  if (!(s.reassignMin > s.criticalMin)) e.push('La réattribution doit venir après le retard critique.');
  if (s.reassignMin > 960 || s.criticalMin > 480 || s.firstAlertMin > 240) e.push('Délais trop longs : 4 h, 8 h et 16 h au maximum.');
  if (!int(s.maxReassignments) || s.maxReassignments < 0 || s.maxReassignments > 10) e.push('Le nombre maximal de réattributions va de 0 à 10.');
  if (!(OUTSIDE_HOURS as readonly string[]).includes(s.outsideHours)) e.push('Choisissez le comportement hors horaires.');
  if (s.outsideHours === 'duty_team' && !s.fallbackTeamId) e.push("« Affecter à l'équipe de garde » demande une équipe de secours.");
  if (s.autoReassign && s.maxReassignments > 0 && !s.fallbackTeamId) {
    // Pas bloquant : sans équipe de secours, seule l'équipe habituelle peut recevoir le lead.
  }
  if (!isValidTimezone(s.schedule.timezone)) e.push('Fuseau horaire inconnu.');
  if (s.schedule.weekly.length === 0) e.push('Ajoutez au moins une plage d’ouverture.');
  for (const slot of s.schedule.weekly) {
    if (!validSlot(slot)) e.push('Une plage horaire est invalide : le début doit précéder la fin (HH:mm).');
  }
  const byDay = new Map<number, [number, number][]>();
  for (const slot of s.schedule.weekly.filter(validSlot)) byDay.set(slot.day, [...(byDay.get(slot.day) ?? []), [parseHHmm(slot.start), parseHHmm(slot.end)]]);
  for (const ranges of byDay.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((r, i) => i > 0 && r[0] < ranges[i - 1][1])) e.push('Deux plages se chevauchent le même jour.');
  }
  for (const d of s.schedule.closedDates) if (!isRealDate(d)) e.push(`Date fermée invalide : ${d}.`);
  return [...new Set(e)];
}

/** Règles propres à une campagne (§19.4 : « configurables par campagne ») : seulement la réattribution. */
export interface SlaOverride {
  autoReassign?: boolean;
  reassignMin?: number;
  maxReassignments?: number;
  fallbackTeamId?: string | null;
}

export function parseSlaOverride(raw: unknown): SlaOverride {
  const r = rec(raw);
  const out: SlaOverride = {};
  if (typeof r.autoReassign === 'boolean') out.autoReassign = r.autoReassign;
  if (typeof r.reassignMin === 'number' && r.reassignMin >= 1 && r.reassignMin <= 960) out.reassignMin = r.reassignMin;
  if (typeof r.maxReassignments === 'number' && Number.isInteger(r.maxReassignments) && r.maxReassignments >= 0 && r.maxReassignments <= 10) out.maxReassignments = r.maxReassignments;
  if (r.fallbackTeamId === null || typeof r.fallbackTeamId === 'string') out.fallbackTeamId = (r.fallbackTeamId as string | null) || null;
  return out;
}

/** Réglages appliqués à une campagne : les réglages généraux, surchargés par ceux de la campagne. */
export function effectiveSla(global: SlaSettings, override: SlaOverride | null | undefined): SlaSettings {
  if (!override) return global;
  return {
    ...global,
    ...(override.autoReassign !== undefined ? { autoReassign: override.autoReassign } : {}),
    ...(override.reassignMin !== undefined ? { reassignMin: Math.max(override.reassignMin, global.criticalMin + MIN) } : {}),
    ...(override.maxReassignments !== undefined ? { maxReassignments: override.maxReassignments } : {}),
    ...(override.fallbackTeamId !== undefined ? { fallbackTeamId: override.fallbackTeamId } : {}),
  };
}

// ── Cycles NR, rappels, documents (§8, §10.4, §14) ───────────────────────────

export interface RulesSettings {
  /** Délai avant NR2, NR3, NR4, NR5 (minutes), ramené aux horaires. */
  nrDelaysMinutes: [number, number, number, number];
  recycleAfterDays: number;
  /** Après ce nombre de cycles NR5 sans réponse : « Injoignable / archivé ». */
  maxRecycleCycles: number;
  /** Jours, depuis la demande, des relances documentaires puis de la décision (J+1, J+3, J+5, J+7, J+14). */
  followUpDays: number[];
  decisionRepeatDays: number;
  promisedMarginMinutes: number;
  callbackEscalationMin: number;
  bufferWarnMin: number;
  bufferAnomalyHours: number;
}

export const DEFAULT_RULES_SETTINGS: RulesSettings = {
  nrDelaysMinutes: [180, 24 * 60, 24 * 60, 48 * 60],
  recycleAfterDays: 7,
  maxRecycleCycles: 3,
  followUpDays: [1, 3, 5, 7, 14],
  decisionRepeatDays: 7,
  promisedMarginMinutes: 30,
  callbackEscalationMin: 30,
  bufferWarnMin: 15,
  bufferAnomalyHours: 24,
};

const increasing = (a: readonly number[]) => a.every((x, i) => i === 0 || x > a[i - 1]);

export function parseRulesSettings(raw: unknown): RulesSettings {
  const d = DEFAULT_RULES_SETTINGS;
  const r = rec(raw);
  const nr = Array.isArray(r.nrDelaysMinutes) && r.nrDelaysMinutes.length === 4 && r.nrDelaysMinutes.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 1 && x <= 60 * 24 * 30) ? (r.nrDelaysMinutes as number[]) : d.nrDelaysMinutes;
  const days = Array.isArray(r.followUpDays) && r.followUpDays.length >= 2 && r.followUpDays.length <= 8 && r.followUpDays.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 120) && increasing(r.followUpDays as number[]) ? (r.followUpDays as number[]) : d.followUpDays;
  return {
    nrDelaysMinutes: [nr[0], nr[1], nr[2], nr[3]],
    recycleAfterDays: num(r.recycleAfterDays, d.recycleAfterDays, 1, 365),
    maxRecycleCycles: num(r.maxRecycleCycles, d.maxRecycleCycles, 1, 10),
    followUpDays: [...days],
    decisionRepeatDays: num(r.decisionRepeatDays, d.decisionRepeatDays, 1, 60),
    promisedMarginMinutes: num(r.promisedMarginMinutes, d.promisedMarginMinutes, 0, 24 * 60),
    callbackEscalationMin: num(r.callbackEscalationMin, d.callbackEscalationMin, 1, 24 * 60),
    bufferWarnMin: num(r.bufferWarnMin, d.bufferWarnMin, 1, 24 * 60),
    bufferAnomalyHours: num(r.bufferAnomalyHours, d.bufferAnomalyHours, 1, 24 * 30),
  };
}

export function validateRulesSettings(s: RulesSettings): string[] {
  const e: string[] = [];
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  s.nrDelaysMinutes.forEach((m, i) => {
    if (!inRange(m, 1, 60 * 24 * 30)) e.push(`Délai avant NR${i + 2} : entre 1 minute et 30 jours.`);
  });
  if (!inRange(s.recycleAfterDays, 1, 365) || !Number.isInteger(s.recycleAfterDays)) e.push('Délai de recyclage : entre 1 et 365 jours.');
  if (!inRange(s.maxRecycleCycles, 1, 10) || !Number.isInteger(s.maxRecycleCycles)) e.push('Nombre de cycles : entre 1 et 10.');
  if (s.followUpDays.length < 2 || s.followUpDays.length > 8) e.push('Relances documentaires : entre 2 et 8 échéances (la dernière est la décision).');
  if (!s.followUpDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 120)) e.push('Échéances documentaires : des jours entiers entre 1 et 120.');
  else if (!increasing(s.followUpDays)) e.push('Les échéances documentaires doivent être croissantes.');
  if (!inRange(s.decisionRepeatDays, 1, 60) || !Number.isInteger(s.decisionRepeatDays)) e.push('Délai entre deux décisions : entre 1 et 60 jours.');
  if (!inRange(s.promisedMarginMinutes, 0, 24 * 60)) e.push('Marge « documents promis » : entre 0 et 1440 minutes.');
  if (!inRange(s.callbackEscalationMin, 1, 24 * 60)) e.push('Alerte manager « rappel non effectué » : entre 1 et 1440 minutes.');
  if (!inRange(s.bufferWarnMin, 1, 24 * 60)) e.push('Alerte « lead non attribué » : entre 1 et 1440 minutes.');
  if (!inRange(s.bufferAnomalyHours, 1, 24 * 30) || s.bufferAnomalyHours * 60 <= s.bufferWarnMin) e.push('L’anomalie « non attribué » doit venir après l’alerte.');
  return [...new Set(e)];
}

/** Durée lisible : « 3 h », « 1 jour », « 2 jours », « 45 min ». */
export function formatDelay(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return `${d} jour${d > 1 ? 's' : ''}`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

// ── Saisie de l'écran → réglages (sans valeur de repli : une erreur de saisie se voit, elle ne se corrige pas en silence) ──

const asNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);

export function coerceSlaInput(raw: unknown): SlaSettings {
  const r = rec(raw);
  const sched = rec(r.schedule);
  return {
    firstAlertMin: asNumber(r.firstAlertMin),
    criticalMin: asNumber(r.criticalMin),
    reassignMin: asNumber(r.reassignMin),
    autoReassign: r.autoReassign === true,
    maxReassignments: asNumber(r.maxReassignments),
    fallbackTeamId: typeof r.fallbackTeamId === 'string' && r.fallbackTeamId ? r.fallbackTeamId : null,
    suspendOutsideHours: r.suspendOutsideHours === true,
    outsideHours: (OUTSIDE_HOURS as readonly unknown[]).includes(r.outsideHours) ? (r.outsideHours as OutsideHours) : ('invalid' as OutsideHours),
    schedule: {
      timezone: typeof sched.timezone === 'string' ? sched.timezone : '',
      weekly: Array.isArray(sched.weekly) ? sched.weekly.map((s) => ({ day: asNumber(rec(s).day), start: String(rec(s).start ?? ''), end: String(rec(s).end ?? '') })) : [],
      closedDates: Array.isArray(sched.closedDates) ? sched.closedDates.map((d) => String(d)) : [],
    },
  };
}

export function coerceRulesInput(raw: unknown): RulesSettings {
  const r = rec(raw);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(asNumber) : []);
  const nr = list(r.nrDelaysMinutes);
  return {
    nrDelaysMinutes: [nr[0] ?? Number.NaN, nr[1] ?? Number.NaN, nr[2] ?? Number.NaN, nr[3] ?? Number.NaN],
    recycleAfterDays: asNumber(r.recycleAfterDays),
    maxRecycleCycles: asNumber(r.maxRecycleCycles),
    followUpDays: list(r.followUpDays),
    decisionRepeatDays: asNumber(r.decisionRepeatDays),
    promisedMarginMinutes: asNumber(r.promisedMarginMinutes),
    callbackEscalationMin: asNumber(r.callbackEscalationMin),
    bufferWarnMin: asNumber(r.bufferWarnMin),
    bufferAnomalyHours: asNumber(r.bufferAnomalyHours),
  };
}

// ── Conversion : verrous et exceptions (§11.2, §11.6, §14, fig. 29) ──────────

/** Les mêmes règles que celles qu'évalue le montage du dossier : une valeur affichée ici est celle qui s'applique. */
export type ConversionSettings = ConversionRules;
export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = DEFAULT_CONVERSION_RULES;

export function parseConversionSettings(raw: unknown): ConversionSettings {
  const d = DEFAULT_CONVERSION_SETTINGS;
  const r = rec(raw);
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    maxDiscountPct: num(r.maxDiscountPct, d.maxDiscountPct, 0, 100),
    requireEligibility: flag(r.requireEligibility, d.requireEligibility),
    requireRge: flag(r.requireRge, d.requireRge),
    requireConsent: flag(r.requireConsent, d.requireConsent),
  };
}

export function validateConversionSettings(s: ConversionSettings): string[] {
  const e: string[] = [];
  if (!Number.isFinite(s.maxDiscountPct) || s.maxDiscountPct < 0 || s.maxDiscountPct > 100) e.push('Remise maximale sans validation : entre 0 et 100 % du prix TTC.');
  return e;
}

export function coerceConversionInput(raw: unknown): ConversionSettings {
  const r = rec(raw);
  return {
    maxDiscountPct: asNumber(r.maxDiscountPct),
    requireEligibility: r.requireEligibility === true,
    requireRge: r.requireRge === true,
    requireConsent: r.requireConsent === true,
  };
}
