// Couche Firestore de la qualification de fin d'appel : lit l'état, appelle le planificateur pur
// (src/domain/call/plan.ts), puis écrit TOUT en une transaction. Ce fichier ne décide d'aucune règle métier.
//
// Pourquoi côté serveur : un résultat d'appel clôt une action, arrête un compteur SLA, déplace des
// compteurs de charge et écrit un historique immuable. Les règles Firestore ne peuvent pas prouver cela ;
// le télépro n'a donc AUCUN droit d'écriture direct sur les leads (firestore.rules : cl_leads write: false).

import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import type { CallOutcomeInput } from '../../src/domain/call/outcomes';
import { DEFAULT_CALL_RULES, planCallOutcome, type CallRules } from '../../src/domain/call/plan';
import { statusAfterCall } from '../../src/domain/availability/status';
import { loadCallRules, loadReasonCatalog } from './settings';
import { checklistKey, resolveChecklist } from '../../src/domain/documents/checklist';

export interface QualifyArgs {
  uid: string;
  role: Role;
  leadId: string;
  /** Identifiant d'idempotence généré par le navigateur à l'ouverture du formulaire. */
  requestId: string;
  /** Statut vu par le télépro à l'ouverture : protège contre un lead modifié entre-temps (autre onglet). */
  expectedStatus: string | null;
  input: CallOutcomeInput;
  durationSeconds: number | null;
  /** Statut d'avant l'appel (menu Disponible / Pause) : rétabli quand le résultat est enregistré. */
  resumeStatus?: unknown;
  nowMs: number;
}

