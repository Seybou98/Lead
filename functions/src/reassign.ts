// Couche Firestore de la réattribution manuelle : lit le lead et les deux télépros, appelle le planificateur pur
// (src/domain/leads/reassign.ts), puis écrit TOUT en une transaction (lead, action, compteurs de charge, historique,
// notifications, audit). Ce fichier ne décide d'aucune règle métier.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { resolveLeadRole } from '../../src/config/roles';
import { planReassign } from '../../src/domain/leads/reassign';
import { effectiveCap } from '../../src/domain/engine/assignment';
import { toProfileInput } from '../../src/domain/ingest/profileInput';

export interface ReassignArgs {
  uid: string;
  role: Role;
  leadId: string;
  targetUid: string;
  reason: unknown;
  requestId: string;
  nowMs: number;
  /**
   * Attribution automatique par le planificateur : refusée si le lead a déjà un propriétaire (course entre deux passages)
   * ou si le télépro ne peut plus recevoir de nouveau lead (plafond, suspension, pause). Un manager, lui, décide.
   */
  engine?: boolean;
  /**
   * Planificateur : propriétaire attendu au moment de la décision (null = lead en file tampon). Si le lead a changé
   * entre-temps (un télépro l'a pris, un manager l'a réattribué), l'opération est refusée.
   */
  expectOwnerId?: string | null;
}

