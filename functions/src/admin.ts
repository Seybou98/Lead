// Fonctions d'administration — chemin de SECOURS (Admin SDK).
//
// Le chemin principal est désormais l'écriture directe depuis le navigateur (src/lib/adminWrites.ts).
// Ces fonctions restent disponibles pour un durcissement ultérieur (audit non falsifiable, écriture
// interdite côté navigateur). Toute la logique métier est dans src/domain/admin/plans.ts, partagée
// avec le chemin direct : ce fichier ne fait que lire, appeler un plan, et écrire.

import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { resolveLeadRole } from '../../src/config/roles';
import { COL } from '../../src/domain/collections';
import {
  AdminRuleError,
  asRecord,
  optionalId,
  planAssignmentConfig,
  planCampaignSave,
  planProfileUpdate,
  planSourceSave,
  planSpendSave,
  planTeamSave,
  teamDependencies,
  type AuditDraft,
  type OtherTeam,
  type UserSnapshot,
} from '../../src/domain/admin/plans';

export interface AdminResult {
  ok: true;
  id: string;
  warnings: string[];
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const snapshotOf = (d: { exists: boolean; get: (f: string) => unknown }): UserSnapshot => ({
  exists: d.exists,
  role: (d.get('role') as string | undefined) ?? null,
  status: (d.get('status') as string | undefined) ?? null,
});

/** Convertit un refus métier en erreur d'appel ; toute autre erreur remonte telle quelle. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AdminRuleError) throw new HttpsError(e.code, e.message);
    throw e;
  }
}

/** Les entrées invalides (identifiant, objet) lèvent un AdminRuleError avant la transaction : même conversion. */
function sync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AdminRuleError) throw new HttpsError(e.code, e.message);
    throw e;
  }
}

/** Rejette tout appel qui ne vient pas d'un administrateur actif du CRM principal. */
export async function requireAdmin(db: Firestore, request: CallableRequest<unknown>): Promise<string> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const snap = await db.collection('users').doc(uid).get();
  const u = snapshotOf(snap);
  if (!snap.exists || String(u.status ?? '').trim().toLowerCase() !== 'active' || resolveLeadRole(u.role) !== 'admin') {
    throw new HttpsError('permission-denied', 'Réservé aux administrateurs.');
  }
  return uid;
}

function writeAudit(tx: Transaction, db: Firestore, nowMs: number, actorId: string, a: AuditDraft) {
  const ref = db.collection(COL.audit).doc();
  // JSON aller-retour : retire les types non sérialisables et garantit un objet simple.
  const plain = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
  tx.set(ref, { id: ref.id, at: new Date(nowMs), actorId, ...a, before: plain(a.before), after: plain(a.after) });
}

const docRef = (db: Firestore, col: string, id: string | null) => (id ? db.collection(col).doc(id) : db.collection(col).doc());

// ── Équipe ───────────────────────────────────────────────────────────────────

export async function upsertTeam(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const nowMs = Date.now();
  const ref = docRef(db, COL.teams, sync(() => optionalId(data.id)));

  return guard(() =>
    db.runTransaction(async (tx) => {
      const [beforeSnap, allTeams] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.teams))]);
      const before = beforeSnap.exists ? (beforeSnap.data() as DocumentData) : null;

      const deps = teamDependencies(data, before);
      const userSnaps = deps.userIds.length ? await tx.getAll(...deps.userIds.map((u) => db.collection('users').doc(u))) : [];
      const profileSnaps = deps.profileUids.length ? await tx.getAll(...deps.profileUids.map((u) => db.collection(COL.profiles).doc(u))) : [];

      const otherTeams: OtherTeam[] = allTeams.docs
        .filter((d) => d.id !== ref.id)
        .map((d) => ({
          id: d.id,
          managerId: String(d.get('managerId') ?? ''),
          secondaryManagerId: (d.get('secondaryManagerId') as string | null) ?? null,
          memberIds: arr(d.get('memberIds')),
          active: d.get('active') !== false,
          fallbackTeamId: (d.get('fallbackTeamId') as string | null) ?? null,
        }));

      const plan = planTeamSave({
        input: data,
        teamId: ref.id,
        before,
        otherTeams,
        users: new Map(userSnaps.map((s) => [s.id, snapshotOf(s)])),
        profiles: new Map(profileSnaps.map((s) => [s.id, { exists: s.exists, primaryTeamId: (s.get('primaryTeamId') as string | null) ?? null }])),
        nowMs,
      });

      tx.set(ref, plan.team);
      for (const w of plan.profileWrites) {
        const pref = db.collection(COL.profiles).doc(w.uid);
        if (w.mode === 'update') tx.update(pref, w.data);
        else tx.set(pref, w.data);
      }
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id: ref.id, warnings: plan.warnings };
    })
  );
}

// ── Profil ───────────────────────────────────────────────────────────────────

