// Couche Firestore de l'ingestion : lit, appelle le planificateur pur, écrit en UNE transaction.
// Toute la logique métier est dans src/domain/ingest/plan.ts (testée). Ce fichier ne décide de rien.

import { categoriesOf, resolveProductCode } from '../../src/domain/products/catalog';
import { applyOutsideHours } from '../../src/domain/settings/outsideHours';
import { DEFAULT_SLA_SETTINGS } from '../../src/domain/settings/settings';
import { loadSettings } from './settings';
import { FieldValue, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import type { CampaignStatus } from '../../src/domain/enums';
import type { RawLead } from '../../src/domain/models';
import { parseAssignmentConfig } from '../../src/domain/ingest/configParse';
import { mapPayload } from '../../src/domain/ingest/mapPayload';
import { toProfileInput } from '../../src/domain/ingest/profileInput';
import {
  buildCandidates,
  type AbsenceInput,
  type PresenceInput,
  type UserInput,
} from '../../src/domain/ingest/candidates';
import {
  idempotencyKeysFor,
  noContactReason,
  planIngestion,
  type CampaignInfo,
  type ExistingLead,
  type IngestionPlan,
} from '../../src/domain/ingest/plan';
import type { MappedLead } from '../../src/domain/ingest/mapPayload';

export interface IngestArgs {
  channel: RawLead['channel'];
  sourceId: string | null;
  payload: unknown;
  nowMs: number;
}

export type IngestResult =
  | { ok: true; kind: 'created'; leadId: string; rawLeadId: string; assignmentState: string; ownerId: string | null; bufferReason: string | null }
  | { ok: true; kind: 'attached'; leadId: string; rawLeadId: string; outcome: string }
  | { ok: true; kind: 'replay'; leadId: string; rawLeadId: string }
  | { ok: false; kind: 'rejected'; code: 'no_contact' | 'unknown_source' | 'source_disabled'; reason: string; rawLeadId: string };

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function ingestLead(db: Firestore, args: IngestArgs): Promise<IngestResult> {
  const { nowMs } = args;

  // 1. La donnée brute est écrite AVANT tout traitement : quoi qu'il arrive ensuite, rien n'est perdu (§24.2).
  const rawRef = db.collection(COL.rawLeads).doc();
  await rawRef.set({
    id: rawRef.id,
    receivedAt: new Date(nowMs),
    channel: args.channel,
    sourceId: args.sourceId,
    payloadJson: safeJson(args.payload),
    leadId: null,
    processingState: 'received',
  } satisfies Omit<RawLead, 'receivedAt'> & { receivedAt: Date });

  const reject = async (code: Extract<IngestResult, { kind: 'rejected' }>['code'], reason: string): Promise<IngestResult> => {
    await rawRef.update({ processingState: 'rejected', rejectionCode: code, rejectionReason: reason });
    return { ok: false, kind: 'rejected', code, reason, rawLeadId: rawRef.id };
  };

  // 2. Source
  let fieldMapping: Record<string, string> = {};
  if (args.sourceId) {
    const src = await db.collection(COL.sources).doc(args.sourceId).get();
    if (!src.exists) return reject('unknown_source', `Source inconnue : ${args.sourceId}`);
    if (src.get('enabled') === false) return reject('source_disabled', `Source désactivée : ${args.sourceId}`);
    const fm = src.get('fieldMapping');
    if (fm && typeof fm === 'object') fieldMapping = fm as Record<string, string>;
  }

  const mapped = mapPayload(args.payload, fieldMapping);
  if (!mapped.phone && !mapped.email) {
    return reject('no_contact', noContactReason(mapped));
  }

  // 3. Campagne et configuration (lecture hors transaction : elles changent rarement)
  const { campaign: resolvedCampaign, campaignData, unresolvedRef } = await resolveCampaign(db, mapped);
  const globalConfig = await readPublishedConfig(db, 'assignment');
  const productCategories = await readProductCategories(db);
  // Hors horaires commerciaux (Paramètres → SLA et horaires) : attente, attribution immédiate ou équipe de garde.
  const settings = await loadSettings(db);
  const outside = applyOutsideHours({
    config: parseAssignmentConfig(globalConfig, campaignData?.assignmentConfig),
    campaign: resolvedCampaign,
    sla: settings?.sla ?? DEFAULT_SLA_SETTINGS,
    nowMs,
  });
  const config = outside.config;
  const campaign = outside.campaign;

  // 4. Une seule transaction : lecture de l'état, décision, écriture. C'est elle qui empêche deux
  //    leads simultanés d'être donnés au même télépro au-delà du plafond, ou un doublon de passer.
  const leadRef = db.collection(COL.leads).doc();
  const keys = idempotencyKeysFor(mapped, args.sourceId);

  const plan = await db.runTransaction(async (tx): Promise<IngestionPlan> => {
    // ── lectures (toutes avant la première écriture) ──
    const keyRefs = keys.map((k) => db.collection(COL.idempotency).doc(k));
    const keySnaps = keyRefs.length ? await tx.getAll(...keyRefs) : [];
    const leadIds = new Set<string>();
    for (const s of keySnaps) if (s.exists) arr(s.get('leadIds')).forEach((id) => leadIds.add(id));

    const sameZip = mapped.address.postalCode
      ? await tx.get(db.collection(COL.leads).where('address.postalCode', '==', mapped.address.postalCode).limit(50))
      : null;
    const leadDocs = new Map<string, DocumentData>();
    sameZip?.docs.forEach((d) => leadDocs.set(d.id, d.data()));
    const missing = [...leadIds].filter((id) => !leadDocs.has(id));
    if (missing.length) {
      const snaps = await tx.getAll(...missing.map((id) => db.collection(COL.leads).doc(id)));
      snaps.forEach((s) => s.exists && leadDocs.set(s.id, s.data()!));
    }
    const existing: ExistingLead[] = [...leadDocs.entries()].map(([id, d]) => ({
      id,
      phone: d.phone ?? null,
      email: d.email ?? null,
      externalId: d.origin?.externalId ?? null,
      sourceId: d.origin?.sourceId ?? null,
      fullName: d.fullName ?? '',
      addressLine: d.address?.line ?? '',
      postalCode: d.address?.postalCode || null,
      status: d.status,
      ownerId: d.ownerId ?? null,
      managerIds: arr(d.managerIds),
    }));

    const profileSnaps = await tx.get(db.collection(COL.profiles));
    const uids = profileSnaps.docs.map((d) => d.id);
    const userSnaps = uids.length ? await tx.getAll(...uids.map((u) => db.collection('users').doc(u))) : [];
    const presenceSnaps = uids.length ? await tx.getAll(...uids.map((u) => db.collection(COL.presence).doc(u))) : [];
    const absenceSnaps = await tx.get(db.collection(COL.absences).where('to', '>=', new Date(nowMs)));
    const teamSnaps = campaign?.eligibleTeamIds.length
      ? await tx.getAll(...campaign.eligibleTeamIds.map((t) => db.collection(COL.teams).doc(t)))
      : [];

    // ── décision (fonction pure) ──
    const users: Record<string, UserInput> = {};
    userSnaps.forEach((s) => {
      if (s.exists) users[s.id] = { uid: s.id, role: s.get('role') ?? null, status: s.get('status') ?? null, name: displayName(s.data()!) };
    });
    const presence: Record<string, PresenceInput> = {};
    presenceSnaps.forEach((s) => {
      if (s.exists) presence[s.id] = { connected: s.get('connected') === true, lastSeenAtMs: ms(s.get('lastSeenAt')) };
    });
    const absences: AbsenceInput[] = [];
    absenceSnaps.forEach((s) => {
      const from = ms(s.get('from'));
      const to = ms(s.get('to'));
      if (from !== null && to !== null) absences.push({ userId: s.get('userId'), fromMs: from, toMs: to });
    });

    const { candidates, profileInfo } = buildCandidates({
      profiles: profileSnaps.docs.map((d) => toProfileInput(d.id, d.data(), ms)),
      users,
      presence,
      absences,
      nowMs,
    });

    const campaignManagerIds = new Set<string>();
    teamSnaps.forEach((s) => {
      if (!s.exists) return;
      if (typeof s.get('managerId') === 'string') campaignManagerIds.add(s.get('managerId'));
      if (typeof s.get('secondaryManagerId') === 'string') campaignManagerIds.add(s.get('secondaryManagerId'));
    });

    const result = planIngestion({
      nowMs,
      leadId: leadRef.id,
      rawLeadId: rawRef.id,
      sourceId: args.sourceId,
      channel: args.channel,
      // Le produit reçu est ramené à une famille du catalogue du CRM principal quand elle est reconnue sans ambiguïté.
      mapped: { ...mapped, productCode: resolveProductCode(mapped.productCode, productCategories) },
      campaign,
      unresolvedCampaignRef: unresolvedRef,
      existing,
      candidates,
      profileInfo,
      campaignManagerIds: [...campaignManagerIds],
      config,
    });

    // ── écritures ──
    if (result.kind === 'attached') {
      const target = db.collection(COL.leads).doc(result.targetLeadId);
      tx.set(target.collection(SUB.events).doc(result.event.id), result.event);
      tx.update(target, { updatedAt: new Date(nowMs), version: FieldValue.increment(1) });
      result.notifications.forEach((n) => tx.set(db.collection(COL.notifications).doc(n.id), n));
    } else if (result.kind === 'created') {
      tx.set(leadRef, result.lead);
      result.events.forEach((e) => tx.set(leadRef.collection(SUB.events).doc(e.id), e));
      if (result.action) tx.set(db.collection(COL.actions).doc(result.action.id), result.action);
      tx.set(db.collection(COL.distributionLog).doc(result.distribution.id), result.distribution);
      result.notifications.forEach((n) => tx.set(db.collection(COL.notifications).doc(n.id), n));
      for (const ref of keyRefs) {
        // arrayUnion : un téléphone déjà connu garde la trace de TOUS les leads qui le portent.
        tx.set(ref, { leadIds: FieldValue.arrayUnion(leadRef.id), updatedAt: new Date(nowMs) }, { merge: true });
      }
      for (const c of result.counterUpdates) {
        tx.update(db.collection(COL.profiles).doc(c.uid), {
          'load.newLeads': FieldValue.increment(c.newLeadsDelta),
          lastAssignedAt: new Date(c.lastAssignedAtMs),
          updatedAt: new Date(nowMs),
        });
      }
    }
    return result;
  });

  // 5. Issue consignée sur la donnée brute
  switch (plan.kind) {
    case 'created':
      await rawRef.update({ processingState: 'processed', leadId: leadRef.id });
      return {
        ok: true,
        kind: 'created',
        leadId: leadRef.id,
        rawLeadId: rawRef.id,
        assignmentState: plan.lead.assignmentState,
        ownerId: plan.lead.ownerId,
        bufferReason: plan.lead.bufferReason,
      };
    case 'attached':
      await rawRef.update({ processingState: 'processed', leadId: plan.targetLeadId });
      return { ok: true, kind: 'attached', leadId: plan.targetLeadId, rawLeadId: rawRef.id, outcome: plan.outcome };
    case 'replay':
      await rawRef.update({ processingState: 'processed', leadId: plan.leadId });
      return { ok: true, kind: 'replay', leadId: plan.leadId, rawLeadId: rawRef.id };
    case 'rejected':
      return reject(plan.code, plan.reason);
  }
}

// ── Aides de lecture ─────────────────────────────────────────────────────────

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v ?? null);
    return s.length > 500_000 ? s.slice(0, 500_000) : s;
  } catch {
    return '"[payload non sérialisable]"';
  }
}

