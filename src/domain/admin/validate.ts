// Validation des écritures d'administration (équipes, profils, campagnes, sources).
// Fonctions PURES : les Cloud Functions les appellent avant d'écrire, l'interface pourra les
// réutiliser pour afficher les mêmes messages. Un échec renvoie TOUTES les erreurs d'un coup,
// pour que l'administrateur corrige en une seule fois.

import { CAMPAIGN_STATUSES, type CampaignStatus } from '../enums';

export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function cleanString(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}

/** Liste de textes : espaces retirés, vides et doublons supprimés, ordre conservé. */
export function cleanList(v: unknown, max = 200): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = cleanString(item, max);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function intInRange(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Équipe ───────────────────────────────────────────────────────────────────

export interface TeamValue {
  name: string;
  managerId: string;
  secondaryManagerId: string | null;
  memberIds: string[];
  productCodes: string[];
  zones: string[];
  campaignIds: string[];
  fallbackTeamId: string | null;
  active: boolean;
}

export function validateTeam(input: unknown, selfId: string | null): Validated<TeamValue> {
  if (!isObj(input)) return { ok: false, errors: ['Données manquantes.'] };
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = cleanString(input.name, 80);
  if (!name) errors.push("Le nom de l'équipe est obligatoire.");
  const managerId = cleanString(input.managerId);
  if (!managerId) errors.push('Le manager principal est obligatoire.');
  const secondaryManagerId = cleanString(input.secondaryManagerId);
  if (secondaryManagerId && secondaryManagerId === managerId) {
    errors.push('Le manager secondaire doit être différent du manager principal.');
  }
  const fallbackTeamId = cleanString(input.fallbackTeamId);
  if (fallbackTeamId && selfId && fallbackTeamId === selfId) {
    errors.push('Une équipe ne peut pas être sa propre équipe de secours.');
  }

  const memberIds = cleanList(input.memberIds);
  const active = input.active === undefined ? true : input.active === true;
  if (active && memberIds.length === 0) warnings.push('Équipe active sans membre : elle sera signalée comme anomalie.');

  if (errors.length || !name || !managerId) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    value: {
      name,
      managerId,
      secondaryManagerId,
      memberIds,
      productCodes: cleanList(input.productCodes),
      zones: cleanList(input.zones),
      campaignIds: cleanList(input.campaignIds),
      fallbackTeamId,
      active,
    },
  };
}

/** Une chaîne d'équipes de secours ne doit pas boucler (A → B → A). */
export function fallbackCreatesLoop(startId: string, fallbackOf: ReadonlyMap<string, string | null>): boolean {
  const seen = new Set<string>([startId]);
  let current = fallbackOf.get(startId) ?? null;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = fallbackOf.get(current) ?? null;
  }
  return false;
}

// ── Appartenance : équipes → profils (dénormalisation) ───────────────────────

export interface TeamMembership {
  id: string;
  managerId: string;
  secondaryManagerId: string | null;
  memberIds: readonly string[];
  active: boolean;
}

/**
 * Pour un utilisateur : ses équipes (actives), ses managers (champ `managerIds`, utilisé par les
 * règles Firestore) et son équipe principale (conservée si elle existe encore, sinon la première).
 */
export function deriveMembership(
  uid: string,
  teams: readonly TeamMembership[],
  currentPrimary: string | null
): { teamIds: string[]; managerIds: string[]; primaryTeamId: string | null } {
  const mine = teams.filter((t) => t.active && t.memberIds.includes(uid)).sort((a, b) => a.id.localeCompare(b.id));
  const managerIds: string[] = [];
  for (const t of mine) {
    for (const m of [t.managerId, t.secondaryManagerId]) if (m && !managerIds.includes(m)) managerIds.push(m);
  }
  const teamIds = mine.map((t) => t.id);
  const primaryTeamId = currentPrimary && teamIds.includes(currentPrimary) ? currentPrimary : (teamIds[0] ?? null);
  return { teamIds, managerIds, primaryTeamId };
}

