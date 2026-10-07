// Lecture défensive de la configuration d'attribution stockée en base (cl_config/assignment et
// campagne.assignmentConfig). Une valeur invalide est ignorée, jamais appliquée : une config
// corrompue ne doit pas bloquer la distribution des leads.

import {
  DEFAULT_ASSIGNMENT_CONFIG,
  ELIGIBILITY_CRITERIA,
  RANKING_CRITERIA,
  type AssignmentConfig,
  type EligibilityCriterion,
  type RankingCriterion,
} from '../engine/assignment';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Fusionne des couches de configuration, de la plus générale à la plus spécifique
 * (défaut → globale → campagne). Chaque couche peut être partielle ou absente.
 */
export function parseAssignmentConfig(...layers: unknown[]): AssignmentConfig {
  let config: AssignmentConfig = {
    ...DEFAULT_ASSIGNMENT_CONFIG,
    criteria: { ...DEFAULT_ASSIGNMENT_CONFIG.criteria },
    rankingOrder: [...DEFAULT_ASSIGNMENT_CONFIG.rankingOrder],
  };

  for (const layer of layers) {
    const l = asRecord(layer);
    if (!l) continue;

    const cap = l.defaultNewLeadsCap;
    if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= 1000) {
      config = { ...config, defaultNewLeadsCap: cap };
    }

    if (typeof l.autoDistribution === 'boolean') config = { ...config, autoDistribution: l.autoDistribution };

    const criteria = asRecord(l.criteria);
    if (criteria) {
      const next = { ...config.criteria };
      for (const key of ELIGIBILITY_CRITERIA) {
        if (typeof criteria[key] === 'boolean') next[key as EligibilityCriterion] = criteria[key] as boolean;
      }
      config = { ...config, criteria: next };
    }

    const order = l.rankingOrder;
    if (Array.isArray(order)) {
      const valid = order.filter((c): c is RankingCriterion => (RANKING_CRITERIA as readonly unknown[]).includes(c));
      const unique = [...new Set(valid)];
      if (unique.length > 0) {
        // Un critère oublié passe en dernier, dans l'ordre par défaut : le classement reste total.
        const missing = DEFAULT_ASSIGNMENT_CONFIG.rankingOrder.filter((c) => !unique.includes(c));
        config = { ...config, rankingOrder: [...unique, ...missing] };
      }
    }
  }

  return config;
}
