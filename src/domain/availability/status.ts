// Disponibilité du télépro (§4.2, §12.1.4) : statut opérationnel choisi par la personne, et plafond de leads
// Nouveaux. Fonctions pures, partagées par l'écran et la fonction serveur.
//
// Ce que le moteur de distribution fait déjà (src/domain/engine/assignment.ts) : il EXCLUT un utilisateur en
// pause, absent ou indisponible, dont la distribution est suspendue, ou qui a atteint son plafond de leads
// Nouveaux (`newLeads >= plafond`). Un utilisateur à 10/10 sort donc du pool ; dès qu'il repasse à 9/10, il
// redevient éligible : la règle « à 10 il sort, à 9 il revient » est portée par cette comparaison.

import type { OperationalStatus } from '../enums';
import { effectiveCap } from '../engine/assignment';

/** Statuts que le télépro choisit lui-même (menu de Ma journée). « En appel » est posé par l'appel (§12.1.2). */
export const SELECTABLE_STATUSES = ['available', 'paused', 'doc_followup', 'file_building'] as const;
export type SelectableStatus = (typeof SELECTABLE_STATUSES)[number];

/** Statuts qui ne se changent pas soi-même : absence déclarée ou indisponibilité posée par le manager. */
export const LOCKED_STATUSES: readonly OperationalStatus[] = ['absent', 'unavailable'];

/** Statuts qui coupent la distribution. Les autres (en appel, relance, montage…) laissent arriver des leads. */
export const DISTRIBUTION_STOPPING: readonly OperationalStatus[] = ['paused', 'absent', 'unavailable'];

export const STATUS_HINT: Record<SelectableStatus, string> = {
  available: 'Vous recevez de nouveaux leads.',
  paused: 'Aucun nouveau lead ne vous est attribué tant que vous restez en pause.',
  doc_followup: 'Vous traitez des documents ; les leads continuent d’arriver.',
  file_building: 'Vous montez un dossier ; les leads continuent d’arriver.',
};

export type StatusTone = 'green' | 'blue' | 'amber' | 'slate' | 'red';

export const STATUS_TONE: Record<OperationalStatus, StatusTone> = {
  available: 'green',
  on_call: 'blue',
  processing: 'blue',
  doc_followup: 'blue',
  file_building: 'blue',
  in_meeting: 'amber',
  paused: 'amber',
  absent: 'slate',
  disconnected: 'slate',
  unavailable: 'red',
};

export type StatusPlan =
  | { ok: true; changed: boolean; status: OperationalStatus; before: OperationalStatus }
  | { ok: false; code: 'invalid' | 'locked'; message: string };

const isSelectable = (s: unknown): s is SelectableStatus => (SELECTABLE_STATUSES as readonly unknown[]).includes(s);

/**
 * Valide un changement de statut demandé par l'utilisateur lui-même. Il peut choisir un statut du menu, ou
 * « En appel » (posé par le démarrage d'un appel) ; jamais « Absent » / « Indisponible » / « Déconnecté », qui
 * viennent des absences, du manager ou de la présence.
 */
export function planStatusChange(current: OperationalStatus, requested: unknown): StatusPlan {
  if (!isSelectable(requested) && requested !== 'on_call') {
    return { ok: false, code: 'invalid', message: 'Ce statut ne peut pas être choisi.' };
  }
  if (LOCKED_STATUSES.includes(current)) {
    return { ok: false, code: 'locked', message: 'Votre statut est géré par votre manager : contactez-le pour le modifier.' };
  }
  return { ok: true, changed: requested !== current, status: requested, before: current };
}

/** Statut de retour après un appel : celui d'avant l'appel s'il est valide, sinon « Disponible ». */
export function statusAfterCall(resume: unknown): SelectableStatus {
  return isSelectable(resume) ? resume : 'available';
}

// ── Plafond de leads Nouveaux ────────────────────────────────────────────────

export const DEFAULT_NEW_LEADS_CAP = 10;

export interface CapacityInfo {
  used: number;
  cap: number;
  /** Plafond atteint : plus aucune attribution jusqu'à repasser sous le plafond. */
  full: boolean;
  /** Nombre de leads à traiter avant de redevenir éligible (0 si pas plein). */
  toFree: number;
  /** Remplissage 0-100, pour la jauge. */
  percent: number;
}

export function capacityInfo(
  used: number,
  capacity: { newLeadsCap: number | null; override: { value: number; from: unknown; until: unknown } | null } | null | undefined,
  nowMs: number,
  defaultCap = DEFAULT_NEW_LEADS_CAP
): CapacityInfo {
  const o = capacity?.override;
  const fromMs = (o?.from as { toMillis?: () => number } | undefined)?.toMillis?.();
  const untilMs = (o?.until as { toMillis?: () => number } | undefined)?.toMillis?.();
  const cap = effectiveCap(
    {
      newLeadsCap: capacity?.newLeadsCap ?? Number.NaN,
      override: o && fromMs !== undefined && untilMs !== undefined ? { value: o.value, fromMs, untilMs } : null,
    },
    nowMs,
    defaultCap
  );
  const n = Math.max(0, used);
  const full = cap > 0 && n >= cap;
  return { used: n, cap, full, toFree: full ? n - cap + 1 : 0, percent: cap > 0 ? Math.min(100, Math.round((n / cap) * 100)) : 100 };
}