/** Utilisateurs dont le profil doit être recalculé quand une équipe change : anciens et nouveaux membres. */
export function affectedUserIds(before: { memberIds: readonly string[] } | null, after: { memberIds: readonly string[] }): string[] {
  return [...new Set<string>([...(before?.memberIds ?? []), ...after.memberIds])];
}

// ── Profil ───────────────────────────────────────────────────────────────────

export interface WorkSlotValue {
  day: number;
  start: string;
  end: string;
}

export interface ProfilePatch {
  scope?: { productCodes: string[]; zones: string[]; campaignIds: string[]; sourceIds: string[] };
  /** null = revenir à la valeur par défaut (10). */
  newLeadsCap?: number | null;
  capacityOverride?: { value: number; fromMs: number; untilMs: number; reason: string } | null;
  distributionSuspended?: boolean;
  schedule?: { timezone: string; weekly: WorkSlotValue[]; breaks: WorkSlotValue[] };
  /** null = retirer la date de fin d'accès. */
  accessEndsAtMs?: number | null;
}

export function validateSlots(label: string, v: unknown, errors: string[]): WorkSlotValue[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`${label} : liste attendue.`);
    return [];
  }
  const out: WorkSlotValue[] = [];
  v.forEach((slot, i) => {
    const where = `${label} n°${i + 1}`;
    if (!isObj(slot)) {
      errors.push(`${where} : invalide.`);
      return;
    }
    const day = intInRange(slot.day, 0, 6);
    if (day === null) errors.push(`${where} : jour entre 0 (dimanche) et 6 (samedi).`);
    const start = typeof slot.start === 'string' && HHMM.test(slot.start) ? slot.start : null;
    const end = typeof slot.end === 'string' && HHMM.test(slot.end) ? slot.end : null;
    if (!start || !end) errors.push(`${where} : heures au format HH:mm.`);
    else if (toMinutes(end) <= toMinutes(start)) errors.push(`${where} : la fin doit être après le début.`);
    if (day !== null && start && end && toMinutes(end) > toMinutes(start)) out.push({ day, start, end });
  });
  return out;
}

