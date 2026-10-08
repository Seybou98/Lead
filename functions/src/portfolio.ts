// Absences et transferts de portefeuille (§20.6, §20.8, figs. 23 et 24) : couche Firestore. Les règles métier sont dans
// src/domain/portfolio (absence.ts, portfolio.ts) et src/domain/leads/reassign.ts ; ici on lit, on vérifie les droits et
// on écrit. Un transfert = une réattribution par lead (chacune sa transaction, idempotente), donc chaque lead garde sa
// chronologie, le propriétaire historique (`originalOwnerId`) et une trace d'audit.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { resolveLeadRole } from '../../src/config/roles';
import { isActiveAbsence, validateAbsence, type AbsenceInput } from '../../src/domain/portfolio/absence';
import { reassignLead } from './reassign';

export const TRANSFER_BATCH_MAX = 25;

export type PortfolioResult =
  | { ok: true; message: string; data?: Record<string, unknown> }
  | { ok: false; code: 'forbidden' | 'not_found' | 'invalid' | 'conflict'; message: string; errors?: Record<string, string> };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ms = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

/** Droit sur un télépro : administrateur, ou manager figurant dans les managers de son profil. */
async function mayManage(db: Firestore, uid: string, role: Role, userId: string): Promise<{ ok: true } | { ok: false; result: PortfolioResult }> {
  const [profile, user] = await Promise.all([db.collection(COL.profiles).doc(userId).get(), db.collection('users').doc(userId).get()]);
  if (!user.exists || resolveLeadRole(user.get('role')) !== 'telepro') return { ok: false, result: { ok: false, code: 'invalid', message: 'Seuls les télépros-commerciaux ont un portefeuille.' } };
  if (!profile.exists) return { ok: false, result: { ok: false, code: 'invalid', message: "Ce télépro n'a pas encore de profil de distribution." } };
  if (role === 'admin') return { ok: true };
  if (role === 'manager' && arr(profile.get('managerIds')).includes(uid)) return { ok: true };
  return { ok: false, result: { ok: false, code: 'forbidden', message: "Ce télépro n'est pas dans votre périmètre." } };
}

// ── Absence ──────────────────────────────────────────────────────────────────

export interface DeclareAbsenceArgs {
  uid: string;
  role: Role;
  userId: string;
  input: AbsenceInput;
  requestId: string;
  nowMs: number;
}

export async function declareAbsence(db: Firestore, a: DeclareAbsenceArgs): Promise<PortfolioResult> {
  if (!ID.test(a.userId)) return { ok: false, code: 'invalid', message: 'Télépro inconnu.' };
  const right = await mayManage(db, a.uid, a.role, a.userId);
  if (!right.ok) return right.result;

  const check = validateAbsence(a.input, a.nowMs);
  if (!check.ok) return { ok: false, code: 'invalid', message: Object.values(check.errors)[0] as string, errors: check.errors as Record<string, string> };
  const d = check.draft;

  const absRef = db.collection(COL.absences).doc(`abs_${a.requestId}`.slice(0, 200));
  const profileRef = db.collection(COL.profiles).doc(a.userId);
  const existing = await db.collection(COL.absences).where('userId', '==', a.userId).get();

  return db.runTransaction(async (tx): Promise<PortfolioResult> => {
    const [absSnap, profileSnap] = await Promise.all([tx.get(absRef), tx.get(profileRef)]);
    if (absSnap.exists) return { ok: true, message: 'Absence déjà enregistrée.', data: { absenceId: absRef.id, replay: true } };
    for (const e of existing.docs) {
      const from = ms(e.get('from'));
      const to = ms(e.get('to'));
      if (from !== null && to !== null && d.fromMs < to && d.toMs > from) {
        return { ok: false, code: 'conflict', message: 'Une absence existe déjà sur cette période : terminez-la ou choisissez d’autres dates.' };
      }
    }
    const at = new Date(a.nowMs);
    tx.set(absRef, {
      id: absRef.id,
      userId: a.userId,
      type: d.type,
      from: new Date(d.fromMs),
      to: new Date(d.toMs),
      reason: d.reason,
      restoreDistribution: d.restoreDistribution,
      handling: d.handling,
      handled: false,
      createdBy: a.uid,
      createdAt: at,
    });
    // L'absence démarre maintenant : le statut est posé sans attendre le passage du planificateur.
    // « En appel » n'est jamais écrasé : l'appel en cours se termine, le planificateur prendra le relais.
    if (isActiveAbsence({ fromMs: d.fromMs, toMs: d.toMs }, a.nowMs) && profileSnap.get('operationalStatus') !== 'on_call') {
      tx.update(profileRef, { operationalStatus: 'absent', operationalStatusSince: at, updatedAt: at });
    }
    const audit = db.collection(COL.audit).doc(`absence_${absRef.id}`.slice(0, 200));
    tx.set(audit, { id: audit.id, at, actorId: a.uid, action: 'absence.create', entityType: 'user', entityId: a.userId, before: null, after: { type: d.type, from: d.fromMs, to: d.toMs, handling: d.handling }, reason: d.reason });
    return { ok: true, message: 'Absence enregistrée : la distribution est suspendue sur la période.', data: { absenceId: absRef.id } };
  });
}

