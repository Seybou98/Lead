// Moteur d'attribution (§4.2, §19.3, §19.5, §24.4).
//
// Fonction PURE : mêmes données en entrée → même décision. C'est ce qui garantit qu'une simulation
// (fig. 17) et une attribution réelle produisent le même résultat (§19.7). Elle ne lit rien, n'écrit
// rien : l'appelant fournit un instantané des candidats et enregistre la décision (journal compris).

import type { OperationalStatus } from '../enums';
import { normalizeText } from './normalize';

// ── Entrées ──────────────────────────────────────────────────────────────────

export interface AssignmentLead {
  id: string;
  productCode: string | null;
  zone: string | null;
  campaignId: string | null;
}

export interface AssignmentCampaign {
  id: string;
  eligibleUserIds: readonly string[];
  eligibleTeamIds: readonly string[];
  fallbackTeamId: string | null;
  /** true = aucune restriction d'équipe : tout télépro autorisé pour le produit et la zone est candidat (fig. 16). */
  autoEligible?: boolean;
}

/** Instantané d'un télépro au moment du calcul. Les compteurs sont ceux de CE moment, figés dans le journal. */
export interface Candidate {
  uid: string;
  name: string;
  accountActive: boolean;
  /** Fin d'accès programmée (epoch ms) ; passée = accès expiré. */
  accessEndsAtMs: number | null;
  connected: boolean;
  operationalStatus: OperationalStatus;
  distributionSuspended: boolean;
  /** Absence déclarée couvrant l'instant du calcul. */
  absent: boolean;
  /** Résultat de isWithinSchedule() pour cet utilisateur. Calculé par l'appelant. */
  withinSchedule: boolean;
  teamIds: readonly string[];
  /** '*' = toutes les valeurs. Liste vide = aucune (jamais « tout »). */
  scope: { productCodes: readonly string[]; zones: readonly string[] };
  /** Leads au statut Nouveau détenus par ce télépro. */
  newLeads: number;
  /** Charge active totale (nouveaux, rappels, intéressés, documents, dossiers à monter). */
  activeLoad: number;
  capacity: {
    newLeadsCap: number;
    override: { value: number; fromMs: number; untilMs: number } | null;
  };
  lastAssignedAtMs: number | null;
}

export const ELIGIBILITY_CRITERIA = [
  'active_connected', // « Télépro actif et connecté »
  'product', // « Produit autorisé »
  'zone', // « Zone autorisée »
  'team', // « Équipe »
  'working_hours', // « Horaires de travail »
  'capacity', // « Capacité disponible »
  'exclude_in_meeting', // « Exclure le statut En rendez-vous »
] as const;
export type EligibilityCriterion = (typeof ELIGIBILITY_CRITERIA)[number];

export const RANKING_CRITERIA = ['lowest_active_load', 'fewest_new_leads', 'oldest_last_assignment'] as const;
export type RankingCriterion = (typeof RANKING_CRITERIA)[number];

export interface AssignmentConfig {
  /** Plafond de leads Nouveaux par défaut (§4.2 : 10). */
  defaultNewLeadsCap: number;
  /** false = « Distribution automatique » désactivée (fig. 17) : les leads vont en file tampon, un manager attribue. */
  autoDistribution: boolean;
  /** Critères d'éligibilité activés (fig. 17, cases à cocher). Absent = activé. */
  criteria: Partial<Record<EligibilityCriterion, boolean>>;
  /** Ordre de départage (fig. 17, « Ordre de priorité »). */
  rankingOrder: readonly RankingCriterion[];
}

export const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
  defaultNewLeadsCap: 10,
  autoDistribution: true,
  criteria: {},
  rankingOrder: ['lowest_active_load', 'fewest_new_leads', 'oldest_last_assignment'],
};

// ── Sorties ──────────────────────────────────────────────────────────────────

export type ExclusionCode =
  | 'account_inactive'
  | 'access_expired'
  | 'not_connected'
  | 'distribution_suspended'
  | 'status_paused'
  | 'status_absent'
  | 'status_unavailable'
  | 'status_disconnected'
  | 'status_in_meeting'
  | 'absent'
  | 'product_not_allowed'
  | 'zone_not_allowed'
  | 'team_not_allowed'
  | 'outside_hours'
  | 'capacity_reached';

export interface Evaluation {
  uid: string;
  name: string;
  eligible: boolean;
  exclusions: ExclusionCode[];
  /** Valeurs utilisées pour le calcul, figées pour l'audit. */
  activeLoad: number;
  newLeads: number;
  effectiveCap: number;
  lastAssignedAtMs: number | null;
}