export function validateProfilePatch(input: unknown, nowMs: number): Validated<ProfilePatch> {
  if (!isObj(input)) return { ok: false, errors: ['Données manquantes.'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const patch: ProfilePatch = {};

  if (input.scope !== undefined) {
    if (!isObj(input.scope)) errors.push('Périmètre invalide.');
    else {
      const s = input.scope;
      patch.scope = {
        productCodes: cleanList(s.productCodes),
        zones: cleanList(s.zones),
        campaignIds: cleanList(s.campaignIds),
        sourceIds: cleanList(s.sourceIds),
      };
      if (patch.scope.productCodes.length === 0 || patch.scope.zones.length === 0) {
        warnings.push('Périmètre vide sur les produits ou les zones : cet utilisateur ne recevra aucun lead (utiliser « * » pour tout autoriser).');
      }
    }
  }

  if (input.newLeadsCap !== undefined) {
    if (input.newLeadsCap === null) patch.newLeadsCap = null;
    else {
      const cap = intInRange(input.newLeadsCap, 0, 100);
      if (cap === null) errors.push('Plafond de nouveaux leads : entier entre 0 et 100, ou vide pour la valeur par défaut.');
      else patch.newLeadsCap = cap;
    }
  }

  if (input.capacityOverride !== undefined) {
    if (input.capacityOverride === null) patch.capacityOverride = null;
    else if (!isObj(input.capacityOverride)) errors.push('Dérogation de capacité invalide.');
    else {
      const o = input.capacityOverride;
      const value = intInRange(o.value, 0, 100);
      const fromMs = typeof o.fromMs === 'number' && Number.isFinite(o.fromMs) ? o.fromMs : null;
      const untilMs = typeof o.untilMs === 'number' && Number.isFinite(o.untilMs) ? o.untilMs : null;
      const reason = cleanString(o.reason, 500);
      // §20.7 : valeur, période, motif et retour automatique obligatoires ; sans date de fin = refusée.
      if (value === null) errors.push('Dérogation : valeur entière entre 0 et 100.');
      if (fromMs === null || untilMs === null) errors.push('Dérogation : une date de début et une date de fin sont obligatoires.');
      else if (untilMs <= fromMs) errors.push('Dérogation : la fin doit être après le début.');
      else if (untilMs <= nowMs) errors.push('Dérogation : la date de fin est déjà passée.');
      if (!reason) errors.push('Dérogation : le motif est obligatoire.');
      if (value !== null && fromMs !== null && untilMs !== null && untilMs > fromMs && untilMs > nowMs && reason) {
        patch.capacityOverride = { value, fromMs, untilMs, reason };
      }
    }
  }

  if (input.distributionSuspended !== undefined) {
    if (typeof input.distributionSuspended !== 'boolean') errors.push('Distribution suspendue : vrai ou faux.');
    else patch.distributionSuspended = input.distributionSuspended;
  }

  if (input.schedule !== undefined) {
    if (!isObj(input.schedule)) errors.push('Horaires invalides.');
    else {
      const tz = cleanString(input.schedule.timezone) ?? 'Europe/Paris';
      if (!isValidTimezone(tz)) errors.push(`Fuseau horaire inconnu : ${tz}.`);
      const weekly = validateSlots('Plage de travail', input.schedule.weekly, errors);
      const breaks = validateSlots('Pause', input.schedule.breaks, errors);
      patch.schedule = { timezone: tz, weekly, breaks };
      if (weekly.length === 0) warnings.push("Aucune plage de travail : l'utilisateur sera toujours « hors horaires ».");
    }
  }

  if (input.accessEndsAtMs !== undefined) {
    if (input.accessEndsAtMs === null) patch.accessEndsAtMs = null;
    else if (typeof input.accessEndsAtMs !== 'number' || !Number.isFinite(input.accessEndsAtMs)) {
      errors.push("Date de fin d'accès invalide.");
    } else patch.accessEndsAtMs = input.accessEndsAtMs;
  }

  if (errors.length) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: false, errors: ['Aucune modification demandée.'] };
  return { ok: true, value: patch, warnings };
}

// ── Source ───────────────────────────────────────────────────────────────────

export const SOURCE_KINDS = ['meta', 'google', 'site', 'agency', 'import', 'manual'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceValue {
  name: string;
  kind: SourceKind;
  enabled: boolean;
}

export function validateSource(input: unknown): Validated<SourceValue> {
  if (!isObj(input)) return { ok: false, errors: ['Données manquantes.'] };
  const errors: string[] = [];
  const name = cleanString(input.name, 80);
  if (!name) errors.push('Le nom de la source est obligatoire.');
  const kind = SOURCE_KINDS.find((k) => k === input.kind);
  if (!kind) errors.push(`Type de source : ${SOURCE_KINDS.join(', ')}.`);
  if (errors.length || !name || !kind) return { ok: false, errors };
  return { ok: true, warnings: [], value: { name, kind, enabled: input.enabled === undefined ? true : input.enabled === true } };
}

// ── Campagne ─────────────────────────────────────────────────────────────────

export interface CampaignContext {
  /** Sources existantes : id → activée ? */
  sources: ReadonlyMap<string, { enabled: boolean }>;
  /** Équipes existantes : id → active et nombre de membres. */
  teams: ReadonlyMap<string, { active: boolean; memberCount: number }>;
  /** Utilisateurs pouvant recevoir des leads (compte actif, rôle télépro). */
  eligibleUsers: ReadonlySet<string>;
  /** Une autre campagne utilise déjà cet identifiant externe. */
  externalIdTaken: boolean;
}

export interface CampaignValue {
  name: string;
  sourceId: string;
  externalId: string | null;
  productCode: string | null;
  zones: string[];
  status: CampaignStatus;
  budgetCents: number | null;
  startsAtMs: number | null;
  endsAtMs: number | null;
  eligibleTeamIds: string[];
  eligibleUserIds: string[];
  fallbackTeamId: string | null;
  maxReassignments: number | null;
  /**
   * « Tous les télépros autorisés pour ce produit » (§19.2, fig. 16) : aucune restriction d'équipe ;
   * seuls le produit, la zone, la capacité, etc. filtrent les télépros.
   */
  autoEligible: boolean;
  /** Horaires de réception des leads (§19.2). Enregistrés ; pas encore appliqués par le moteur. */
  receptionSchedule: { timezone: string; weekly: WorkSlotValue[] } | null;
}

export function validateCampaign(input: unknown, ctx: CampaignContext): Validated<CampaignValue> {
  if (!isObj(input)) return { ok: false, errors: ['Données manquantes.'] };
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = cleanString(input.name, 120);
  if (!name) errors.push('Le nom interne est obligatoire.');
  const sourceId = cleanString(input.sourceId);
  if (!sourceId) errors.push('La source est obligatoire.');
  else if (!ctx.sources.has(sourceId)) errors.push('Source inconnue.');

  const status: CampaignStatus | null =
    input.status === undefined ? 'draft' : (CAMPAIGN_STATUSES.find((s) => s === input.status) ?? null);
  if (!status) errors.push(`Statut : ${CAMPAIGN_STATUSES.join(', ')}.`);

  const externalId = cleanString(input.externalId);
  if (externalId && ctx.externalIdTaken) {
    errors.push('Cet identifiant externe est déjà utilisé par une autre campagne : les leads ne pourraient pas être rattachés sans ambiguïté.');
  }

  const productCode = cleanString(input.productCode);
  const zones = cleanList(input.zones);

  let budgetCents: number | null = null;
  if (input.budgetCents !== undefined && input.budgetCents !== null) {
    if (typeof input.budgetCents !== 'number' || !Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
      errors.push('Budget : montant en centimes, entier positif.');
    } else budgetCents = input.budgetCents;
  }

  const startsAtMs = typeof input.startsAtMs === 'number' ? input.startsAtMs : null;
  const endsAtMs = typeof input.endsAtMs === 'number' ? input.endsAtMs : null;
  if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
    errors.push('La date de fin doit être après la date de début.');
  }

  const eligibleTeamIds = cleanList(input.eligibleTeamIds);
  const eligibleUserIds = cleanList(input.eligibleUserIds);
  const fallbackTeamId = cleanString(input.fallbackTeamId);
  for (const t of [...eligibleTeamIds, ...(fallbackTeamId ? [fallbackTeamId] : [])]) {
    if (!ctx.teams.has(t)) errors.push(`Équipe inconnue : ${t}.`);
  }
  for (const u of eligibleUserIds) {
    if (!ctx.eligibleUsers.has(u)) {
      errors.push(`Un télépro choisi n'a pas de profil de distribution, ou son compte n'est pas actif (${u}) : configurez-le d'abord dans « Utilisateurs ».`);
    }
  }

  let maxReassignments: number | null = null;
  if (input.maxReassignments !== undefined && input.maxReassignments !== null) {
    const m = intInRange(input.maxReassignments, 0, 20);
    if (m === null) errors.push('Nombre maximal de réattributions : entier entre 0 et 20.');
    else maxReassignments = m;
  }

  if (input.autoEligible !== undefined && typeof input.autoEligible !== 'boolean') errors.push("« Tous les télépros autorisés » : vrai ou faux.");
  const autoEligible = input.autoEligible === true;

  let receptionSchedule: CampaignValue['receptionSchedule'] = null;
  if (input.receptionSchedule !== undefined && input.receptionSchedule !== null) {
    if (!isObj(input.receptionSchedule)) errors.push('Horaires de réception invalides.');
    else {
      const tz = cleanString(input.receptionSchedule.timezone) ?? 'Europe/Paris';
      if (!isValidTimezone(tz)) errors.push(`Fuseau horaire inconnu : ${tz}.`);
      const weekly = validateSlots('Horaires de réception', input.receptionSchedule.weekly, errors);
      receptionSchedule = weekly.length > 0 ? { timezone: tz, weekly } : null;
    }
  }

  // §19.2 : l'activation est bloquée si la configuration minimale ou le circuit d'attribution est incomplet.
  if (status === 'active') {
    if (!externalId) errors.push("Activation impossible : l'identifiant externe est obligatoire (il sert à rattacher les leads).");
    if (!productCode) errors.push('Activation impossible : le produit est obligatoire.');
    if (zones.length === 0) errors.push('Activation impossible : au moins une zone est obligatoire.');
    if (sourceId && ctx.sources.get(sourceId)?.enabled === false) errors.push('Activation impossible : la source est désactivée.');

    const usableTeam = (id: string) => {
      const t = ctx.teams.get(id);
      return !!t && t.active && t.memberCount > 0;
    };
    const hasCircuit = autoEligible || eligibleUserIds.length > 0 || eligibleTeamIds.some(usableTeam);
    const hasFallback = !!fallbackTeamId && usableTeam(fallbackTeamId);
    if (!hasCircuit && !hasFallback) {
      errors.push("Activation impossible : aucun télépro ni aucune équipe (active et avec des membres) n'est éligible, et il n'y a pas d'équipe de secours utilisable.");
    } else if (!hasFallback) {
      warnings.push("Pas d'équipe de secours utilisable : si plus aucun télépro n'est disponible, les leads iront en file tampon.");
    }
  }

  if (errors.length || !name || !sourceId || !status) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    value: {
      name,
      sourceId,
      externalId,
      productCode,
      zones,
      status,
      budgetCents,
      startsAtMs,
      endsAtMs,
      eligibleTeamIds,
      eligibleUserIds,
      fallbackTeamId,
      maxReassignments,
      autoEligible,
      receptionSchedule,
    },
  };
}

