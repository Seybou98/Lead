// Changement de statut opérationnel par le télépro lui-même (menu Disponible / Pause, §12.1.4).
// Le profil CRM Leads n'est pas modifiable depuis le navigateur (statut, compteurs : réservés au serveur) ;
// toute la règle est dans src/domain/availability/status.ts, ce fichier ne fait que lire et écrire.

import { type Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import { OPERATIONAL_STATUSES, type OperationalStatus } from '../../src/domain/enums';
import { planStatusChange } from '../../src/domain/availability/status';

export interface StatusArgs {
  uid: string;
  requested: unknown;
  nowMs: number;
}

export type StatusResult =
  | { ok: true; changed: boolean; status: OperationalStatus; sinceMs: number }
  | { ok: false; code: 'not_found' | 'invalid' | 'locked'; message: string };

const currentOf = (v: unknown): OperationalStatus =>
  (OPERATIONAL_STATUSES as readonly unknown[]).includes(v) ? (v as OperationalStatus) : 'available';

export async function setOwnStatus(db: Firestore, args: StatusArgs): Promise<StatusResult> {
  const ref = db.collection(COL.profiles).doc(args.uid);

  return db.runTransaction(async (tx): Promise<StatusResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false, code: 'not_found', message: "Votre profil CRM Leads n'existe pas encore : demandez à un administrateur de vous rattacher à une équipe." };
    }

    const current = currentOf(snap.get('operationalStatus'));
    const plan = planStatusChange(current, args.requested);
    if (!plan.ok) return plan;

    const sinceMs = (snap.get('operationalStatusSince') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? args.nowMs;
    if (!plan.changed) return { ok: true, changed: false, status: plan.status, sinceMs };

    const at = new Date(args.nowMs);
    tx.update(ref, { operationalStatus: plan.status, operationalStatusSince: at, updatedAt: at });

    // Historique (§12.1.4 : tout passage temporaire est historisé). Identifiant daté : une ligne par changement.
    const audit = db.collection(COL.audit).doc(`status_${args.uid}_${args.nowMs}`);
    tx.set(audit, {
      id: audit.id,
      at,
      actorId: args.uid,
      action: 'operational_status_changed',
      entityType: 'profile',
      entityId: args.uid,
      before: { operationalStatus: current },
      after: { operationalStatus: plan.status },
      reason: null,
    });
    return { ok: true, changed: true, status: plan.status, sinceMs: args.nowMs };
  });
}