export type QualifyResult =
  | { ok: true; replay: boolean; summary: string; status: string; nextActionAtMs: number | null }
  | { ok: false; code: 'not_found' | 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid' | 'stale'; message: string; errors: Record<string, string> };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const d = (m: number) => new Date(m);

/** Configuration `callRules` publiée (facultative) : toute valeur absente ou invalide retombe sur le défaut. */
export function parseCallRules(raw: DocumentData | undefined): CallRules {
  const base = DEFAULT_CALL_RULES;
  if (!raw) return base;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  const delays = Array.isArray(raw.nrDelaysMinutes) && raw.nrDelaysMinutes.length > 0 && raw.nrDelaysMinutes.every((x: unknown) => typeof x === 'number' && x > 0 && x <= 60 * 24 * 30)
    ? (raw.nrDelaysMinutes as number[])
    : base.nrDelaysMinutes;
  const weekly = Array.isArray(raw.schedule?.weekly) ? raw.schedule.weekly : null;
  const tz = typeof raw.schedule?.timezone === 'string' ? raw.schedule.timezone : base.schedule.timezone;
  return {
    ...base,
    nrDelaysMinutes: delays,
    recycleAfterDays: num(raw.recycleAfterDays, base.recycleAfterDays, 1, 365),
    documentFollowUpDays: num(raw.documentFollowUpDays, base.documentFollowUpDays, 1, 60),
    promisedMarginMinutes: num(raw.promisedMarginMinutes, base.promisedMarginMinutes, 0, 24 * 60),
    schedule: weekly && weekly.length > 0 ? { timezone: tz, weekly } : base.schedule,
  };
}

export async function qualifyCall(db: Firestore, args: QualifyArgs): Promise<QualifyResult> {
  const { nowMs } = args;
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`qualify_${args.requestId}`.slice(0, 200));

  // Configuration lue hors transaction : elle change rarement.
  const configured = await loadCallRules(db);
  let rules = configured;
  if (!rules) {
    // Aucun réglage enregistré dans Paramètres : anciens documents cl_config, sinon valeurs du cahier.
    const cfgSnap = await db.collection(COL.config).doc('callRules').get();
    rules = parseCallRules(cfgSnap.exists ? (cfgSnap.data() as DocumentData) : undefined);
  }
  // Motifs modifiables dans Paramètres : lus avec les règles, hors transaction.
  rules = { ...rules, reasons: await loadReasonCatalog(db) };

  const result = await db.runTransaction(async (tx): Promise<QualifyResult> => {
    // ── lectures ──
    const [leadSnap, idemSnap] = await Promise.all([tx.get(leadRef), tx.get(idemRef)]);

    // Rejeu du même formulaire (double clic, reprise réseau) : on rend le résultat déjà enregistré.
    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) {
        return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.', errors: {} };
      }
      return { ok: true, replay: true, summary: String(idemSnap.get('summary') ?? ''), status: String(idemSnap.get('status') ?? ''), nextActionAtMs: (idemSnap.get('nextActionAtMs') as number | null) ?? null };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.', errors: {} };
    const lead = leadSnap.data()!;

    if (args.expectedStatus !== null && lead.status !== args.expectedStatus) {
      return { ok: false, code: 'stale', message: "Ce lead a changé depuis l'ouverture de l'écran (autre onglet ou autre utilisateur). Rechargez la page.", errors: {} };
    }

    // Pièces à demander : checklist du produit du lead (cl_checklists), sinon celle par défaut, sinon la liste d'origine.
    let planRules = rules;
    if (args.input.kind === 'request_documents') {
      const key = checklistKey(lead.productCode);
      const [own, def] = await Promise.all([tx.get(db.collection(COL.checklists).doc(key)), tx.get(db.collection(COL.checklists).doc('default'))]);
      planRules = { ...rules, documentTypes: resolveChecklist(lead.productCode, { [key]: own.data(), default: def.data() }).items };
    }

    const result = planCallOutcome(args.input, {
      lead: {
        id: args.leadId,
        status: lead.status,
        ownerId: lead.ownerId ?? null,
        productCode: lead.productCode ?? null,
        nr: { attempt: Number(lead.nr?.attempt ?? 0), cycle: Number(lead.nr?.cycle ?? 1) },
        nextActionId: lead.nextAction?.actionId ?? null,
      },
      actorId: args.uid,
      actorRole: args.role,
      nowMs,
      requestId: args.requestId,
      durationSeconds: args.durationSeconds,
      rules: planRules,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message, errors: result.errors };
    const plan = result.plan;

    const ownerId: string = lead.ownerId;
    const managerIds = arr(lead.managerIds);

    // Lecture du profil propriétaire avant toute écriture (compteurs de charge).
    const profileRef = db.collection(COL.profiles).doc(ownerId);
    const hasLoad = Object.keys(plan.loadDelta).length > 0;
    const profileSnap = await tx.get(profileRef);

    // ── écritures ──
    const at = d(nowMs);
    const patch: Record<string, unknown> = {
      status: plan.status,
      subStatus: plan.subStatus,
      updatedAt: at,
      version: FieldValue.increment(1),
    };
    if (plan.temperature) patch.temperature = plan.temperature;
    if (plan.lastNote) patch.lastNote = { text: plan.lastNote, at, authorId: args.uid };
    if (plan.slaStopAtMs !== null) {
      patch['sla.stoppedAt'] = d(plan.slaStopAtMs);
      patch['sla.nextAlertAt'] = null;
    }
    if (plan.nr) patch.nr = { attempt: plan.nr.attempt, cycle: plan.nr.cycle, lastAt: d(plan.nr.lastAtMs), nextAt: plan.nr.nextAtMs === null ? null : d(plan.nr.nextAtMs) };
    if (plan.quality) {
      patch['quality.excluded'] = true;
      patch['quality.excludedReason'] = plan.quality.reason;
    }
    if (plan.documents) {
      const mandatory = plan.documents.types.filter((t) => t.mandatory).length;
      patch['documents.state'] = 'requested';
      patch['documents.expected'] = plan.documents.types.length;
      patch['documents.received'] = 0;
      patch['documents.conform'] = 0;
      patch['documents.mandatory'] = mandatory;
      patch['documents.mandatoryConform'] = 0;
      patch['documents.toCheck'] = 0;
      patch['documents.followUpCount'] = 0;
      patch['documents.lastFollowUpAt'] = null;
      patch['documents.lastReceivedAt'] = null;
      patch['documents.completedAt'] = null;
      patch['documents.missing'] = plan.documents.types.map((t) => ({ code: t.code, label: t.label, status: 'expected', koReason: null }));
      patch['documents.lastRequestAt'] = at;
      patch['documents.nextFollowUpAt'] = plan.documents.nextFollowUpAtMs === null ? null : d(plan.documents.nextFollowUpAtMs);
      patch['documents.promisedAt'] = plan.documents.promisedAtMs === null ? null : d(plan.documents.promisedAtMs);
    }
    patch.nextAction = plan.nextAction
      ? { actionId: plan.nextAction.id, type: plan.nextAction.type, dueAt: d(plan.nextAction.dueAtMs), priority: plan.nextAction.priority, reason: plan.nextAction.reason }
      : null;
    tx.update(leadRef, patch);

    // Historique immuable : identifiants dérivés de la demande, donc sans doublon possible.
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

    const attemptRef = leadRef.collection(SUB.callAttempts).doc(args.requestId);
    tx.set(attemptRef, {
      id: attemptRef.id,
      userId: args.uid,
      at,
      result: plan.callAttempt.result,
      nrNumber: plan.callAttempt.nrNumber,
      durationSeconds: plan.callAttempt.durationSeconds,
      note: plan.callAttempt.note,
      nextAttemptAt: plan.callAttempt.nextAttemptAtMs === null ? null : d(plan.callAttempt.nextAttemptAtMs),
    });

    if (plan.completedActionId) {
      tx.set(db.collection(COL.actions).doc(plan.completedActionId), { state: 'done', result: plan.outcome, completedAt: at, updatedAt: at }, { merge: true });
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

    if (plan.documents) {
      for (const t of plan.documents.types) {
        const ref = leadRef.collection(SUB.documents).doc(t.code);
        tx.set(ref, {
          id: ref.id,
          typeCode: t.code,
          label: t.label,
          mandatory: t.mandatory,
          status: 'expected',
          koReason: null,
          koComment: null,
          file: null,
          receivedAt: null,
          channel: plan.documents.channel,
          checkedBy: null,
          checkedAt: null,
          ai: null,
          createdAt: at,
          updatedAt: at,
        }, { merge: true });
      }
    }

    if (profileSnap.exists) {
      const upd: Record<string, unknown> = {};
      if (hasLoad) for (const [k, v] of Object.entries(plan.loadDelta)) upd[`load.${k}`] = FieldValue.increment(v as number);
      // Fin d'appel : le statut « En appel » posé au démarrage est rétabli (celui d'avant l'appel, sinon Disponible).
      if (profileSnap.get('operationalStatus') === 'on_call') {
        const back = statusAfterCall(args.resumeStatus);
        upd.operationalStatus = back;
        upd.operationalStatusSince = at;
        const audit = db.collection(COL.audit).doc(`status_${ownerId}_${nowMs}`);
        tx.set(audit, { id: audit.id, at, actorId: args.uid, action: 'operational_status_changed', entityType: 'profile', entityId: ownerId, before: { operationalStatus: 'on_call' }, after: { operationalStatus: back }, reason: 'fin d\'appel' });
      }
      if (Object.keys(upd).length > 0) tx.update(profileRef, { ...upd, updatedAt: at });
    }

    if (plan.notifyManagers && managerIds.length > 0) {
      const ref = db.collection(COL.notifications).doc(`${args.leadId}_${args.requestId}_manager`);
      tx.set(ref, {
        id: ref.id,
        type: 'fake_lead_check',
        title: plan.notifyManagers.title,
        description: plan.notifyManagers.body.slice(0, 300),
        leadId: args.leadId,
        recipientIds: managerIds,
        sound: null,
        readBy: [],
        createdAt: at,
      });
    }

    tx.set(idemRef, {
      uid: args.uid,
      leadId: args.leadId,
      summary: plan.summary,
      status: plan.status,
      nextActionAtMs: plan.nextAction?.dueAtMs ?? null,
      createdAt: at,
    });

    return { ok: true, replay: false, summary: plan.summary, status: plan.status, nextActionAtMs: plan.nextAction?.dueAtMs ?? null };
  });

  return result;
}