export function displayName(u: DocumentData): string {
  return u.name || u.displayName || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Sans nom';
}

async function resolveCampaign(
  db: Firestore,
  mapped: MappedLead
): Promise<{ campaign: CampaignInfo | null; campaignData: DocumentData | null; unresolvedRef: string | null }> {
  const { id, externalId, name } = mapped.campaign;
  const ref = id ?? externalId ?? name;
  if (!ref) return { campaign: null, campaignData: null, unresolvedRef: null };

  let snap: { id: string; data: () => DocumentData | undefined; exists: boolean } | null = null;
  if (id) {
    const d = await db.collection(COL.campaigns).doc(id).get();
    if (d.exists) snap = d;
  }
  if (!snap && externalId) {
    const q = await db.collection(COL.campaigns).where('externalId', '==', externalId).limit(1).get();
    if (!q.empty) snap = q.docs[0];
  }
  if (!snap && name) {
    const q = await db.collection(COL.campaigns).where('name', '==', name).limit(1).get();
    if (!q.empty) snap = q.docs[0];
  }
  if (!snap) return { campaign: null, campaignData: null, unresolvedRef: ref };

  const d = snap.data()!;
  return { campaign: toCampaignInfo(snap.id, d), campaignData: d, unresolvedRef: null };
}

