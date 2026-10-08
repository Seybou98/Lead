// Plans d'écriture d'administration : TOUTE la logique métier des écritures d'équipes, profils,
// campagnes, sources, dépenses et règles d'attribution, sans aucun accès à Firestore.
//
// Deux couches d'exécution minces lisent les données, appellent ces fonctions, puis écrivent :
//   - src/lib/adminWrites.ts      : depuis le navigateur (SDK web, protégé par les règles Firestore) ;
//   - functions/src/admin.ts      : fonctions Firebase (Admin SDK), conservées en secours.
// Les deux appliquent donc exactement les mêmes règles. Les données sont des objets simples :
// les dates sont des `Date` (les deux SDK les convertissent en Timestamp à l'écriture).

import { coerceRulesInput, coerceSlaInput, effectiveSla, parseSlaOverride, validateRulesSettings, validateSlaSettings, type SlaSettings } from '../settings/settings';
import { checklistKey, DEFAULT_CHECKLIST_KEY, slugCode, validateChecklist } from '../documents/checklist';
import { resolveLeadRole } from '../../config/roles';
import {
  affectedUserIds,
  cleanList,
  cleanString,
  deriveMembership,
  fallbackCreatesLoop,
  validateCampaign,
  validateProfilePatch,
  validateSource,
  validateSpend,
  validateTeam,
  type TeamMembership,
  type Validated,
} from './validate';

type Doc = Record<string, unknown>;

export type AdminErrorCode = 'invalid-argument' | 'failed-precondition' | 'not-found';

/** Refus métier, avec un message lisible tel quel par l'administrateur. */
export class AdminRuleError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AdminRuleError';
  }
}

export interface AuditDraft {
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface UserSnapshot {
  exists: boolean;
  role: string | null;
  status: string | null;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isActive = (u: UserSnapshot | undefined) => !!u?.exists && String(u.status ?? '').trim().toLowerCase() === 'active';

export function unwrap<T>(r: Validated<T>): { value: T; warnings: string[] } {
  if (!r.ok) throw new AdminRuleError('invalid-argument', r.errors.join(' '));
  return { value: r.value, warnings: r.warnings };
}

export function asRecord(data: unknown): Doc {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AdminRuleError('invalid-argument', 'Données manquantes.');
  }
  return data as Doc;
}

/** Identifiant optionnel fourni par l'appelant : on n'accepte que des identifiants simples. */
export function optionalId(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(v)) {
    throw new AdminRuleError('invalid-argument', 'Identifiant invalide (lettres, chiffres, - et _ uniquement).');
  }
  return v;
}

export const reasonOf = (d: Doc): string | null => (typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 500) : null);