export type AssignmentStage = 'primary' | 'fallback';

export interface AssignmentDecision {
  /** null = file tampon */
  chosenUid: string | null;
  stage: AssignmentStage | null;
  evaluations: Evaluation[];
  /** Candidats éligibles, du meilleur au moins bon. */
  ranking: string[];
  /** Critère qui a départagé le premier du second ; 'only_candidate' s'il était seul. */
  decidedBy: RankingCriterion | 'stable_hash' | 'only_candidate' | null;
  /** Motif de la file tampon : l'exclusion la plus fréquente. */
  bufferReason: ExclusionCode | 'no_candidate' | null;
  /** Règle appliquée, lisible par un humain et stable (pour le journal). */
  ruleApplied: string;
}

// ── Capacité ─────────────────────────────────────────────────────────────────

/** Plafond en vigueur : la dérogation compte uniquement pendant sa période (§20.7, retour automatique). */
export function effectiveCap(
  capacity: Candidate['capacity'],
  nowMs: number,
  defaultCap: number
): number {
  const o = capacity.override;
  if (o && nowMs >= o.fromMs && nowMs <= o.untilMs) return o.value;
  return Number.isFinite(capacity.newLeadsCap) ? capacity.newLeadsCap : defaultCap;
}

// ── Éligibilité ──────────────────────────────────────────────────────────────

/**
 * Les valeurs de produit et de zone viennent de sources externes en texte libre (« PAC Air/Eau »,
 * « Île-de-France ») alors que le périmètre contient des codes (« pac_air_eau », « ile_de_france »).
 * La comparaison ignore donc la casse, les accents et la ponctuation.
 */
function allows(list: readonly string[], value: string | null): boolean {
  if (list.includes('*')) return true;
  if (value === null) return false;
  const wanted = normalizeText(value);
  return wanted !== '' && list.some((item) => normalizeText(item) === wanted);
}

function isOn(config: AssignmentConfig, c: EligibilityCriterion): boolean {
  return config.criteria[c] !== false;
}

type TeamRule = { userIds: readonly string[]; teamIds: readonly string[] } | null;

export function evaluateCandidate(
  c: Candidate,
  lead: AssignmentLead,
  teamRule: TeamRule,
  nowMs: number,
  config: AssignmentConfig
): Evaluation {
  const ex: ExclusionCode[] = [];
  const cap = effectiveCap(c.capacity, nowMs, config.defaultNewLeadsCap);

  // Toujours bloquants, non désactivables : un télépro en pause, absent ou suspendu ne reçoit rien.
  if (c.distributionSuspended) ex.push('distribution_suspended');
  if (c.operationalStatus === 'paused') ex.push('status_paused');
  if (c.operationalStatus === 'absent') ex.push('status_absent');
  if (c.operationalStatus === 'unavailable') ex.push('status_unavailable');
  if (c.absent) ex.push('absent');

  if (isOn(config, 'active_connected')) {
    if (!c.accountActive) ex.push('account_inactive');
    if (c.accessEndsAtMs !== null && c.accessEndsAtMs <= nowMs) ex.push('access_expired');
    if (!c.connected) ex.push('not_connected');
    if (c.operationalStatus === 'disconnected') ex.push('status_disconnected');
  }
  if (isOn(config, 'exclude_in_meeting') && c.operationalStatus === 'in_meeting') ex.push('status_in_meeting');
  if (isOn(config, 'product') && !allows(c.scope.productCodes, lead.productCode)) ex.push('product_not_allowed');
  if (isOn(config, 'zone') && !allows(c.scope.zones, lead.zone)) ex.push('zone_not_allowed');
  if (isOn(config, 'team') && teamRule) {
    const inTeam = teamRule.userIds.includes(c.uid) || c.teamIds.some((t) => teamRule.teamIds.includes(t));
    if (!inTeam) ex.push('team_not_allowed');
  }
  if (isOn(config, 'working_hours') && !c.withinSchedule) ex.push('outside_hours');
  // À 10 on sort du pool, à 9 on y revient : éligible tant que newLeads < plafond.
  if (isOn(config, 'capacity') && c.newLeads >= cap) ex.push('capacity_reached');

  return {
    uid: c.uid,
    name: c.name,
    eligible: ex.length === 0,
    exclusions: ex,
    activeLoad: c.activeLoad,
    newLeads: c.newLeads,
    effectiveCap: cap,
    lastAssignedAtMs: c.lastAssignedAtMs,
  };
}

// ── Classement ───────────────────────────────────────────────────────────────