export type ReassignOutcome =
  | { ok: true; replay: boolean; message: string; ownerId: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'lead_closed' | 'invalid'; message: string };

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function reassignLead(db: Firestore, args: ReassignArgs): Promise<ReassignOutcome> {
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`reassign_${args.requestId}`.slice(0, 200));
  const userRef = db.collection('users').doc(args.targetUid);
  const targetProfileRef = db.collection(COL.profiles).doc(args.targetUid);

  return db.runTransaction(async (tx): Promise<ReassignOutcome> => {
    const [leadSnap, idemSnap, userSnap, targetProfileSnap] = await Promise.all([tx.get(leadRef), tx.get(idemRef), tx.get(userRef), tx.get(targetProfileRef)]);

    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.' };
      return { ok: true, replay: true, message: String(idemSnap.get('message') ?? ''), ownerId: String(idemSnap.get('ownerId') ?? '') };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    const lead = leadSnap.data()!;
    const previousOwnerId: string | null = lead.ownerId ?? null;
    if (args.engine) {
      const expected = args.expectOwnerId === undefined ? null : args.expectOwnerId;
      if (previousOwnerId !== expected) return { ok: false, code: 'invalid', message: previousOwnerId ? 'Ce lead est déjà attribué.' : 'Ce lead a changé de propriétaire entre-temps.' };
      // Réattribution automatique au SLA : seulement tant que le lead n'est pas pris en charge.
      if (expected !== null && (lead.status !== 'new' || ms(lead.sla?.stoppedAt) !== null)) return { ok: false, code: 'invalid', message: 'Ce lead est déjà pris en charge.' };
      const p = toProfileInput(args.targetUid, targetProfileSnap.data() ?? {}, (v) => (v as { toMillis?: () => number } | null)?.toMillis?.() ?? null);
      const blocked = p.distributionSuspended || ['paused', 'absent', 'unavailable', 'in_meeting'].includes(p.operationalStatus);
      if (blocked || p.load.newLeads >= effectiveCap(p.capacity, args.nowMs, 10)) return { ok: false, code: 'invalid', message: 'Le télépro ne peut plus recevoir de nouveau lead.' };
    }
    const previousProfileSnap = previousOwnerId ? await tx.get(db.collection(COL.profiles).doc(previousOwnerId)) : null;

    const result = planReassign({
      lead: {
        id: args.leadId,
        fullName: String(lead.fullName ?? ''),
        status: lead.status,
        ownerId: previousOwnerId,
        teamId: lead.teamId ?? null,
        managerIds: arr(lead.managerIds),
        nextActionId: lead.nextAction?.actionId ?? null,
        reassignCount: Number(lead.reassignCount ?? 0),
      },
      target: {
        uid: args.targetUid,
        name: String(userSnap.get('name') ?? userSnap.get('email') ?? args.targetUid),
        accountActive: userSnap.exists && String(userSnap.get('status') ?? '').toLowerCase() === 'active',
        isTelepro: userSnap.exists && resolveLeadRole(userSnap.get('role')) === 'telepro',
        hasProfile: targetProfileSnap.exists,
        primaryTeamId: (targetProfileSnap.get('primaryTeamId') as string | undefined) ?? null,
        managerIds: arr(targetProfileSnap.get('managerIds')),
      },
      actorId: args.uid,
      actorRole: args.role,
      reason: args.reason,
      nowMs: args.nowMs,
      requestId: args.requestId,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const plan = result.plan;

    // ── écritures ──
    const at = new Date(args.nowMs);
    const patch: Record<string, unknown> = {
      ownerId: plan.ownerId,
      teamId: plan.teamId,
      managerIds: plan.managerIds,
      assignmentState: 'assigned',
      bufferReason: null,
      reassignCount: FieldValue.increment(1),
      lastReassignedAt: at,
      ...(lead.originalOwnerId || !previousOwnerId ? {} : { originalOwnerId: previousOwnerId }),
      updatedAt: at,
      version: FieldValue.increment(1),
    };
    if (plan.createTakeAction) {
      patch.nextAction = { actionId: plan.createTakeAction.id, type: 'take_new_lead', dueAt: at, priority: 'P1', reason: 'Nouveau lead à prendre en charge' };
    }
    tx.update(leadRef, patch);

    const eventRef = leadRef.collection(SUB.events).doc(`${args.requestId}_reassigned`);
    tx.set(eventRef, {
      id: eventRef.id,
      type: args.engine && !plan.previousOwnerId ? 'assigned' : 'reassigned',
      at,
      actorId: args.uid,
      before: { ownerId: plan.previousOwnerId },
      after: { ownerId: plan.ownerId },
      reason: plan.reason,
    });

    if (plan.moveActionId) {
      tx.set(db.collection(COL.actions).doc(plan.moveActionId), { ownerId: plan.ownerId, teamId: plan.teamId, managerIds: plan.managerIds, updatedAt: at }, { merge: true });
    }
    if (plan.createTakeAction) {
      tx.set(db.collection(COL.actions).doc(plan.createTakeAction.id), {
        id: plan.createTakeAction.id,
        leadId: args.leadId,
        ownerId: plan.ownerId,
        teamId: plan.teamId,
        managerIds: plan.managerIds,
        type: 'take_new_lead',
        priority: 'P1',
        state: 'open',
        dueAt: at,
        reason: 'Nouveau lead à prendre en charge',
        result: null,
        completedAt: null,
        snoozedUntil: null,
        dedupeKey: `${args.leadId}:take_new_lead:${args.requestId}`,
        createdAt: at,
        updatedAt: at,
      });
    }

    // Compteurs de charge : chacun n'est touché que si son profil existe.
    const delta = (d: Record<string, number | undefined>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [`load.${k}`, FieldValue.increment(v as number)]));
    if (previousProfileSnap?.exists && previousOwnerId && Object.keys(plan.loadFrom).length > 0) {
      tx.update(db.collection(COL.profiles).doc(previousOwnerId), { ...delta(plan.loadFrom), updatedAt: at });
    }
    tx.update(targetProfileRef, { ...delta(plan.loadTo), lastAssignedAt: at, updatedAt: at });

    for (const n of plan.notifications) {
      const ref = db.collection(COL.notifications).doc(`${args.leadId}_${args.requestId}_${n.key}`);
      tx.set(ref, { id: ref.id, type: 'lead_assigned', title: n.title, description: n.description.slice(0, 300), leadId: args.leadId, recipientIds: [n.recipientId], sound: n.sound, readBy: [], createdAt: at });
    }

    const audit = db.collection(COL.audit).doc(`reassign_${args.leadId}_${args.requestId}`.slice(0, 200));
    tx.set(audit, { id: audit.id, at, actorId: args.uid, action: 'lead.reassign', entityType: 'lead', entityId: args.leadId, before: { ownerId: plan.previousOwnerId }, after: { ownerId: plan.ownerId }, reason: plan.reason });

    tx.set(idemRef, { uid: args.uid, leadId: args.leadId, message: plan.message, ownerId: plan.ownerId, createdAt: at });
    return { ok: true, replay: false, message: plan.message, ownerId: plan.ownerId };
  });
}
