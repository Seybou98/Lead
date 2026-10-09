// Couche Firestore du workflow documentaire : lit le lead et ses pièces, appelle le planificateur pur
// (src/domain/documents/plan.ts), puis écrit TOUT en une transaction (pièces, résumé du lead, statut, action,
// historique, compteurs de charge). Ce fichier ne décide d'aucune règle métier.
//
// Pourquoi côté serveur : un contrôle de pièce peut faire passer un dossier à « prêt à monter », déplacer des
// compteurs et clore une action. Les règles Firestore ne peuvent pas le prouver ; le navigateur n'a donc aucun
// droit d'écriture direct sur les leads ni sur leurs pièces.

import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { loadDocumentRules, loadReasonCatalog } from './settings';
import { COL, SUB } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import {
  DEFAULT_DOCUMENT_RULES,
  planDocumentAction,
  type DocRow,
  type DocumentActionInput,
  type DocumentRules,
} from '../../src/domain/documents/plan';

export interface DocumentsArgs {
  uid: string;
  role: Role;
  leadId: string;
  requestId: string;
  input: DocumentActionInput;
  nowMs: number;
}

export type DocumentsResult =
  | { ok: true; replay: boolean; message: string; status: string; state: string; nextActionAtMs: number | null }
  | { ok: false; code: 'not_found' | 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid'; message: string };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const d = (m: number) => new Date(m);
const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

/** Configuration `documentRules` (facultative) : toute valeur absente ou invalide retombe sur le défaut. */
export function parseDocumentRules(raw: DocumentData | undefined, callRules?: DocumentData): DocumentRules {
  const base = DEFAULT_DOCUMENT_RULES;
  const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback);
  const days =
    raw && Array.isArray(raw.followUpDays) && raw.followUpDays.length > 0 &&
    raw.followUpDays.every((x: unknown, i: number, a: unknown[]) => typeof x === 'number' && x >= 1 && x <= 120 && (i === 0 || x > (a[i - 1] as number)))
      ? (raw.followUpDays as number[])
      : base.followUpDays;
  const weekly = Array.isArray(callRules?.schedule?.weekly) ? callRules!.schedule.weekly : null;
  const tz = typeof callRules?.schedule?.timezone === 'string' ? callRules.schedule.timezone : base.schedule.timezone;
  return {
    followUpDays: days,
    decisionRepeatDays: num(raw?.decisionRepeatDays, base.decisionRepeatDays, 1, 60),
    promisedMarginMinutes: num(callRules?.promisedMarginMinutes, base.promisedMarginMinutes, 0, 24 * 60),
    recycleAfterDays: num(callRules?.recycleAfterDays, base.recycleAfterDays, 1, 365),
    schedule: weekly && weekly.length > 0 ? { timezone: tz, weekly } : base.schedule,
  };
}

