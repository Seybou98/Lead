// Écritures d'administration DIRECTES depuis le navigateur (chemin principal).
//
// Aucune logique métier ici : chaque écriture lit les données nécessaires, appelle un plan pur de
// src/domain/admin/plans.ts (le même que celui des fonctions de secours, testé), puis écrit dans
// une transaction. Le contrôle d'accès est celui des règles Firestore (administrateur actif
// uniquement, champs protégés, audit en ajout seul) : voir firebase/firestore.dev.rules.
//
// Limite connue : le SDK web ne sait pas lire une collection dans une transaction. Les listes
// (équipes, sources, profils) sont donc lues juste AVANT la transaction ; deux administrateurs qui
// modifient la même équipe à la même seconde pourraient se marcher dessus. Les fonctions de secours
// (Admin SDK) n'ont pas cette limite.

import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type DocumentData,
  type DocumentReference,
  type Transaction,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { COL } from '../domain/collections';
import { cleanString } from '../domain/admin/validate';
import { parseSlaSettings } from '../domain/settings/settings';
import {
  AdminRuleError,
  asRecord,
  campaignDependencies,
  optionalId,
  planAssignmentConfig,
  planCampaignSave,
  planChecklistSave,
  planRulesSave,
  planSlaOverrideSave,
  planSlaSave,
  planProfileUpdate,
  planSourceSave,
  planSpendSave,
  planTeamSave,
  teamDependencies,
  type AuditDraft,
  type OtherTeam,
  type UserSnapshot,
} from '../domain/admin/plans';

export interface DirectResult {
  ok: true;
  id: string;
  warnings: string[];
}

/**
 * Une transaction est limitée à 20 accès aux règles ; chaque écriture en consomme un, plus l'équipe et
 * l'audit. Au-delà de 16 profils modifiés d'un coup, on refuse proprement plutôt que d'échouer à mi-chemin.
 */
const MAX_PROFILE_WRITES = 16;

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const userSnap = (d: { exists: () => boolean; get: (f: string) => unknown }): UserSnapshot => ({
  exists: d.exists(),
  role: (d.get('role') as string | undefined) ?? null,
  status: (d.get('status') as string | undefined) ?? null,
});

function actorId(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new AdminRuleError('failed-precondition', 'Votre session a expiré. Reconnectez-vous.');
  return uid;
}

/** Entrée d'audit en ajout seul. `at` = heure du serveur (les règles refusent une autre valeur). */
function writeAudit(tx: Transaction, actor: string, a: AuditDraft) {
  const ref = doc(collection(db, COL.audit));
  const plain = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
  tx.set(ref, { id: ref.id, at: serverTimestamp(), actorId: actor, ...a, before: plain(a.before), after: plain(a.after) });
}

const newOrExisting = (col: string, id: string | null): DocumentReference => (id ? doc(db, col, id) : doc(collection(db, col)));
const data = (snap: { exists: () => boolean; data: () => DocumentData | undefined }): DocumentData | null => (snap.exists() ? (snap.data() ?? null) : null);

// ── Équipe ───────────────────────────────────────────────────────────────────

export async function saveTeamDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const ref = newOrExisting(COL.teams, optionalId(d.id));
  const nowMs = Date.now();

  // TOUTES les lectures se font dans la transaction : une lecture de collection hors transaction peut
  // renvoyer l'état d'avant (écouteurs temps réel de l'écran, écriture à peine validée) et faire
  // « oublier » une équipe créée juste avant. On ne lit que ce qui est concerné.
  return runTransaction(db, async (tx) => {
    const before = data(await tx.get(ref));
    const deps = teamDependencies(d, before);
    const [users, profiles] = await Promise.all([
      Promise.all(deps.userIds.map((u) => tx.get(doc(db, 'users', u)))),
      Promise.all(deps.profileUids.map((u) => tx.get(doc(db, COL.profiles, u)))),
    ]);

    // Équipes concernées : celles de chaque membre touché (liste dénormalisée dans son profil), puis la
    // chaîne des équipes de secours (pour détecter une boucle). Lecture en largeur, bornée.
    const read = new Map<string, OtherTeam>();
    const fetchTeam = async (id: string) => {
      if (id === ref.id || read.has(id)) return;
      const snap = await tx.get(doc(db, COL.teams, id));
      if (!snap.exists()) return;
      read.set(id, {
        id,
        managerId: String(snap.get('managerId') ?? ''),
        secondaryManagerId: (snap.get('secondaryManagerId') as string | null) ?? null,
        memberIds: arr(snap.get('memberIds')),
        active: snap.get('active') !== false,
        fallbackTeamId: (snap.get('fallbackTeamId') as string | null) ?? null,
      });
    };
    const memberTeamIds = new Set(profiles.flatMap((p) => arr(p.get('teamIds'))));
    await Promise.all([...memberTeamIds].map(fetchTeam));
    let next = cleanString(d.fallbackTeamId);
    for (let depth = 0; next && depth < 25; depth++) {
      await fetchTeam(next);
      next = read.get(next)?.fallbackTeamId ?? null;
    }

    const plan = planTeamSave({
      input: d,
      teamId: ref.id,
      before,
      otherTeams: [...read.values()],
      users: new Map(users.map((s) => [s.id, userSnap(s)])),
      profiles: new Map(profiles.map((s) => [s.id, { exists: s.exists(), primaryTeamId: (s.get('primaryTeamId') as string | null) ?? null }])),
      nowMs,
    });

    if (plan.profileWrites.length > MAX_PROFILE_WRITES) {
      throw new AdminRuleError(
        'failed-precondition',
        `Trop de membres modifiés en une seule fois (${plan.profileWrites.length}, maximum ${MAX_PROFILE_WRITES}) : modifiez l'équipe en plusieurs fois.`
      );
    }

    tx.set(ref, plan.team);
    for (const w of plan.profileWrites) {
      const pref = doc(db, COL.profiles, w.uid);
      if (w.mode === 'update') tx.update(pref, w.data);
      else tx.set(pref, w.data);
    }
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: ref.id, warnings: plan.warnings };
  });
}