// ── Dépense publicitaire (§19.1, §22.4) ──────────────────────────────────────

export interface SpendValue {
  campaignId: string;
  amountCents: number;
  dateMs: number;
  note: string | null;
}

const ONE_DAY_MS = 86_400_000;

/**
 * Saisie manuelle d'une dépense. Une CORRECTION (entrée existante) exige un motif : l'ancienne et la
 * nouvelle valeur, l'auteur et la date sont conservés dans le journal d'audit (§22.4).
 */
export function validateSpend(
  input: unknown,
  ctx: { campaignExists: boolean; isCorrection: boolean; nowMs: number }
): Validated<SpendValue & { reason: string | null }> {
  if (!isObj(input)) return { ok: false, errors: ['Données manquantes.'] };
  const errors: string[] = [];

  const campaignId = cleanString(input.campaignId);
  if (!campaignId) errors.push('La campagne est obligatoire.');
  else if (!ctx.campaignExists) errors.push('Campagne introuvable.');

  const amountCents = input.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < 0 || amountCents > 10_000_000_000) {
    errors.push('Montant : un nombre positif en euros (au centime près).');
  }

  const dateMs = input.dateMs;
  if (typeof dateMs !== 'number' || !Number.isFinite(dateMs)) errors.push('La date de la dépense est obligatoire.');
  else if (dateMs > ctx.nowMs + ONE_DAY_MS) errors.push('La date de la dépense ne peut pas être dans le futur.');

  const reason = cleanString(input.reason, 500);
  if (ctx.isCorrection && !reason) errors.push('Une correction exige un motif (il est conservé avec l\'ancienne et la nouvelle valeur).');

  if (errors.length || !campaignId || typeof amountCents !== 'number' || typeof dateMs !== 'number') return { ok: false, errors };
  return { ok: true, warnings: [], value: { campaignId, amountCents, dateMs, note: cleanString(input.note, 300), reason } };
}