export function defaultProfile(uid: string, now: Date): Doc {
  return {
    uid,
    primaryTeamId: null,
    teamIds: [] as string[],
    managerIds: [] as string[],
    // Périmètre vide = aucun lead tant que l'administrateur ne l'a pas défini : jamais « tout » par défaut.
    scope: { productCodes: [] as string[], zones: [] as string[], campaignIds: [] as string[], sourceIds: [] as string[] },
    // null = plafond par défaut de la configuration (10) : modifier le défaut s'applique alors à ce télépro.
    capacity: { newLeadsCap: null, override: null },
    operationalStatus: 'available',
    operationalStatusSince: now,
    distributionSuspended: false,
    lastUsefulActionAt: null,
    lastAssignedAt: null,
    schedule: { timezone: 'Europe/Paris', weekly: [] as unknown[], breaks: [] as unknown[] },
    load: { newLeads: 0, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

// ── Équipe ───────────────────────────────────────────────────────────────────

/** Ce qu'il faut lire AVANT de planifier une écriture d'équipe (les écritures se font en une transaction). */
export function teamDependencies(input: unknown, before: Doc | null): { userIds: string[]; profileUids: string[] } {
  const d = (typeof input === 'object' && input !== null ? input : {}) as Doc;
  const managers = [cleanString(d.managerId), cleanString(d.secondaryManagerId)].filter((x): x is string => !!x);
  const members = cleanList(d.memberIds);
  const oldMembers = arr(before?.memberIds);
  return {
    userIds: [...new Set([...managers, ...members, ...oldMembers])],
    profileUids: affectedUserIds({ memberIds: oldMembers }, { memberIds: members }),
  };
}

export interface OtherTeam {
  id: string;
  managerId: string;
  secondaryManagerId: string | null;
  memberIds: string[];
  active: boolean;
  fallbackTeamId: string | null;
}

export interface ProfileWrite {
  uid: string;
  mode: 'create' | 'update';
  data: Doc;
}

export function planTeamSave(args: {
  input: unknown;
  teamId: string;
  before: Doc | null;
  otherTeams: readonly OtherTeam[];
  users: ReadonlyMap<string, UserSnapshot>;
  profiles: ReadonlyMap<string, { exists: boolean; primaryTeamId: string | null }>;
  nowMs: number;
}): { team: Doc; profileWrites: ProfileWrite[]; warnings: string[]; audit: AuditDraft } {
  const { teamId, before, otherTeams, users, profiles, nowMs } = args;
  const now = new Date(nowMs);
  const data = asRecord(args.input);
  const { value, warnings } = unwrap(validateTeam(data, teamId));

  for (const m of [value.managerId, value.secondaryManagerId]) {
    if (!m) continue;
    const u = users.get(m);
    const role = resolveLeadRole(u?.role);
    if (!isActive(u) || (role !== 'manager' && role !== 'admin')) {
      throw new AdminRuleError('failed-precondition', `${m} n'est pas un manager (ou administrateur) actif.`);
    }
  }
  for (const m of value.memberIds) {
    const u = users.get(m);
    if (!isActive(u) || resolveLeadRole(u?.role) !== 'telepro') {
      throw new AdminRuleError('failed-precondition', `${m} n'est pas un télépro-commercial actif.`);
    }
  }

  if (value.fallbackTeamId && !otherTeams.some((t) => t.id === value.fallbackTeamId)) {
    throw new AdminRuleError('failed-precondition', 'Équipe de secours introuvable.');
  }
  const fallbackOf = new Map<string, string | null>(otherTeams.map((t) => [t.id, t.fallbackTeamId]));
  fallbackOf.set(teamId, value.fallbackTeamId);
  if (fallbackCreatesLoop(teamId, fallbackOf)) {
    throw new AdminRuleError('failed-precondition', 'Cette équipe de secours crée une boucle (A → B → A).');
  }

  // Équipes telles qu'elles seront après l'écriture : sert à recalculer les profils concernés.
  const teamsAfter: TeamMembership[] = [
    ...otherTeams.map((t) => ({ id: t.id, managerId: t.managerId, secondaryManagerId: t.secondaryManagerId, memberIds: t.memberIds, active: t.active })),
    { id: teamId, managerId: value.managerId, secondaryManagerId: value.secondaryManagerId, memberIds: value.memberIds, active: value.active },
  ];

  const team: Doc = { id: teamId, ...value, createdAt: before?.createdAt ?? now, updatedAt: now };

  const affected = affectedUserIds(before ? { memberIds: arr(before.memberIds) } : null, { memberIds: value.memberIds });
  const profileWrites: ProfileWrite[] = affected.map((uid) => {
    const p = profiles.get(uid);
    const m = deriveMembership(uid, teamsAfter, p?.exists ? p.primaryTeamId : null);
    return p?.exists
      ? { uid, mode: 'update', data: { teamIds: m.teamIds, managerIds: m.managerIds, primaryTeamId: m.primaryTeamId, updatedAt: now } }
      : { uid, mode: 'create', data: { ...defaultProfile(uid, now), teamIds: m.teamIds, managerIds: m.managerIds, primaryTeamId: m.primaryTeamId } };
  });

  return {
    team,
    profileWrites,
    warnings,
    audit: { action: before ? 'team.update' : 'team.create', entityType: 'team', entityId: teamId, before, after: team, reason: reasonOf(data) },
  };
}

// ── Profil ───────────────────────────────────────────────────────────────────

export function planProfileUpdate(args: {
  uid: string;
  input: unknown;
  user: UserSnapshot;
  before: Doc | null;
  actorId: string;
  nowMs: number;
}): { next: Doc; warnings: string[]; audit: AuditDraft } {
  const { uid, user, before, actorId, nowMs } = args;
  const now = new Date(nowMs);
  const data = asRecord(args.input);
  const { value: patch, warnings } = unwrap(validateProfilePatch(data, nowMs));

  if (!user.exists || resolveLeadRole(user.role) !== 'telepro') {
    throw new AdminRuleError('failed-precondition', 'Seuls les télépros-commerciaux ont un profil de distribution.');
  }
  const base = before ?? defaultProfile(uid, now);
  const next: Doc = { ...base, updatedAt: now };
  if (patch.scope) next.scope = patch.scope;
  if (patch.schedule) next.schedule = patch.schedule;
  if (patch.distributionSuspended !== undefined) next.distributionSuspended = patch.distributionSuspended;
  if (patch.accessEndsAtMs !== undefined) next.accessEndsAt = patch.accessEndsAtMs === null ? null : new Date(patch.accessEndsAtMs);
  if (patch.newLeadsCap !== undefined || patch.capacityOverride !== undefined) {
    const cap = { ...((base.capacity as Doc) ?? {}) };
    if (patch.newLeadsCap !== undefined) cap.newLeadsCap = patch.newLeadsCap;
    if (patch.capacityOverride !== undefined) {
      cap.override = patch.capacityOverride
        ? {
            value: patch.capacityOverride.value,
            from: new Date(patch.capacityOverride.fromMs),
            until: new Date(patch.capacityOverride.untilMs),
            reason: patch.capacityOverride.reason,
            grantedBy: actorId,
          }
        : null;
    }
    next.capacity = cap;
  }
  return { next, warnings, audit: { action: 'profile.update', entityType: 'profile', entityId: uid, before, after: next, reason: reasonOf(data) } };
}

// ── Source ───────────────────────────────────────────────────────────────────

export function planSourceSave(args: { input: unknown; sourceId: string; before: Doc | null; nowMs: number }): { doc: Doc; warnings: string[]; audit: AuditDraft } {
  const { sourceId, before, nowMs } = args;
  const now = new Date(nowMs);
  const data = asRecord(args.input);
  const { value, warnings } = unwrap(validateSource(data));
  const doc: Doc = {
    id: sourceId,
    ...value,
    // La correspondance de champs propre à une source n'est pas modifiée ici : elle est conservée.
    fieldMapping: before?.fieldMapping ?? {},
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  return { doc, warnings, audit: { action: before ? 'source.update' : 'source.create', entityType: 'source', entityId: sourceId, before, after: doc, reason: reasonOf(data) } };
}

// ── Campagne ─────────────────────────────────────────────────────────────────

export interface CampaignPlanContext {
  sources: readonly { id: string; enabled: boolean }[];
  teams: readonly { id: string; active: boolean; memberCount: number }[];
  /** Utilisateurs ayant un profil de distribution, avec leur compte du CRM principal. */
  profileUsers: readonly { uid: string; role: string | null; status: string | null }[];
  /** Une AUTRE campagne utilise déjà cet identifiant externe. */
  externalIdTaken: boolean;
}

/** Ce qu'il faut lire (dans la transaction) pour valider une campagne : seulement ce qu'elle référence. */
export function campaignDependencies(input: unknown): { sourceId: string | null; teamIds: string[]; userIds: string[] } {
  const d = (typeof input === 'object' && input !== null ? input : {}) as Doc;
  const fallback = cleanString(d.fallbackTeamId);
  return {
    sourceId: cleanString(d.sourceId),
    teamIds: [...new Set([...cleanList(d.eligibleTeamIds), ...(fallback ? [fallback] : [])])],
    userIds: cleanList(d.eligibleUserIds),
  };
}

export function planCampaignSave(args: {
  input: unknown;
  campaignId: string;
  before: Doc | null;
  context: CampaignPlanContext;
  nowMs: number;
}): { doc: Doc; warnings: string[]; audit: AuditDraft } {
  const { campaignId, before, context, nowMs } = args;
  const now = new Date(nowMs);
  const data = asRecord(args.input);

  const eligibleUsers = new Set(
    context.profileUsers.filter((u) => isActive({ exists: true, role: u.role, status: u.status }) && resolveLeadRole(u.role) === 'telepro').map((u) => u.uid)
  );
  const { value, warnings } = unwrap(
    validateCampaign(data, {
      sources: new Map(context.sources.map((s) => [s.id, { enabled: s.enabled }])),
      teams: new Map(context.teams.map((t) => [t.id, { active: t.active, memberCount: t.memberCount }])),
      eligibleUsers,
      externalIdTaken: context.externalIdTaken,
    })
  );

  const { startsAtMs, endsAtMs, ...rest } = value;
  const doc: Doc = {
    id: campaignId,
    ...rest,
    startsAt: startsAtMs === null ? null : new Date(startsAtMs),
    endsAt: endsAtMs === null ? null : new Date(endsAtMs),
    // Champs propres au moteur : conservés tels quels, jamais effacés par une édition de formulaire.
    ...(before?.slaOverride ? { slaOverride: before.slaOverride } : {}),
    ...(before?.assignmentConfig ? { assignmentConfig: before.assignmentConfig } : {}),
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    doc,
    warnings,
    audit: {
      action: before ? (before.status !== doc.status ? `campaign.status.${String(doc.status)}` : 'campaign.update') : 'campaign.create',
      entityType: 'campaign',
      entityId: campaignId,
      before,
      after: doc,
      reason: reasonOf(data),
    },
  };
}

/** Règles d'attribution d'une campagne (fig. 17) : plafond, critères activés, ordre de priorité. */
const CRITERIA = ['active_connected', 'product', 'zone', 'team', 'working_hours', 'capacity', 'exclude_in_meeting'];
const RANKING = ['lowest_active_load', 'fewest_new_leads', 'oldest_last_assignment'];

export function parseAssignmentConfigInput(v: unknown): Doc {
  const o = asRecord(v);
  const bad = (m: string) => new AdminRuleError('invalid-argument', m);
  const out: Doc = {};
  if (o.defaultNewLeadsCap !== undefined) {
    if (typeof o.defaultNewLeadsCap !== 'number' || !Number.isInteger(o.defaultNewLeadsCap) || o.defaultNewLeadsCap < 0 || o.defaultNewLeadsCap > 100) {
      throw bad('Plafond par défaut : entier entre 0 et 100.');
    }
    out.defaultNewLeadsCap = o.defaultNewLeadsCap;
  }
  if (o.autoDistribution !== undefined) {
    if (typeof o.autoDistribution !== 'boolean') throw bad('Distribution automatique : vrai ou faux.');
    out.autoDistribution = o.autoDistribution;
  }
  if (o.criteria !== undefined) {
    const c = asRecord(o.criteria);
    const crit: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(c)) {
      if (!CRITERIA.includes(k)) throw bad(`Critère inconnu : ${k}.`);
      if (typeof val !== 'boolean') throw bad(`Critère ${k} : vrai ou faux.`);
      crit[k] = val;
    }
    out.criteria = crit;
  }
  if (o.rankingOrder !== undefined) {
    const r = Array.isArray(o.rankingOrder) ? o.rankingOrder : [];
    if (r.length !== RANKING.length || new Set(r).size !== RANKING.length || !r.every((x) => typeof x === 'string' && RANKING.includes(x))) {
      throw bad(`Ordre de priorité : chacun de ${RANKING.join(', ')} exactement une fois.`);
    }
    out.rankingOrder = r;
  }
  if (Object.keys(out).length === 0) throw bad('Aucune règle fournie.');
  return out;
}

export function planAssignmentConfig(args: { input: unknown; campaignId: string; before: Doc | null }): { config: Doc; audit: AuditDraft } {
  const data = asRecord(args.input);
  if (!args.before) throw new AdminRuleError('not-found', 'Campagne introuvable.');
  const config = parseAssignmentConfigInput(data.config);
  return {
    config,
    audit: { action: 'campaign.assignmentConfig', entityType: 'campaign', entityId: args.campaignId, before: args.before.assignmentConfig ?? null, after: config, reason: reasonOf(data) },
  };
}

// ── Dépense publicitaire ─────────────────────────────────────────────────────

export function planSpendSave(args: {
  input: unknown;
  spendId: string;
  /** L'appelant a fourni un identifiant : c'est une correction, l'entrée doit exister. */
  isCorrectionRequest: boolean;
  before: Doc | null;
  campaignExists: boolean;
  actorId: string;
  nowMs: number;
}): { doc: Doc; warnings: string[]; audit: AuditDraft } {
  const { spendId, before, actorId, nowMs } = args;
  const now = new Date(nowMs);
  const data = asRecord(args.input);
  const campaignId = typeof data.campaignId === 'string' ? data.campaignId.trim() : '';

  if (args.isCorrectionRequest && !before) throw new AdminRuleError('not-found', 'Dépense introuvable.');
  if (before && before.campaignId !== campaignId) {
    throw new AdminRuleError('failed-precondition', 'Une dépense ne peut pas changer de campagne : corrigez-la à 0 puis saisissez-en une nouvelle.');
  }
  const { value, warnings } = unwrap(validateSpend(data, { campaignExists: args.campaignExists, isCorrection: !!before, nowMs }));

  const doc: Doc = {
    id: spendId,
    campaignId: value.campaignId,
    amountCents: value.amountCents,
    date: new Date(value.dateMs),
    kind: 'manual',
    note: value.note,
    createdBy: before?.createdBy ?? actorId,
    createdAt: before?.createdAt ?? now,
    updatedBy: actorId,
    updatedAt: now,
  };
  return { doc, warnings, audit: { action: before ? 'adSpend.correct' : 'adSpend.create', entityType: 'adSpend', entityId: spendId, before, after: doc, reason: value.reason } };
}

// ── Checklist documentaire ───────────────────────────────────────────────────

/**
 * Enregistrement de la checklist d'une famille de produit (ou de la checklist « par défaut »). Les pièces gardent
 * leur code d'origine ; une nouvelle pièce reçoit un code tiré de son nom. Un code ne change jamais ensuite :
 * les dossiers déjà ouverts y sont rattachés.
 */
export function planChecklistSave(args: {
  input: unknown;
  before: Doc | null;
  actorId: string;
  nowMs: number;
}): { key: string; doc: Doc; audit: AuditDraft } {
  const data = asRecord(args.input);
  const productCode = typeof data.productCode === 'string' && data.productCode.trim() ? data.productCode.trim().slice(0, 80) : null;
  const key = checklistKey(productCode);
  const raw = Array.isArray(data.items) ? data.items : [];
  const taken = new Set<string>();
  const items = raw.map((r) => {
    const it = asRecord(r);
    const label = typeof it.label === 'string' ? it.label.trim() : '';
    const code = typeof it.code === 'string' && /^[a-z0-9][a-z0-9_-]{0,59}$/.test(it.code) && !taken.has(it.code) ? it.code : slugCode(label, taken);
    taken.add(code);
    return { code, label, mandatory: it.mandatory === true };
  });
  const errors = validateChecklist(items);
  if (errors.length > 0) throw new AdminRuleError('invalid-argument', errors[0]);
  const now = new Date(args.nowMs);
  const doc: Doc = {
    id: key,
    productCode: key === DEFAULT_CHECKLIST_KEY ? null : productCode,
    items,
    createdAt: args.before?.createdAt ?? now,
    updatedAt: now,
    updatedBy: args.actorId,
  };
  return { key, doc, audit: { action: args.before ? 'checklist.update' : 'checklist.create', entityType: 'checklist', entityId: key, before: args.before, after: doc, reason: reasonOf(data) } };
}

// ── Réglages d'administration (SLA et horaires, cycles NR) ───────────────────

/** Réglages généraux « SLA et horaires » : la saisie est validée telle quelle, jamais corrigée en silence. */
export function planSlaSave(args: { input: unknown; before: Doc | null; actorId: string; nowMs: number }): { doc: Doc; audit: AuditDraft } {
  const s = coerceSlaInput(args.input);
  const errors = validateSlaSettings(s);
  if (errors.length > 0) throw new AdminRuleError('invalid-argument', errors[0]);
  const doc: Doc = { ...s, schedule: { timezone: s.schedule.timezone, weekly: s.schedule.weekly, closedDates: [...new Set(s.schedule.closedDates)].sort() }, updatedAt: new Date(args.nowMs), updatedBy: args.actorId };
  return { doc, audit: { action: args.before ? 'settings.sla.update' : 'settings.sla.create', entityType: 'settings', entityId: 'sla', before: args.before, after: doc, reason: reasonOf(asRecord(args.input)) } };
}

/** Règle de réattribution d'une campagne (surcharge des réglages généraux). */
export function planSlaOverrideSave(args: { campaignId: string; input: unknown; general: SlaSettings; before: Doc | null; actorId: string; nowMs: number }): { doc: Doc; audit: AuditDraft } {
  const d = asRecord(args.input);
  const o = parseSlaOverride(d);
  const merged = effectiveSla(args.general, o);
  const problems = validateSlaSettings(merged);
  if (problems.length > 0) throw new AdminRuleError('invalid-argument', problems[0]);
  // Une valeur envoyée mais refusée par la lecture tolérante (hors bornes) est une erreur, pas un oubli.
  for (const k of ['reassignMin', 'maxReassignments'] as const) {
    if (d[k] !== undefined && d[k] !== null && o[k] === undefined) throw new AdminRuleError('invalid-argument', k === 'reassignMin' ? 'Délai de réattribution : entre 1 et 960 minutes.' : 'Le nombre maximal de réattributions va de 0 à 10.');
  }
  const doc: Doc = { ...o, campaignId: args.campaignId, updatedAt: new Date(args.nowMs), updatedBy: args.actorId };
  return { doc, audit: { action: args.before ? 'settings.sla.campaign.update' : 'settings.sla.campaign.create', entityType: 'settings', entityId: `sla_${args.campaignId}`, before: args.before, after: doc, reason: reasonOf(d) } };
}

/** Cycles NR, rappels, relances documentaires. */
export function planRulesSave(args: { input: unknown; before: Doc | null; actorId: string; nowMs: number }): { doc: Doc; audit: AuditDraft } {
  const s = coerceRulesInput(args.input);
  const errors = validateRulesSettings(s);
  if (errors.length > 0) throw new AdminRuleError('invalid-argument', errors[0]);
  const doc: Doc = { ...s, updatedAt: new Date(args.nowMs), updatedBy: args.actorId };
  return { doc, audit: { action: args.before ? 'settings.rules.update' : 'settings.rules.create', entityType: 'settings', entityId: 'rules', before: args.before, after: doc, reason: reasonOf(asRecord(args.input)) } };
}