export async function updateProfile(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const uid = sync(() => optionalId(data.uid));
  if (!uid) throw new HttpsError('invalid-argument', "L'identifiant de l'utilisateur est obligatoire.");
  const nowMs = Date.now();

  return guard(() =>
    db.runTransaction(async (tx) => {
      const [userSnap, profileSnap] = await Promise.all([tx.get(db.collection('users').doc(uid)), tx.get(db.collection(COL.profiles).doc(uid))]);
      const plan = planProfileUpdate({
        uid,
        input: data,
        user: snapshotOf(userSnap),
        before: profileSnap.exists ? (profileSnap.data() as DocumentData) : null,
        actorId,
        nowMs,
      });
      tx.set(profileSnap.ref, plan.next);
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id: uid, warnings: plan.warnings };
    })
  );
}

// ── Source ───────────────────────────────────────────────────────────────────

export async function upsertSource(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const nowMs = Date.now();
  const ref = docRef(db, COL.sources, sync(() => optionalId(data.id)));

  return guard(() =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const plan = planSourceSave({ input: data, sourceId: ref.id, before: snap.exists ? (snap.data() as DocumentData) : null, nowMs });
      tx.set(ref, plan.doc);
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id: ref.id, warnings: plan.warnings };
    })
  );
}

// ── Campagne ─────────────────────────────────────────────────────────────────

export async function upsertCampaign(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const nowMs = Date.now();
  const ref = docRef(db, COL.campaigns, sync(() => optionalId(data.id)));

  // Contexte lu hors transaction : sources, équipes et télépros changent rarement, et la validation
  // d'activation est une aide à l'administrateur, pas une garantie d'unicité.
  const [sourcesSnap, teamsSnap, profilesSnap] = await Promise.all([
    db.collection(COL.sources).get(),
    db.collection(COL.teams).get(),
    db.collection(COL.profiles).get(),
  ]);
  const profileIds = profilesSnap.docs.map((d) => d.id);
  const userSnaps = profileIds.length ? await db.getAll(...profileIds.map((u) => db.collection('users').doc(u))) : [];

  const externalId = typeof data.externalId === 'string' ? data.externalId.trim() : '';
  const dup = externalId ? await db.collection(COL.campaigns).where('externalId', '==', externalId).limit(5).get() : null;
  const externalIdTaken = !!dup?.docs.some((d) => d.id !== ref.id);

  return guard(() =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const plan = planCampaignSave({
        input: data,
        campaignId: ref.id,
        before: snap.exists ? (snap.data() as DocumentData) : null,
        context: {
          sources: sourcesSnap.docs.map((d) => ({ id: d.id, enabled: d.get('enabled') !== false })),
          teams: teamsSnap.docs.map((d) => ({ id: d.id, active: d.get('active') !== false, memberCount: arr(d.get('memberIds')).length })),
          profileUsers: userSnaps.filter((u) => u.exists).map((u) => ({ uid: u.id, role: snapshotOf(u).role, status: snapshotOf(u).status })),
          externalIdTaken,
        },
        nowMs,
      });
      tx.set(ref, plan.doc);
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id: ref.id, warnings: plan.warnings };
    })
  );
}

/** Règles d'attribution d'une campagne (fig. 17) : plafond, critères activés, ordre de priorité. */
export async function updateCampaignAssignmentConfig(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const id = sync(() => optionalId(data.campaignId));
  if (!id) throw new HttpsError('invalid-argument', 'La campagne est obligatoire.');
  const nowMs = Date.now();

  return guard(() =>
    db.runTransaction(async (tx) => {
      const ref = db.collection(COL.campaigns).doc(id);
      const snap = await tx.get(ref);
      const plan = planAssignmentConfig({ input: data, campaignId: id, before: snap.exists ? (snap.data() as DocumentData) : null });
      tx.update(ref, { assignmentConfig: plan.config, updatedAt: new Date(nowMs) });
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id, warnings: [] };
    })
  );
}

// ── Dépenses publicitaires (saisie manuelle) ─────────────────────────────────

/**
 * Crée ou corrige une dépense. Une correction exige un motif ; l'ancienne et la nouvelle valeur,
 * l'auteur et la date sont conservés dans cl_audit (§22.4). Une dépense n'est jamais supprimée :
 * pour l'annuler, on la corrige à 0 avec un motif.
 */
export async function saveSpend(db: Firestore, request: CallableRequest<unknown>): Promise<AdminResult> {
  const actorId = await requireAdmin(db, request);
  const data = sync(() => asRecord(request.data));
  const nowMs = Date.now();
  const spendId = sync(() => optionalId(data.id));
  const ref = docRef(db, COL.adSpend, spendId);
  const campaignId = typeof data.campaignId === 'string' ? data.campaignId.trim() : '';

  return guard(() =>
    db.runTransaction(async (tx) => {
      const [beforeSnap, campaignSnap] = await Promise.all([tx.get(ref), campaignId ? tx.get(db.collection(COL.campaigns).doc(campaignId)) : Promise.resolve(null)]);
      const plan = planSpendSave({
        input: data,
        spendId: ref.id,
        isCorrectionRequest: !!spendId,
        before: beforeSnap.exists ? (beforeSnap.data() as DocumentData) : null,
        campaignExists: !!campaignSnap?.exists,
        actorId,
        nowMs,
      });
      tx.set(ref, plan.doc);
      writeAudit(tx, db, nowMs, actorId, plan.audit);
      return { ok: true as const, id: ref.id, warnings: plan.warnings };
    })
  );
}
