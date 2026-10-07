// Construction des candidats à l'attribution à partir des documents lus en base.
// Fonction pure : la lecture Firestore se contente de lui passer les données.

import type { OperationalStatus } from '../enums';
import { resolveLeadRole } from '../../config/roles';
import type { Candidate } from '../engine/assignment';
import { isWithinSchedule, type ScheduleLike } from '../engine/schedule';

/** Au-delà de ce délai sans battement de présence, l'utilisateur est considéré déconnecté. */
export const PRESENCE_TTL_MS = 2 * 60 * 1000;

export interface ProfileInput {
  uid: string;
  primaryTeamId: string | null;
  teamIds: readonly string[];
  managerIds: readonly string[];
  scope: { productCodes: readonly string[]; zones: readonly string[] };
  capacity: {
    newLeadsCap: number;
    override: { value: number; fromMs: number; untilMs: number } | null;
  };
  operationalStatus: OperationalStatus;
  distributionSuspended: boolean;
  accessEndsAtMs: number | null;
  lastAssignedAtMs: number | null;
  load: {
    newLeads: number;
    callbacks: number;
    interested: number;
    documents: number;
    filesToBuild: number;
    recycling: number;
  };
  schedule: ScheduleLike;
}

/** Extrait de `users/{uid}` du CRM principal. */
export interface UserInput {
  uid: string;
  role: string | null;
  status: string | null;
  name: string;
}

export interface PresenceInput {
  connected: boolean;
  lastSeenAtMs: number | null;
}

export interface AbsenceInput {
  userId: string;
  fromMs: number;
  toMs: number;
}

export interface CandidateProfileInfo {
  managerIds: readonly string[];
  primaryTeamId: string | null;
}

export function buildCandidates(args: {
  profiles: readonly ProfileInput[];
  users: Readonly<Record<string, UserInput | undefined>>;
  presence: Readonly<Record<string, PresenceInput | undefined>>;
  absences: readonly AbsenceInput[];
  nowMs: number;
  closedDates?: readonly string[];
}): { candidates: Candidate[]; profileInfo: Record<string, CandidateProfileInfo> } {
  const candidates: Candidate[] = [];
  const profileInfo: Record<string, CandidateProfileInfo> = {};

  for (const p of args.profiles) {
    const user = args.users[p.uid];
    // Seuls les télépros-commerciaux reçoivent des leads. Un manager ou un admin qui possède
    // aussi un profil (équipe, périmètre) n'entre jamais dans la distribution.
    if (!user || resolveLeadRole(user.role) !== 'telepro') continue;

    const presence = args.presence[p.uid];
    const connected =
      !!presence?.connected &&
      presence.lastSeenAtMs !== null &&
      args.nowMs - presence.lastSeenAtMs <= PRESENCE_TTL_MS;

    const absent = args.absences.some((a) => a.userId === p.uid && a.fromMs <= args.nowMs && args.nowMs <= a.toMs);

    const l = p.load;
    candidates.push({
      uid: p.uid,
      name: user.name,
      accountActive: String(user.status ?? '').toLowerCase() === 'active',
      accessEndsAtMs: p.accessEndsAtMs,
      connected,
      operationalStatus: p.operationalStatus,
      distributionSuspended: p.distributionSuspended,
      absent,
      withinSchedule: isWithinSchedule(p.schedule, args.nowMs, args.closedDates),
      teamIds: p.teamIds,
      scope: p.scope,
      newLeads: l.newLeads,
      activeLoad: l.newLeads + l.callbacks + l.interested + l.documents + l.filesToBuild + l.recycling,
      capacity: p.capacity,
      lastAssignedAtMs: p.lastAssignedAtMs,
    });
    profileInfo[p.uid] = { managerIds: p.managerIds, primaryTeamId: p.primaryTeamId };
  }

  return { candidates, profileInfo };
}
