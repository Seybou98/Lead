// Déclaration d'une absence (§20.6, fig. 23) : validation pure, partagée par l'écran et le serveur.

import { parseHandling, type Handling } from './portfolio';

export const ABSENCE_TYPES = { leave: 'Congé', sick: 'Maladie', training: 'Formation', other: 'Autre' } as const;
export type AbsenceType = keyof typeof ABSENCE_TYPES;

const DAY = 86_400_000;
export const MAX_ABSENCE_DAYS = 365;
const MIN_REASON = 3;

export interface AbsenceInput {
  type: unknown;
  fromMs: unknown;
  toMs: unknown;
  reason: unknown;
  restoreDistribution: unknown;
  handling: unknown;
}

export interface AbsenceDraft {
  type: AbsenceType;
  fromMs: number;
  toMs: number;
  reason: string;
  restoreDistribution: boolean;
  handling: Handling;
}

export type AbsenceCheck = { ok: true; draft: AbsenceDraft } | { ok: false; errors: Partial<Record<'type' | 'period' | 'reason' | 'handling', string>> };

export function validateAbsence(input: AbsenceInput, nowMs: number): AbsenceCheck {
  const errors: Partial<Record<'type' | 'period' | 'reason' | 'handling', string>> = {};
  const type = typeof input.type === 'string' && Object.prototype.hasOwnProperty.call(ABSENCE_TYPES, input.type) ? (input.type as AbsenceType) : null;
  if (!type) errors.type = "Choisissez le type d'absence.";

  const from = typeof input.fromMs === 'number' && Number.isFinite(input.fromMs) ? input.fromMs : null;
  const to = typeof input.toMs === 'number' && Number.isFinite(input.toMs) ? input.toMs : null;
  if (from === null || to === null) errors.period = 'Renseignez le début et la fin de l’absence.';
  else if (to <= from) errors.period = 'La fin doit être postérieure au début.';
  else if (to <= nowMs) errors.period = 'La période est déjà terminée.';
  else if (to - from > MAX_ABSENCE_DAYS * DAY) errors.period = `Une absence ne peut pas dépasser ${MAX_ABSENCE_DAYS} jours.`;
  else if (from > nowMs + 2 * 365 * DAY) errors.period = 'Début trop lointain.';

  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (reason.length < MIN_REASON) errors.reason = 'Le motif est obligatoire.';

  const handling = parseHandling(input.handling);
  if (!handling) errors.handling = 'Le traitement du portefeuille est incomplet.';

  if (Object.keys(errors).length > 0 || !type || from === null || to === null || !handling) return { ok: false, errors };
  return { ok: true, draft: { type, fromMs: from, toMs: to, reason, restoreDistribution: input.restoreDistribution !== false, handling } };
}

/** Absence en cours à l'instant donné (début atteint, fin non atteinte). */
export const isActiveAbsence = (a: { fromMs: number; toMs: number }, nowMs: number): boolean => a.fromMs <= nowMs && nowMs < a.toMs;
