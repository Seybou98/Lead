// Modèle d'affichage de l'écran « Utilisateurs & équipes » (§20.1, §20.4, §20.10, fig. 20).
// Fonctions pures : l'écran lit Firestore et leur passe les données, sans rien calculer lui-même.
// Les chiffres des cartes viennent des MÊMES lignes que le tableau, donc ils ne peuvent pas diverger.

import { resolveLeadRole } from '../../config/roles';
import type { OperationalStatus, Role } from '../enums';
import { effectiveCap } from '../engine/assignment';
import { normalizeText } from '../engine/normalize';
import { PRESENCE_TTL_MS } from '../ingest/candidates';

export interface MainUserView {
  uid: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
}

export interface ProfileView {
  uid: string;
  primaryTeamId: string | null;
  teamIds: readonly string[];
  scope: { productCodes: readonly string[]; zones: readonly string[] };
  capacity: { newLeadsCap: number; override: { value: number; fromMs: number; untilMs: number } | null };
  operationalStatus: OperationalStatus;
  distributionSuspended: boolean;
  newLeads: number;
  accessEndsAtMs: number | null;
}

export interface TeamView {
  id: string;
  name: string;
  managerId: string;
  secondaryManagerId: string | null;
  memberIds: readonly string[];
  active: boolean;
}

export interface PresenceView {
  connected: boolean;
  lastSeenAtMs: number | null;
}

export type DistributionState = 'active' | 'suspended' | 'paused' | 'full' | 'no_profile' | 'not_applicable';

export interface UserRow {
  uid: string;
  name: string;
  email: string;
  role: Role;
  accountActive: boolean;
  hasProfile: boolean;
  teamIds: string[];
  teamNames: string[];
  products: string[];
  zones: string[];
  newLeads: number | null;
  cap: number | null;
  /** Utilisateur réellement connecté (battement de présence récent). */
  connected: boolean;
  operationalStatus: OperationalStatus | null;
  distribution: DistributionState;
}

const BLOCKING_STATUSES: readonly OperationalStatus[] = ['paused', 'absent', 'unavailable', 'in_meeting'];

export function isConnected(p: PresenceView | undefined, nowMs: number): boolean {
  return !!p && p.connected && p.lastSeenAtMs !== null && nowMs - p.lastSeenAtMs <= PRESENCE_TTL_MS;
}