/** Hash FNV-1a 32 bits : départage stable, reproductible et auditable (pas de hasard). */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function compareBy(criterion: RankingCriterion, a: Evaluation, b: Evaluation): number {
  switch (criterion) {
    case 'lowest_active_load':
      return a.activeLoad - b.activeLoad;
    case 'fewest_new_leads':
      return a.newLeads - b.newLeads;
    case 'oldest_last_assignment': {
      // Jamais attribué = le plus ancien de tous.
      const av = a.lastAssignedAtMs ?? Number.NEGATIVE_INFINITY;
      const bv = b.lastAssignedAtMs ?? Number.NEGATIVE_INFINITY;
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
  }
}

export function rankEligible(
  eligible: readonly Evaluation[],
  leadId: string,
  order: readonly RankingCriterion[]
): { ranking: Evaluation[]; decidedBy: AssignmentDecision['decidedBy'] } {
  const ranking = [...eligible].sort((a, b) => {
    for (const criterion of order) {
      const d = compareBy(criterion, a, b);
      if (d !== 0) return d;
    }
    const ha = stableHash(`${leadId}:${a.uid}`);
    const hb = stableHash(`${leadId}:${b.uid}`);
    return ha !== hb ? ha - hb : a.uid.localeCompare(b.uid);
  });

  if (ranking.length === 0) return { ranking, decidedBy: null };
  if (ranking.length === 1) return { ranking, decidedBy: 'only_candidate' };

  const [first, second] = ranking;
  const decidedBy = order.find((c) => compareBy(c, first, second) !== 0) ?? 'stable_hash';
  return { ranking, decidedBy };
}

// ── Décision ─────────────────────────────────────────────────────────────────

const RULE_LABEL = (order: readonly RankingCriterion[]) => order.join('>') + '>stable_hash';

/**
 * Choisit un télépro pour un lead.
 * 1. évalue chaque candidat contre les critères d'éligibilité ;
 * 2. classe les éligibles (charge active, nouveaux leads, ancienneté de la dernière attribution) ;
 * 3. si personne n'est éligible dans l'équipe de la campagne, retente avec l'équipe de secours ;
 * 4. sinon le lead entre en file tampon avec le motif le plus fréquent.
 */
export function decideAssignment(
  lead: AssignmentLead,
  campaign: AssignmentCampaign | null,
  candidates: readonly Candidate[],
  nowMs: number,
  config: AssignmentConfig = DEFAULT_ASSIGNMENT_CONFIG
): AssignmentDecision {
  // Éligibilité automatique : pas de restriction d'équipe (le produit, la zone, la capacité… filtrent déjà).
  const primaryRule: TeamRule = campaign && !campaign.autoEligible
    ? { userIds: campaign.eligibleUserIds, teamIds: campaign.eligibleTeamIds }
    : null;

  const run = (rule: TeamRule, stage: AssignmentStage): AssignmentDecision => {
    const evaluations = candidates.map((c) => evaluateCandidate(c, lead, rule, nowMs, config));
    const eligible = evaluations.filter((e) => e.eligible);
    const { ranking, decidedBy } = rankEligible(eligible, lead.id, config.rankingOrder);
    return {
      chosenUid: ranking[0]?.uid ?? null,
      stage: ranking.length ? stage : null,
      evaluations,
      ranking: ranking.map((r) => r.uid),
      decidedBy,
      bufferReason: ranking.length ? null : dominantExclusion(evaluations),
      ruleApplied: stage === 'fallback' ? `fallback_team:${RULE_LABEL(config.rankingOrder)}` : RULE_LABEL(config.rankingOrder),
    };
  };

  const primary = run(primaryRule, 'primary');
  if (primary.chosenUid || !campaign?.fallbackTeamId) return primary;

  const fallback = run({ userIds: [], teamIds: [campaign.fallbackTeamId] }, 'fallback');
  // Si l'équipe de secours ne trouve personne non plus, le motif affiché est celui du premier essai.
  return fallback.chosenUid ? fallback : { ...primary, ruleApplied: `${primary.ruleApplied}|fallback_failed` };
}

/** Exclusion la plus fréquente parmi les candidats ; ordre de priorité stable à égalité. */
function dominantExclusion(evaluations: readonly Evaluation[]): ExclusionCode | 'no_candidate' {
  if (evaluations.length === 0) return 'no_candidate';
  const counts = new Map<ExclusionCode, number>();
  for (const e of evaluations) for (const x of e.exclusions) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: ExclusionCode | null = null;
  let bestCount = 0;
  for (const [code, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestCount) {
      best = code;
      bestCount = n;
    }
  }
  return best ?? 'no_candidate';
}