export async function applyDocumentAction(db: Firestore, args: DocumentsArgs): Promise<DocumentsResult> {
  const { nowMs } = args;
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`docs_${args.requestId}`.slice(0, 200));

  let rules = await loadDocumentRules(db);
  if (!rules) {
    // Aucun réglage enregistré dans Paramètres : anciens documents cl_config, sinon valeurs du cahier.
    const [docRulesSnap, callRulesSnap] = await Promise.all([db.collection(COL.config).doc('documentRules').get(), db.collection(COL.config).doc('callRules').get()]);
    rules = parseDocumentRules(docRulesSnap.exists ? (docRulesSnap.data() as DocumentData) : undefined, callRulesSnap.exists ? (callRulesSnap.data() as DocumentData) : undefined);
  }

  rules = { ...rules, reasons: await loadReasonCatalog(db) };

  return db.runTransaction(async (tx): Promise<DocumentsResult> => {
    const [leadSnap, idemSnap, docsSnap] = await Promise.all([tx.get(leadRef), tx.get(idemRef), tx.get(leadRef.collection(SUB.documents))]);

    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) {
        return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.' };
      }
      return { ok: true, replay: true, message: String(idemSnap.get('message') ?? ''), status: String(idemSnap.get('status') ?? ''), state: String(idemSnap.get('state') ?? ''), nextActionAtMs: (idemSnap.get('nextActionAtMs') as number | null) ?? null };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    const lead = leadSnap.data()!;
    const docs: DocRow[] = docsSnap.docs.map((s) => ({
      code: String(s.get('typeCode') ?? s.id),
      label: (s.get('label') as string | undefined) ?? null,
      mandatory: s.get('mandatory') === true,
      status: s.get('status'),
      koReason: s.get('koReason') ?? null,
      koReasonLabel: s.get('koReasonLabel') ?? null,
    }));

    const ownerId: string | null = lead.ownerId ?? null;
    const managerIds = arr(lead.managerIds);
    const result = planDocumentAction(args.input, {
      lead: {
        id: args.leadId,
        status: lead.status,
        ownerId,
        managerIds,
        nextActionId: lead.nextAction?.actionId ?? null,
        lastRequestAtMs: toMs(lead.documents?.lastRequestAt),
        lastFollowUpAtMs: toMs(lead.documents?.lastFollowUpAt),
        followUpCount: Number(lead.documents?.followUpCount ?? 0),
        promisedAtMs: toMs(lead.documents?.promisedAt),
      },
      docs,
      actorId: args.uid,
      actorRole: args.role,
      nowMs,
      requestId: args.requestId,
      rules,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const plan = result.plan;

    const profileRef = ownerId ? db.collection(COL.profiles).doc(ownerId) : null;
    const profileSnap = profileRef && Object.keys(plan.loadDelta).length > 0 ? await tx.get(profileRef) : null;

    // ── écritures ──
    const at = d(nowMs);
    const patch: Record<string, unknown> = {
      status: plan.status,
      updatedAt: at,
      version: FieldValue.increment(1),
      'documents.state': plan.summary.state,
      'documents.expected': plan.summary.expected,
      'documents.received': plan.summary.received,
      'documents.conform': plan.summary.conform,
      'documents.mandatory': plan.summary.mandatory,
      'documents.mandatoryConform': plan.summary.mandatoryConform,
      'documents.toCheck': plan.summary.toCheck,
      'documents.missing': plan.leadDocuments.missing,
      'documents.followUpCount': plan.leadDocuments.followUpCount,
      'documents.lastFollowUpAt': plan.leadDocuments.lastFollowUpAtMs === null ? null : d(plan.leadDocuments.lastFollowUpAtMs),
      'documents.nextFollowUpAt': plan.leadDocuments.nextFollowUpAtMs === null ? null : d(plan.leadDocuments.nextFollowUpAtMs),
    };
    if (plan.leadDocuments.clearPromised) patch['documents.promisedAt'] = null;
    if (plan.leadDocuments.lastReceivedAtMs !== undefined) patch['documents.lastReceivedAt'] = d(plan.leadDocuments.lastReceivedAtMs);
    if (plan.leadDocuments.completedAtMs !== undefined) patch['documents.completedAt'] = plan.leadDocuments.completedAtMs === null ? null : d(plan.leadDocuments.completedAtMs);
    patch.nextAction = plan.nextAction
      ? { actionId: plan.nextAction.id, type: plan.nextAction.type, dueAt: d(plan.nextAction.dueAtMs), priority: plan.nextAction.priority, reason: plan.nextAction.reason }
      : null;
    tx.update(leadRef, patch);

    for (const p of plan.docPatches) {
      const ref = leadRef.collection(SUB.documents).doc(p.code);
      tx.set(
        ref,
        {
          status: p.status,
          koReason: p.koReason,
          koReasonLabel: p.koReasonLabel ?? null,
          koComment: p.koComment,
          ...(p.receivedAtMs !== undefined ? { receivedAt: d(p.receivedAtMs) } : {}),
          ...(p.channel !== undefined ? { channel: p.channel } : {}),
          ...(p.file !== undefined ? { file: p.file } : {}),
          ...(p.checkedBy !== undefined ? { checkedBy: p.checkedBy } : {}),
          ...(p.checkedAtMs !== undefined ? { checkedAt: p.checkedAtMs === null ? null : d(p.checkedAtMs) } : {}),
          updatedAt: at,
        },
        { merge: true }
      );
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

    if (plan.completedActionId) {
      tx.set(db.collection(COL.actions).doc(plan.completedActionId), { state: 'done', result: `documents_${plan.action}`, completedAt: at, updatedAt: at }, { merge: true });
    }
    if (plan.nextAction) {
      const a = plan.nextAction;
      tx.set(db.collection(COL.actions).doc(a.id), {
        id: a.id,
        leadId: args.leadId,
        ownerId,
        teamId: lead.teamId ?? null,
        managerIds,
        type: a.type,
        priority: a.priority,
        state: 'open',
        dueAt: d(a.dueAtMs),
        reason: a.reason,
        result: null,
        completedAt: null,
        snoozedUntil: null,
        dedupeKey: a.dedupeKey,
        createdAt: at,
        updatedAt: at,
      });
    }

    if (profileRef && profileSnap?.exists) {
      const upd: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(plan.loadDelta)) upd[`load.${k}`] = FieldValue.increment(v as number);
      tx.update(profileRef, { ...upd, updatedAt: at });
    }

    tx.set(idemRef, { uid: args.uid, leadId: args.leadId, message: plan.message, status: plan.status, state: plan.summary.state, nextActionAtMs: plan.nextAction?.dueAtMs ?? null, createdAt: at });
    return { ok: true, replay: false, message: plan.message, status: plan.status, state: plan.summary.state, nextActionAtMs: plan.nextAction?.dueAtMs ?? null };
  });
}