export function buildUserRows(
  users: readonly MainUserView[],
  profiles: ReadonlyMap<string, ProfileView>,
  teams: readonly TeamView[],
  presence: ReadonlyMap<string, PresenceView>,
  nowMs: number,
  defaultCap = 10
): UserRow[] {
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const rows: UserRow[] = [];

  for (const u of users) {
    const role = resolveLeadRole(u.role);
    if (!role) continue; // Rôle sans accès au module : jamais listé ici.
    const accountActive = String(u.status ?? '').trim().toLowerCase() === 'active';
    const profile = profiles.get(u.uid);
    const connected = isConnected(presence.get(u.uid), nowMs);

    const base = {
      uid: u.uid,
      name: u.name || u.email || u.uid,
      email: u.email,
      role,
      accountActive,
      connected,
    };

    if (role !== 'telepro') {
      // Managers et administrateurs : pas de capacité ni de distribution.
      rows.push({
        ...base,
        hasProfile: false,
        teamIds: [],
        teamNames: [],
        products: [],
        zones: [],
        newLeads: null,
        cap: null,
        operationalStatus: null,
        distribution: 'not_applicable',
      });
      continue;
    }

    if (!profile) {
      rows.push({
        ...base,
        hasProfile: false,
        teamIds: [],
        teamNames: [],
        products: [],
        zones: [],
        newLeads: null,
        cap: null,
        operationalStatus: null,
        distribution: 'no_profile',
      });
      continue;
    }

    const cap = effectiveCap(profile.capacity, nowMs, defaultCap);
    let distribution: DistributionState = 'active';
    if (profile.distributionSuspended) distribution = 'suspended';
    else if (BLOCKING_STATUSES.includes(profile.operationalStatus)) distribution = 'paused';
    else if (profile.newLeads >= cap) distribution = 'full';

    rows.push({
      ...base,
      hasProfile: true,
      teamIds: [...profile.teamIds],
      teamNames: profile.teamIds.map((id) => teamName.get(id) ?? id),
      products: [...profile.scope.productCodes],
      zones: [...profile.scope.zones],
      newLeads: profile.newLeads,
      cap,
      operationalStatus: profile.operationalStatus,
      distribution,
    });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

// ── Filtres (fig. 20 : recherche, rôle, équipe, statut, distribution) ────────

export interface UserFilters {
  search: string;
  role: Role | 'all';
  teamId: string | 'all' | 'none';
  /** Statut opérationnel, ou 'offline' pour les non connectés. */
  status: OperationalStatus | 'offline' | 'all';
  distribution: DistributionState | 'all';
}

export const NO_FILTERS: UserFilters = { search: '', role: 'all', teamId: 'all', status: 'all', distribution: 'all' };

export function filterUserRows(rows: readonly UserRow[], f: UserFilters): UserRow[] {
  const q = normalizeText(f.search);
  return rows.filter((r) => {
    if (q && !normalizeText(`${r.name} ${r.email}`).includes(q)) return false;
    if (f.role !== 'all' && r.role !== f.role) return false;
    if (f.teamId === 'none' ? r.teamIds.length > 0 : f.teamId !== 'all' && !r.teamIds.includes(f.teamId)) return false;
    if (f.status === 'offline' ? r.connected : f.status !== 'all' && (!r.connected || r.operationalStatus !== f.status)) return false;
    if (f.distribution !== 'all' && r.distribution !== f.distribution) return false;
    return true;
  });
}

// ── Cartes de synthèse et état des équipes ───────────────────────────────────

export interface UserKpis {
  activeUsers: number;
  availableTelepros: number;
  onCall: number;
  absent: number;
  capacityUsed: number;
  capacityTotal: number;
}

export function computeKpis(rows: readonly UserRow[]): UserKpis {
  const active = rows.filter((r) => r.accountActive);
  const telepros = active.filter((r) => r.role === 'telepro' && r.hasProfile);
  return {
    activeUsers: active.length,
    availableTelepros: telepros.filter((r) => r.connected && r.operationalStatus === 'available' && r.distribution === 'active').length,
    onCall: telepros.filter((r) => r.connected && r.operationalStatus === 'on_call').length,
    absent: telepros.filter((r) => r.operationalStatus === 'absent').length,
    capacityUsed: telepros.reduce((sum, r) => sum + (r.newLeads ?? 0), 0),
    capacityTotal: telepros.reduce((sum, r) => sum + (r.cap ?? 0), 0),
  };
}

export interface TeamSummary {
  id: string;
  name: string;
  memberCount: number;
  used: number;
  total: number;
  /** 0 à 100 ; 0 quand la capacité est nulle (jamais de division par zéro). */
  percent: number;
}

export function summarizeTeams(teams: readonly TeamView[], rows: readonly UserRow[]): TeamSummary[] {
  return teams
    .filter((t) => t.active)
    .map((t) => {
      const members = rows.filter((r) => r.accountActive && r.hasProfile && r.teamIds.includes(t.id));
      const used = members.reduce((s, r) => s + (r.newLeads ?? 0), 0);
      const total = members.reduce((s, r) => s + (r.cap ?? 0), 0);
      return {
        id: t.id,
        name: t.name,
        memberCount: members.length,
        used,
        total,
        percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export type AdminAlertKind = 'team_without_members' | 'capacity_reached' | 'user_without_team' | 'user_without_profile';

export interface AdminAlert {
  kind: AdminAlertKind;
  count: number;
  /** Identifiants concernés, pour ouvrir le détail. */
  ids: string[];
}

/** Anomalies à signaler à l'administrateur (§20.4, §20.10). Une alerte à zéro n'est pas renvoyée. */
export function computeAlerts(teams: readonly TeamView[], rows: readonly UserRow[]): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  const summaries = summarizeTeams(teams, rows);

  const empty = summaries.filter((s) => s.memberCount === 0).map((s) => s.id);
  if (empty.length) alerts.push({ kind: 'team_without_members', count: empty.length, ids: empty });

  const full = rows.filter((r) => r.accountActive && r.role === 'telepro' && r.distribution === 'full').map((r) => r.uid);
  if (full.length) alerts.push({ kind: 'capacity_reached', count: full.length, ids: full });

  const noProfile = rows.filter((r) => r.accountActive && r.role === 'telepro' && r.distribution === 'no_profile').map((r) => r.uid);
  if (noProfile.length) alerts.push({ kind: 'user_without_profile', count: noProfile.length, ids: noProfile });

  const noTeam = rows.filter((r) => r.accountActive && r.role === 'telepro' && r.hasProfile && r.teamIds.length === 0).map((r) => r.uid);
  if (noTeam.length) alerts.push({ kind: 'user_without_team', count: noTeam.length, ids: noTeam });

  return alerts;
}