// ── Profil ───────────────────────────────────────────────────────────────────

export async function saveProfileDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const uid = optionalId(d.uid);
  if (!uid) throw new AdminRuleError('invalid-argument', "L'identifiant de l'utilisateur est obligatoire.");
  const nowMs = Date.now();

  return runTransaction(db, async (tx) => {
    const [u, p] = await Promise.all([tx.get(doc(db, 'users', uid)), tx.get(doc(db, COL.profiles, uid))]);
    const plan = planProfileUpdate({ uid, input: d, user: userSnap(u), before: data(p), actorId: actor, nowMs });
    tx.set(doc(db, COL.profiles, uid), plan.next);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: uid, warnings: plan.warnings };
  });
}

// ── Checklist documentaire ───────────────────────────────────────────────────

export async function saveChecklistDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const nowMs = Date.now();
  // Le plan donne la clé (une famille = un document) : on lit l'existant avant de recalculer le plan complet.
  const probe = planChecklistSave({ input, before: null, actorId: actor, nowMs });
  const ref = doc(db, COL.checklists, probe.key);
  return runTransaction(db, async (tx) => {
    const plan = planChecklistSave({ input, before: data(await tx.get(ref)), actorId: actor, nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: plan.key, warnings: [] };
  });
}

/** Retire la checklist d'une famille : elle retombe sur la checklist « par défaut ». */
export async function deleteChecklistDirect(key: string): Promise<DirectResult> {
  const actor = actorId();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) throw new AdminRuleError('invalid-argument', 'Checklist inconnue.');
  const ref = doc(db, COL.checklists, key);
  return runTransaction(db, async (tx) => {
    const before = data(await tx.get(ref));
    if (!before) throw new AdminRuleError('not-found', "Cette checklist n'existe pas.");
    tx.delete(ref);
    writeAudit(tx, actor, { action: 'checklist.delete', entityType: 'checklist', entityId: key, before, after: null, reason: null });
    return { ok: true as const, id: key, warnings: [] };
  });
}

// ── Réglages : SLA et horaires, cycles NR ────────────────────────────────────

export async function saveSlaDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const nowMs = Date.now();
  const ref = doc(db, COL.settings, 'sla');
  return runTransaction(db, async (tx) => {
    const plan = planSlaSave({ input, before: data(await tx.get(ref)), actorId: actor, nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: 'sla', warnings: [] };
  });
}

export async function saveRulesDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const nowMs = Date.now();
  const ref = doc(db, COL.settings, 'rules');
  return runTransaction(db, async (tx) => {
    const plan = planRulesSave({ input, before: data(await tx.get(ref)), actorId: actor, nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: 'rules', warnings: [] };
  });
}

/** Règle de réattribution d'une campagne : validée avec les réglages généraux, qui restent la base. */
export async function saveSlaOverrideDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const campaignId = optionalId(d.campaignId);
  if (!campaignId) throw new AdminRuleError('invalid-argument', 'La campagne est obligatoire.');
  const nowMs = Date.now();
  const ref = doc(db, COL.settings, `sla_${campaignId}`);
  const generalRef = doc(db, COL.settings, 'sla');
  return runTransaction(db, async (tx) => {
    const [cur, general] = await Promise.all([tx.get(ref), tx.get(generalRef)]);
    const plan = planSlaOverrideSave({ campaignId, input: d, general: parseSlaSettings(data(general) ?? undefined), before: data(cur), actorId: actor, nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: ref.id, warnings: [] };
  });
}