export async function endAbsence(db: Firestore, a: { uid: string; role: Role; absenceId: string; nowMs: number }): Promise<PortfolioResult> {
  if (!ID.test(a.absenceId)) return { ok: false, code: 'invalid', message: 'Absence inconnue.' };
  const ref = db.collection(COL.absences).doc(a.absenceId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'not_found', message: 'Absence introuvable.' };
  const userId = String(snap.get('userId'));
  const right = await mayManage(db, a.uid, a.role, userId);
  if (!right.ok) return right.result;
  const to = ms(snap.get('to'));
  if (to === null || to <= a.nowMs) return { ok: false, code: 'invalid', message: 'Cette absence est déjà terminée.' };

  const profileRef = db.collection(COL.profiles).doc(userId);
  return db.runTransaction(async (tx): Promise<PortfolioResult> => {
    const [cur, profile] = await Promise.all([tx.get(ref), tx.get(profileRef)]);
    const curTo = ms(cur.get('to'));
    if (!cur.exists || curTo === null || curTo <= a.nowMs) return { ok: false, code: 'invalid', message: 'Cette absence est déjà terminée.' };
    const at = new Date(a.nowMs);
    // La fin anticipée est une vraie fin : le planificateur appliquera le retour (statut, distribution) comme à l'échéance.
    tx.update(ref, { to: at, endedEarlyBy: a.uid, endedEarlyAt: at });
    if (profile.get('operationalStatus') === 'absent') tx.update(profileRef, { operationalStatus: 'available', operationalStatusSince: at, updatedAt: at });
    const audit = db.collection(COL.audit).doc(`absence_end_${a.absenceId}`.slice(0, 200));
    tx.set(audit, { id: audit.id, at, actorId: a.uid, action: 'absence.end', entityType: 'user', entityId: userId, before: { to: curTo }, after: { to: a.nowMs }, reason: 'Fin anticipée' });
    return { ok: true, message: 'Absence terminée : le télépro peut de nouveau recevoir des leads.' };
  });
}

// ── Transfert ────────────────────────────────────────────────────────────────

export interface TransferArgs {
  uid: string;
  role: Role;
  fromUid: string;
  assignments: { leadId: string; targetUid: string }[];
  reason: unknown;
  batchId: string;
  /** Transfert temporaire : instant du retour automatique chez le propriétaire d'origine. */
  returnAtMs: number | null;
  nowMs: number;
}

export async function transferLeads(db: Firestore, a: TransferArgs): Promise<PortfolioResult> {
  if (!ID.test(a.batchId) || !ID.test(a.fromUid)) return { ok: false, code: 'invalid', message: 'Demande de transfert invalide.' };
  if (!Array.isArray(a.assignments) || a.assignments.length === 0) return { ok: false, code: 'invalid', message: 'Aucun élément à transférer.' };
  if (a.assignments.length > TRANSFER_BATCH_MAX) return { ok: false, code: 'invalid', message: `${TRANSFER_BATCH_MAX} éléments au maximum par envoi.` };
  const reason = typeof a.reason === 'string' ? a.reason.trim().slice(0, 500) : '';
  if (reason.length < 3) return { ok: false, code: 'invalid', message: 'Le motif du transfert est obligatoire.' };
  if (a.returnAtMs !== null && (!Number.isFinite(a.returnAtMs) || a.returnAtMs <= a.nowMs)) return { ok: false, code: 'invalid', message: 'La date de retour doit être dans le futur.' };
  if (a.role === 'telepro') return { ok: false, code: 'forbidden', message: 'Réservé aux managers et aux administrateurs.' };

  const done: string[] = [];
  const failed: { leadId: string; message: string }[] = [];
  const targets = new Set<string>();
  for (const x of a.assignments) {
    if (!x || !ID.test(x.leadId) || !ID.test(x.targetUid)) {
      failed.push({ leadId: String(x?.leadId ?? '?'), message: 'Élément invalide.' });
      continue;
    }
    // Chaque élément repasse par la réattribution : droits, validité de la cible, historique, compteurs, audit.
    const r = await reassignLead(db, { uid: a.uid, role: a.role, leadId: x.leadId, targetUid: x.targetUid, reason, requestId: `${a.batchId}_${x.leadId}`.slice(0, 100), nowMs: a.nowMs });
    if (r.ok) {
      done.push(x.leadId);
      targets.add(x.targetUid);
    } else failed.push({ leadId: x.leadId, message: r.message });
  }

  if (done.length > 0) {
    await db.collection(COL.transfers).doc(a.batchId).set(
      {
        id: a.batchId,
        fromUid: a.fromUid,
        reason,
        createdBy: a.uid,
        createdAt: new Date(a.nowMs),
        temporary: a.returnAtMs !== null,
        returnAt: a.returnAtMs === null ? null : new Date(a.returnAtMs),
        returned: false,
        leadIds: FieldValue.arrayUnion(...done),
        toUids: FieldValue.arrayUnion(...targets),
      },
      { merge: true }
    );
  }
  if (done.length === 0) return { ok: false, code: 'invalid', message: failed[0]?.message ?? 'Aucun élément transféré.', errors: Object.fromEntries(failed.map((f) => [f.leadId, f.message])) };
  return {
    ok: true,
    message: `${done.length} élément${done.length > 1 ? 's' : ''} transféré${done.length > 1 ? 's' : ''}${failed.length ? `, ${failed.length} refusé${failed.length > 1 ? 's' : ''}` : ''}.`,
    data: { done, failed },
  };
}
