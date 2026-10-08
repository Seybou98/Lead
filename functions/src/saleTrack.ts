// Couche Firestore du suivi d'une vente (§23.7 à §23.9) : lit le lead et sa vente, appelle le planificateur pur
// (src/domain/sales/track.ts), puis écrit TOUT en une transaction (états du lead et de la vente, historique, audit,
// notifications). Ce fichier ne décide d'aucune règle métier.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { planSaleAction, type SaleAction } from '../../src/domain/sales/track';

export interface SaleTrackArgs {
  uid: string;
  role: Role;
  leadId: string;
  requestId: string;
  action: SaleAction;
  nowMs: number;
}

export type SaleTrackOutcome =
  | { ok: true; replay: boolean; message: string; commercialState: string; financialState: string; secured: boolean }
  | { ok: false; code: 'not_found' | 'forbidden' | 'unavailable' | 'invalid'; message: string };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

export async function applySaleAction(db: Firestore, args: SaleTrackArgs): Promise<SaleTrackOutcome> {
  const { nowMs } = args;
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const saleRef = db.collection(COL.sales).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`sale_${args.requestId}`.slice(0, 200));
  const at = new Date(nowMs);

  return db.runTransaction(async (tx): Promise<SaleTrackOutcome> => {
    const [leadSnap, saleSnap, idemSnap] = await Promise.all([tx.get(leadRef), tx.get(saleRef), tx.get(idemRef)]);
    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.' };
      return { ok: true, replay: true, message: String(idemSnap.get('message') ?? ''), commercialState: String(idemSnap.get('commercialState') ?? ''), financialState: String(idemSnap.get('financialState') ?? ''), secured: idemSnap.get('secured') === true };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    const lead = leadSnap.data()!;

    const result = planSaleAction(args.action, {
      lead: {
        id: args.leadId,
        status: String(lead.status),
        ownerId: lead.ownerId ?? null,
        managerIds: arr(lead.managerIds),
        fullName: typeof lead.fullName === 'string' ? lead.fullName : '',
        saleId: typeof lead.saleId === 'string' ? lead.saleId : null,
        commercialState: typeof lead.commercialState === 'string' ? lead.commercialState : 'none',
        financialState: typeof lead.financialState === 'string' ? lead.financialState : 'none',
        securedAtMs: toMs(lead.securedAt),
      },
      saleNumber: saleSnap.exists ? String(saleSnap.get('number') ?? '') : '',
      remainderCents: saleSnap.exists ? Number(saleSnap.get('remainderCents') ?? 0) : 0,
      actorId: args.uid,
      actorRole: args.role,
      nowMs,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const plan = result.plan;

    // ── écritures ──
    const leadPatch: Record<string, unknown> = { commercialState: plan.commercialState, financialState: plan.financialState, updatedAt: at, version: FieldValue.increment(1) };
    const salePatch: Record<string, unknown> = { commercialState: plan.commercialState, financialState: plan.financialState, updatedAt: at };
    for (const [k, v] of Object.entries(plan.trackPatch)) {
      // Les horodatages sont écrits en dates Firestore ; les montants et textes tels quels.
      const value = /At$/.test(k) && typeof v === 'number' ? new Date(v) : v;
      leadPatch[`saleTrack.${k}`] = value;
      salePatch[`track.${k}`] = value;
    }
    if (plan.action === 'reminder') {
      leadPatch['saleTrack.reminderCount'] = FieldValue.increment(1);
      salePatch['track.reminderCount'] = FieldValue.increment(1);
    }
    if (plan.newlySecuredAtMs !== null) {
      leadPatch.securedAt = new Date(plan.newlySecuredAtMs);
      salePatch.securedAt = new Date(plan.newlySecuredAtMs);
    }
    tx.update(leadRef, leadPatch);
    if (saleSnap.exists) tx.update(saleRef, salePatch);

    for (const e of plan.events) {
      const ref = leadRef.collection(SUB.events).doc(`${args.requestId}_${e.key}`);
      tx.set(ref, { id: ref.id, type: 'conversion', at, actorId: args.uid, note: e.note, ...(e.reason ? { reason: e.reason } : {}), meta: e.meta });
    }

    // Journal d'audit : toute évolution de la vente est tracée avec avant / après, auteur et horodatage (§11.10), sauf une simple relance.
    if (plan.action !== 'reminder') {
      const auditRef = db.collection(COL.audit).doc();
      tx.set(auditRef, {
        id: auditRef.id,
        at,
        actorId: args.uid,
        action: `sale.${plan.action}`,
        entityType: 'lead',
        entityId: args.leadId,
        before: plain({ commercialState: lead.commercialState ?? 'none', financialState: lead.financialState ?? 'none' }),
        after: plain({ commercialState: plan.commercialState, financialState: plan.financialState, secured: plan.newlySecuredAtMs !== null }),
        reason: plan.events[0]?.reason ?? null,
      });
    }

    for (const n of plan.notifications) {
      if (n.recipientIds.length === 0) continue;
      const ref = db.collection(COL.notifications).doc(`${args.requestId}_${n.key}`);
      tx.set(ref, { id: ref.id, type: 'conversion', title: n.title, description: n.description.slice(0, 300), leadId: args.leadId, recipientIds: n.recipientIds, sound: n.sound, readBy: [], createdAt: at });
    }

    const secured = plan.newlySecuredAtMs !== null || toMs(lead.securedAt) !== null;
    tx.set(idemRef, { uid: args.uid, leadId: args.leadId, message: plan.message, commercialState: plan.commercialState, financialState: plan.financialState, secured, createdAt: at });
    return { ok: true, replay: false, message: plan.message, commercialState: plan.commercialState, financialState: plan.financialState, secured };
  });
}