/** Retire la règle propre à une campagne : elle retombe sur les réglages généraux. */
export async function deleteSlaOverrideDirect(campaignId: string): Promise<DirectResult> {
  const actor = actorId();
  const id = optionalId(campaignId);
  if (!id) throw new AdminRuleError('invalid-argument', 'Campagne inconnue.');
  const ref = doc(db, COL.settings, `sla_${id}`);
  return runTransaction(db, async (tx) => {
    const before = data(await tx.get(ref));
    if (!before) throw new AdminRuleError('not-found', "Cette campagne n'a pas de règle propre.");
    tx.delete(ref);
    writeAudit(tx, actor, { action: 'settings.sla.campaign.delete', entityType: 'settings', entityId: ref.id, before, after: null, reason: null });
    return { ok: true as const, id: ref.id, warnings: [] };
  });
}

// ── Source ───────────────────────────────────────────────────────────────────

export async function saveSourceDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const ref = newOrExisting(COL.sources, optionalId(d.id));
  const nowMs = Date.now();

  return runTransaction(db, async (tx) => {
    const plan = planSourceSave({ input: d, sourceId: ref.id, before: data(await tx.get(ref)), nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: ref.id, warnings: plan.warnings };
  });
}

// ── Campagne ─────────────────────────────────────────────────────────────────

export async function saveCampaignDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const ref = newOrExisting(COL.campaigns, optionalId(d.id));
  const nowMs = Date.now();

  // Unicité de l'identifiant externe : requête précise (aucun écouteur de l'écran ne porte dessus).
  const externalId = typeof d.externalId === 'string' ? d.externalId.trim() : '';
  const dup = externalId ? await getDocs(query(collection(db, COL.campaigns), where('externalId', '==', externalId))) : null;
  const externalIdTaken = !!dup?.docs.some((x) => x.id !== ref.id);

  // Source, équipes et télépros référencés : lus DANS la transaction (voir saveTeamDirect). Une source
  // créée une seconde plus tôt par le même clic doit être vue : une lecture de collection ne le garantit pas.
  return runTransaction(db, async (tx) => {
    const before = data(await tx.get(ref));
    const deps = campaignDependencies(d);
    const [source, teams, users, profiles] = await Promise.all([
      deps.sourceId ? tx.get(doc(db, COL.sources, deps.sourceId)) : Promise.resolve(null),
      Promise.all(deps.teamIds.map((t) => tx.get(doc(db, COL.teams, t)))),
      Promise.all(deps.userIds.map((u) => tx.get(doc(db, 'users', u)))),
      Promise.all(deps.userIds.map((u) => tx.get(doc(db, COL.profiles, u)))),
    ]);

    const plan = planCampaignSave({
      input: d,
      campaignId: ref.id,
      before,
      context: {
        sources: source?.exists() ? [{ id: source.id, enabled: source.get('enabled') !== false }] : [],
        teams: teams.filter((t) => t.exists()).map((t) => ({ id: t.id, active: t.get('active') !== false, memberCount: arr(t.get('memberIds')).length })),
        // Un télépro n'est éligible que s'il a un profil de distribution ET un compte actif.
        profileUsers: users
          .filter((u, i) => u.exists() && profiles[i].exists())
          .map((u) => ({ uid: u.id, role: (u.get('role') as string | undefined) ?? null, status: (u.get('status') as string | undefined) ?? null })),
        externalIdTaken,
      },
      nowMs,
    });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: ref.id, warnings: plan.warnings };
  });
}

export async function saveAssignmentConfigDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const id = optionalId(d.campaignId);
  if (!id) throw new AdminRuleError('invalid-argument', 'La campagne est obligatoire.');
  const nowMs = Date.now();

  return runTransaction(db, async (tx) => {
    const ref = doc(db, COL.campaigns, id);
    const plan = planAssignmentConfig({ input: d, campaignId: id, before: data(await tx.get(ref)) });
    tx.update(ref, { assignmentConfig: plan.config, updatedAt: new Date(nowMs) });
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id, warnings: [] };
  });
}

// ── Dépenses ─────────────────────────────────────────────────────────────────

export async function saveSpendDirect(input: unknown): Promise<DirectResult> {
  const actor = actorId();
  const d = asRecord(input);
  const spendId = optionalId(d.id);
  const ref = newOrExisting(COL.adSpend, spendId);
  const campaignId = typeof d.campaignId === 'string' ? d.campaignId.trim() : '';
  const nowMs = Date.now();

  return runTransaction(db, async (tx) => {
    const [b, c] = await Promise.all([tx.get(ref), campaignId ? tx.get(doc(db, COL.campaigns, campaignId)) : Promise.resolve(null)]);
    const plan = planSpendSave({ input: d, spendId: ref.id, isCorrectionRequest: !!spendId, before: data(b), campaignExists: !!c?.exists(), actorId: actor, nowMs });
    tx.set(ref, plan.doc);
    writeAudit(tx, actor, plan.audit);
    return { ok: true as const, id: ref.id, warnings: plan.warnings };
  });
}
