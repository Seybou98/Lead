// Couche Firestore du montage et de la création de la vente (§11) : lit le lead, son brouillon, sa demande de
// validation et ses pièces, appelle le planificateur pur (src/domain/conversion/plan.ts), puis écrit TOUT en une
// transaction (brouillon, validation, vente, conversion, statut du lead, historique, notifications, compteurs).
// Aucune règle métier ici.
//
// Pourquoi côté serveur : la vente et son numéro doivent être uniques (RG14), l'approbation d'un manager ne doit
// pas pouvoir être écrite par le demandeur, et le navigateur n'a aucun droit d'écriture sur ces données.

import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { DEFAULT_CONVERSION_RULES } from '../../src/domain/conversion/controls';
import { sanitizeDraft, type MontageDraft } from '../../src/domain/conversion/montage';
import { noValidation, planConversionAction, type ConversionActionInput, type StoredValidation } from '../../src/domain/conversion/plan';

export interface ConversionArgs {
  uid: string;
  role: Role;
  leadId: string;
  requestId: string;
  input: ConversionActionInput;
  nowMs: number;
}

export type ConversionResult =
  | { ok: true; replay: boolean; message: string; status: string; validationState: string; saleNumber: string | null }
  | { ok: false; code: 'not_found' | 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid'; message: string };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const d = (m: number) => new Date(m);
const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const plain = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** Validation lue en base → forme du planificateur (document absent : aucune demande). */
export function toStoredValidation(data: DocumentData | undefined): StoredValidation {
  if (!data) return noValidation();
  const state = ['pending', 'approved', 'refused', 'correction'].includes(data.state) ? data.state : 'none';
  return {
    state,
    fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
    requestedBy: typeof data.requestedBy === 'string' ? data.requestedBy : null,
    requestedAtMs: toMs(data.requestedAt),
    message: typeof data.message === 'string' ? data.message : '',
    exceptions: Array.isArray(data.exceptions) ? data.exceptions : [],
    decidedBy: typeof data.decidedBy === 'string' ? data.decidedBy : null,
    decidedAtMs: toMs(data.decidedAt),
    comment: typeof data.comment === 'string' ? data.comment : '',
  };
}

export async function applyConversionAction(db: Firestore, args: ConversionArgs): Promise<ConversionResult> {
  const { nowMs } = args;
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`conv_${args.requestId}`.slice(0, 200));
  const draftRef = leadRef.collection(SUB.montage).doc('draft');
  const validationRef = leadRef.collection(SUB.montage).doc('validation');
  const saleRef = db.collection(COL.sales).doc(args.leadId);
  const conversionRef = db.collection(COL.conversions).doc(args.leadId);
  const year = new Date(nowMs).getUTCFullYear();
  const counterRef = db.collection(COL.counters).doc(`sales_${year}`);

  return db.runTransaction(async (tx): Promise<ConversionResult> => {
    const [leadSnap, idemSnap, draftSnap, validationSnap, docsSnap, saleSnap, counterSnap] = await Promise.all([
      tx.get(leadRef),
      tx.get(idemRef),
      tx.get(draftRef),
      tx.get(validationRef),
      tx.get(leadRef.collection(SUB.documents)),
      tx.get(saleRef),
      args.input.kind === 'create_sale' ? tx.get(counterRef) : Promise.resolve(null),
    ]);

    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.' };
      return { ok: true, replay: true, message: String(idemSnap.get('message') ?? ''), status: String(idemSnap.get('status') ?? ''), validationState: String(idemSnap.get('validationState') ?? ''), saleNumber: (idemSnap.get('saleNumber') as string | null) ?? null };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    const lead = leadSnap.data()!;

    // RG14 : une vente existe déjà pour ce lead → on rend l'existante, jamais une seconde (double clic, reprise réseau).
    if (args.input.kind === 'create_sale' && saleSnap.exists) {
      const allowed = args.role === 'admin' || (args.role === 'manager' && arr(lead.managerIds).includes(args.uid)) || (args.role === 'telepro' && lead.ownerId === args.uid);
      if (!allowed) return { ok: false, code: 'forbidden', message: 'Accès refusé à ce dossier.' };
      return { ok: true, replay: true, message: `La vente ${saleSnap.get('number')} existe déjà.`, status: String(lead.status), validationState: toStoredValidation(validationSnap.data()).state, saleNumber: String(saleSnap.get('number')) };
    }

    const mandatory = docsSnap.docs.filter((s) => s.get('mandatory') === true);
    const conform = mandatory.filter((s) => s.get('status') === 'conform');
    const campaignId: string | null = lead.origin?.campaignId ?? null;
    const campaignName = campaignId ? ((await tx.get(db.collection(COL.campaigns).doc(campaignId))).get('name') as string | undefined) ?? null : null;
    const draft: MontageDraft | null = draftSnap.exists ? sanitizeDraft(draftSnap.data()) : null;
    const validation = toStoredValidation(validationSnap.data());
    const seq = counterSnap ? Number(counterSnap.get('n') ?? 0) + 1 : 0;

    const result = planConversionAction(args.input, {
      lead: {
        id: args.leadId,
        status: lead.status,
        ownerId: lead.ownerId ?? null,
        managerIds: arr(lead.managerIds),
        fullName: typeof lead.fullName === 'string' ? lead.fullName : '',
        consent: typeof lead.consent === 'boolean' ? lead.consent : null,
        productCode: typeof lead.productCode === 'string' ? lead.productCode : null,
        campaignName,
      },
      draft,
      // « Validé avec réserve » : une pièce conforme portant `reserve: true` (réglage à venir côté documents).
      docs: { mandatory: mandatory.length, mandatoryConform: conform.length, withReserve: conform.filter((s) => s.get('reserve') === true).length },
      qualificationMissing: [],
      validation,
      nextSaleSeq: seq,
      actorId: args.uid,
      actorRole: args.role,
      nowMs,
      requestId: args.requestId,
      rules: DEFAULT_CONVERSION_RULES,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const plan = result.plan;

    const ownerId: string | null = lead.ownerId ?? null;
    const profileRef = ownerId ? db.collection(COL.profiles).doc(ownerId) : null;
    const profileSnap = profileRef && Object.keys(plan.loadDelta).length > 0 ? await tx.get(profileRef) : null;

    // ── écritures ──
    const at = d(nowMs);
    const patch: Record<string, unknown> = {
      status: plan.status,
      updatedAt: at,
      version: FieldValue.increment(1),
      'montage.validationState': plan.summary.validationState,
      'montage.blocking': plan.summary.blocking,
      'montage.toConfirm': plan.summary.toConfirm,
      'montage.totalTtcCents': plan.summary.totalTtcCents,
      'montage.remainderCents': plan.summary.remainderCents,
      'montage.updatedAt': at,
      // Mode de règlement (comptant ou crédit), pour le filtre de l'espace Ventes.
      'montage.financingMode': (plan.draft ?? draft)?.offer.financing.mode ?? null,
    };
    if (plan.sale) {
      patch.saleId = args.leadId;
      patch.commercialState = 'sale_committed';
      patch.conversion = { state: 'pending', clientId: null, dossierId: null, convertedAt: null };
      patch.nextAction = null;
    }
    tx.update(leadRef, patch);

    if (plan.draft) tx.set(draftRef, { ...plain(plan.draft), updatedAt: at, updatedBy: args.uid });
    if (plan.validation) {
      const v = plan.validation;
      tx.set(validationRef, {
        state: v.state,
        fingerprint: v.fingerprint,
        requestedBy: v.requestedBy,
        requestedAt: v.requestedAtMs === null ? null : d(v.requestedAtMs),
        message: v.message,
        exceptions: plain(v.exceptions),
        decidedBy: v.decidedBy,
        decidedAt: v.decidedAtMs === null ? null : d(v.decidedAtMs),
        comment: v.comment,
        updatedAt: at,
      });
    }

    if (plan.sale) {
      const s = plan.sale;
      tx.set(counterRef, { n: seq, year, updatedAt: at }, { merge: true });
      tx.set(saleRef, {
        id: args.leadId,
        leadId: args.leadId,
        number: s.number,
        state: 'created',
        totalHtCents: s.totalHtCents,
        totalTtcCents: s.totalTtcCents,
        mprCents: s.mprCents,
        ceeCents: s.ceeCents,
        discountCents: s.discountCents,
        remainderCents: s.remainderCents,
        lines: plain(s.lines),
        financing: plain(s.financing),
        client: plain(s.client),
        project: plain(s.project),
        aids: plain(s.aids),
        productCode: s.productCode,
        campaignId,
        campaignName: s.campaignName,
        sourceId: lead.origin?.sourceId ?? null,
        ownerId: s.ownerId,
        teamId: lead.teamId ?? null,
        managerIds: arr(lead.managerIds),
        validatedBy: s.validatedBy,
        createdBy: args.uid,
        createdAt: at,
        updatedAt: at,
      });
      // Une seule conversion par lead (id = leadId) : la transmission au CRM principal repart toujours de ce document.
      tx.set(conversionRef, {
        leadId: args.leadId,
        idempotencyKey: `sale_${args.leadId}`,
        state: 'pending',
        saleId: args.leadId,
        clientId: null,
        dossierId: null,
        attempts: 0,
        lastError: null,
        requestedBy: args.uid,
        createdAt: at,
        updatedAt: at,
      });
    }

    for (const e of plan.events) {
      const ref = leadRef.collection(SUB.events).doc(`${args.requestId}_${e.key}`);
      tx.set(ref, {
        id: ref.id,
        type: e.type,
        at,
        actorId: args.uid,
        ...(e.before ? { before: e.before } : {}),
        ...(e.after ? { after: e.after } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.note ? { note: e.note } : {}),
        ...(e.meta ? { meta: e.meta } : {}),
      });
    }

    // Journal d'audit : toute dérogation, décision ou création de vente est tracée avec auteur et horodatage (§11.10).
    if (plan.action !== 'save_draft') {
      const auditRef = db.collection(COL.audit).doc();
      tx.set(auditRef, {
        id: auditRef.id,
        at,
        actorId: args.uid,
        action: `conversion.${plan.action}${plan.action === 'decide' ? `.${(args.input as { decision: string }).decision}` : ''}`,
        entityType: 'lead',
        entityId: args.leadId,
        before: plain({ status: plan.statusBefore, validationState: validation.state }),
        after: plain({ status: plan.status, validationState: plan.summary.validationState, saleNumber: plan.sale?.number ?? null, totalTtcCents: plan.summary.totalTtcCents }),
        reason: plan.validation?.comment || plan.validation?.message || null,
      });
    }

    for (const n of plan.notifications) {
      if (n.recipientIds.length === 0) continue;
      const ref = db.collection(COL.notifications).doc(`${args.requestId}_${n.key}`);
      tx.set(ref, { id: ref.id, type: 'conversion', title: n.title, description: n.description.slice(0, 300), leadId: args.leadId, recipientIds: n.recipientIds, sound: n.sound, readBy: [], createdAt: at });
    }

    if (profileRef && profileSnap?.exists) {
      const upd: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(plan.loadDelta)) upd[`load.${k}`] = FieldValue.increment(v as number);
      tx.update(profileRef, { ...upd, updatedAt: at });
    }

    const saleNumber = plan.sale?.number ?? null;
    tx.set(idemRef, { uid: args.uid, leadId: args.leadId, message: plan.message, status: plan.status, validationState: plan.summary.validationState, saleNumber, createdAt: at });
    return { ok: true, replay: false, message: plan.message, status: plan.status, validationState: plan.summary.validationState, saleNumber };
  });
}
