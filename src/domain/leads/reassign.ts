// Réattribution manuelle d'un lead par un manager ou un administrateur (§12.8, §12.13 : « trois clics maximum »,
// motif obligatoire, historisée). Fonction PURE : elle valide, puis décrit tout ce qui change (propriétaire,
// équipe, managers, action, compteurs de charge, historique, notifications). La couche serveur
// (functions/src/reassign.ts) ne fait que l'appliquer en une transaction.
//
// Le moteur d'attribution n'est pas rejoué : le manager décide. On refuse seulement ce qui est incohérent
// (cible qui n'est pas un télépro actif avec profil, lead clôturé, même propriétaire).

import { CLOSED_LEAD_STATUSES, type LeadStatus, type Role } from '../enums';
import { bucketOf, type LoadBucket } from '../call/plan';

export interface ReassignLead {
  id: string;
  fullName: string;
  status: LeadStatus;
  ownerId: string | null;
  teamId: string | null;
  managerIds: readonly string[];
  /** Action ouverte en cours ; null si aucune (lead en file tampon). */
  nextActionId: string | null;
  reassignCount: number;
}

export interface ReassignTarget {
  uid: string;
  name: string;
  /** users/{uid}.status === 'active'. */
  accountActive: boolean;
  isTelepro: boolean;
  hasProfile: boolean;
  primaryTeamId: string | null;
  managerIds: readonly string[];
}

export interface ReassignContext {
  lead: ReassignLead;
  target: ReassignTarget;
  actorId: string;
  actorRole: Role;
  reason: unknown;
  nowMs: number;
  requestId: string;
}

export interface ReassignPlan {
  /** Nouveau propriétaire. */
  ownerId: string;
  previousOwnerId: string | null;
  teamId: string | null;
  managerIds: string[];
  reassignCount: number;
  reason: string;
  /** Lead sorti de la file tampon : une action « prendre en charge » doit être créée. */
  createTakeAction: { id: string } | null;
  /** Action existante dont le propriétaire change ; null si aucune. */
  moveActionId: string | null;
  loadFrom: Partial<Record<LoadBucket, number>>;
  loadTo: Partial<Record<LoadBucket, number>>;
  notifications: { key: string; recipientId: string; title: string; description: string; sound: 'new_lead' | null }[];
  message: string;
}

export type ReassignResult =
  | { ok: true; plan: ReassignPlan }
  | { ok: false; code: 'forbidden' | 'lead_closed' | 'invalid'; message: string };

export const MIN_REASON = 3;
export const MAX_REASON = 500;

export function planReassign(ctx: ReassignContext): ReassignResult {
  const { lead, target } = ctx;
  const fail = (code: 'forbidden' | 'lead_closed' | 'invalid', message: string): ReassignResult => ({ ok: false, code, message });

  const allowed = ctx.actorRole === 'admin' || (ctx.actorRole === 'manager' && lead.managerIds.includes(ctx.actorId));
  if (!allowed) return fail('forbidden', "Seul un manager de ce lead ou un administrateur peut le réattribuer.");
  if (CLOSED_LEAD_STATUSES.includes(lead.status) || lead.status === 'transmitting' || lead.status === 'transmission_error') {
    return fail('lead_closed', 'Ce lead est clôturé ou en cours de transmission : il ne peut plus être réattribué.');
  }
  const reason = typeof ctx.reason === 'string' ? ctx.reason.trim().slice(0, MAX_REASON) : '';
  if (reason.length < MIN_REASON) return fail('invalid', 'Le motif de réattribution est obligatoire.');

  if (!target.isTelepro) return fail('invalid', 'Un lead ne peut être confié qu’à un télépro-commercial.');
  if (!target.accountActive) return fail('invalid', `Le compte de ${target.name} n’est pas actif.`);
  if (!target.hasProfile) return fail('invalid', `${target.name} n’a pas encore de profil de distribution.`);
  if (target.uid === lead.ownerId) return fail('invalid', `${target.name} est déjà propriétaire de ce lead.`);
  // Un manager n'envoie un lead que vers un télépro de son périmètre.
  if (ctx.actorRole === 'manager' && !target.managerIds.includes(ctx.actorId)) {
    return fail('forbidden', `${target.name} n'est pas dans votre périmètre.`);
  }

  const bucket = bucketOf(lead.status);
  const fromBuffer = lead.ownerId === null;
  const managerIds = [...new Set([...lead.managerIds, ...target.managerIds])];
  const newOwnerLine = `${lead.fullName || 'Lead'}${reason ? ` — ${reason}` : ''}`;

  const notifications: ReassignPlan['notifications'] = [
    { key: 'to', recipientId: target.uid, title: fromBuffer ? 'Nouveau lead' : 'Lead réattribué', description: newOwnerLine, sound: fromBuffer ? 'new_lead' : null },
  ];
  if (lead.ownerId) {
    notifications.push({ key: 'from', recipientId: lead.ownerId, title: 'Lead retiré de votre file', description: `${lead.fullName || 'Lead'} a été confié à ${target.name} — ${reason}`, sound: null });
  }

  return {
    ok: true,
    plan: {
      ownerId: target.uid,
      previousOwnerId: lead.ownerId,
      teamId: target.primaryTeamId ?? lead.teamId,
      managerIds,
      reassignCount: lead.reassignCount + 1,
      reason,
      createTakeAction: fromBuffer && lead.status === 'new' && lead.nextActionId === null ? { id: `${lead.id}_take_new_lead_${ctx.requestId}` } : null,
      moveActionId: lead.nextActionId,
      loadFrom: lead.ownerId && bucket ? { [bucket]: -1 } : {},
      loadTo: bucket ? { [bucket]: 1 } : {},
      notifications,
      message: fromBuffer ? `Lead attribué à ${target.name}.` : `Lead réattribué à ${target.name}.`,
    },
  };
}