/** Campagne telle que le moteur d'attribution la lit (partagé avec le planificateur serveur). */
export function toCampaignInfo(id: string, d: DocumentData): CampaignInfo {
  return {
    id,
    name: d.name ?? id,
    status: (d.status ?? 'draft') as CampaignStatus,
    productCode: d.productCode ?? null,
    eligibleUserIds: arr(d.eligibleUserIds),
    eligibleTeamIds: arr(d.eligibleTeamIds),
    fallbackTeamId: d.fallbackTeamId ?? null,
    autoEligible: d.autoEligible === true,
  };
}

/** Familles du catalogue du CRM principal (`products.category`), gardées 10 minutes : le catalogue change rarement. */
let categoriesCache: { at: number; list: string[] } | null = null;
async function readProductCategories(db: Firestore): Promise<string[]> {
  if (categoriesCache && Date.now() - categoriesCache.at < 10 * 60_000) return categoriesCache.list;
  try {
    const snap = await db.collection('products').select('category').get();
    const list = categoriesOf(snap.docs.map((d) => ({ category: d.get('category') }))).map((c) => c.code);
    categoriesCache = { at: Date.now(), list };
    return list;
  } catch {
    // Catalogue illisible : le produit reçu est conservé tel quel, la réception du lead n'échoue pas pour autant.
    return categoriesCache?.list ?? [];
  }
}

/** Payload de la version publiée d'un module de config, ou null. */
export async function readPublishedConfig(db: Firestore, module: string): Promise<unknown> {
  const pointer = await db.collection(COL.config).doc(module).get();
  const versionId = pointer.get('publishedVersionId');
  if (typeof versionId !== 'string') return null;
  const version: DocumentReference = db.collection(COL.config).doc(module).collection('versions').doc(versionId);
  const snap = await version.get();
  return snap.exists ? snap.get('payload') : null;
}
