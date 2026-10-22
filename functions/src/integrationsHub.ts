// Couche Firestore du hub d'intégrations (§24.10) : lecture des traces réelles pour le journal, et reprise d'un lead
// refusé à la réception. Les règles métier (masquage, états, regroupements) sont dans src/domain/integrations/hub.ts ;
// la reprise passe par la MÊME réception que tout autre lead (functions/src/ingest.ts).
//
// Pourquoi côté serveur : la donnée brute et les transmissions ne sont pas listables depuis le navigateur par les règles
// Firestore (lecture par document seulement), et une reprise doit être unique, tracée et idempotente.

import { type Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import { entryFromConversion, entryFromRaw, entryFromReplayAudit, sortJournal, type JournalEntry } from '../../src/domain/integrations/hub';
import { ingestLead } from './ingest';

export const RAW_LIMIT = 400;
export const CONVERSION_LIMIT = 300;
export const AUDIT_LIMIT = 100;

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

export interface JournalResult {
  entries: JournalEntry[];
  /** Les lectures sont bornées : au-delà, les plus anciennes traces ne figurent pas dans le journal. */
  truncated: boolean;
  limits: { raw: number; conversions: number };
}

export async function readJournal(db: Firestore, nowMs: number): Promise<JournalResult> {
  const [raws, convs, audits, sources] = await Promise.all([
    db.collection(COL.rawLeads).orderBy('receivedAt', 'desc').limit(RAW_LIMIT).get(),
    db.collection(COL.conversions).orderBy('updatedAt', 'desc').limit(CONVERSION_LIMIT).get(),
    db.collection(COL.audit).where('action', '==', 'integration.replay').limit(AUDIT_LIMIT).get(),
    db.collection(COL.sources).get(),
  ]);
  const names = new Map(sources.docs.map((d) => [d.id, String(d.get('name') ?? d.id)]));
  const entries: JournalEntry[] = [];
  for (const d of raws.docs) {
    entries.push(
      entryFromRaw(
        {
          id: d.id,
          receivedAtMs: ms(d.get('receivedAt')) ?? 0,
          channel: String(d.get('channel') ?? 'webhook'),
          sourceId: (d.get('sourceId') as string | null) ?? null,
          payloadJson: typeof d.get('payloadJson') === 'string' ? (d.get('payloadJson') as string) : null,
          leadId: (d.get('leadId') as string | null) ?? null,
          processingState: String(d.get('processingState') ?? 'received'),
          rejectionCode: d.get('rejectionCode') ?? null,
          rejectionReason: d.get('rejectionReason') ?? null,
          actorId: (d.get('actorId') as string | null) ?? null,
          replayedAtMs: ms(d.get('replayedAt')),
          processedAtMs: ms(d.get('processedAt')),
        },
        nowMs,
        (d.get('sourceId') as string | null) ? (names.get(d.get('sourceId') as string) ?? null) : null
      )
    );
  }
  for (const d of convs.docs) {
    entries.push(
      entryFromConversion({
        leadId: d.id,
        state: String(d.get('state') ?? 'pending'),
        attempts: Number(d.get('attempts') ?? 0),
        lastError: (d.get('lastError') as { code?: string; message?: string } | null) ?? null,
        createdAtMs: ms(d.get('createdAt')),
        updatedAtMs: ms(d.get('updatedAt')),
        dossierId: (d.get('dossierId') as string | null) ?? null,
        clientId: (d.get('clientId') as string | null) ?? null,
        saleId: (d.get('saleId') as string | null) ?? null,
      })
    );
  }
  for (const d of audits.docs) {
    const after = (d.get('after') ?? {}) as { rawLeadId?: string; outcome?: string; leadId?: string | null };
    entries.push(entryFromReplayAudit({ id: d.id, atMs: ms(d.get('at')) ?? 0, actorId: String(d.get('actorId') ?? ''), rawLeadId: after.rawLeadId ?? '', outcome: after.outcome ?? 'created', leadId: after.leadId ?? null }));
  }
  return { entries: sortJournal(entries), truncated: raws.size >= RAW_LIMIT || convs.size >= CONVERSION_LIMIT, limits: { raw: RAW_LIMIT, conversions: CONVERSION_LIMIT } };
}

// ── Erreurs métier du périmètre d'un manager (§24.11) ────────────────────────

const CHUNK = 30;

/**
 * Ce qu'un manager voit du hub : les transmissions au CRM principal en échec pour les leads de SON périmètre (`managerIds`),
 * avec leur cause et leur ancienneté. Ni donnée brute, ni charge utile, ni secret : la reprise se fait sur la fiche du dossier.
 * L'administrateur voit toutes les erreurs de transmission.
 */
export async function readTransmissionErrors(db: Firestore, uid: string, role: 'admin' | 'manager'): Promise<{ entries: JournalEntry[]; truncated: boolean }> {
  const snap = await db.collection(COL.conversions).where('state', '==', 'failed').limit(CONVERSION_LIMIT).get();
  let docs = snap.docs;
  if (role === 'manager') {
    const allowed = new Set<string>();
    for (let i = 0; i < docs.length; i += CHUNK) {
      const refs = docs.slice(i, i + CHUNK).map((d) => db.collection(COL.leads).doc(d.id));
      const leads = await db.getAll(...refs);
      for (const l of leads) if (l.exists && Array.isArray(l.get('managerIds')) && (l.get('managerIds') as string[]).includes(uid)) allowed.add(l.id);
    }
    docs = docs.filter((d) => allowed.has(d.id));
  }
  const entries = docs
    .map((d) =>
      entryFromConversion({
        leadId: d.id,
        state: String(d.get('state') ?? 'failed'),
        attempts: Number(d.get('attempts') ?? 0),
        lastError: (d.get('lastError') as { code?: string; message?: string } | null) ?? null,
        createdAtMs: ms(d.get('createdAt')),
        updatedAtMs: ms(d.get('updatedAt')),
        dossierId: (d.get('dossierId') as string | null) ?? null,
        clientId: null,
        saleId: null,
      })
    )
    .map((e) => ({ ...e, payload: null }));
  return { entries: sortJournal(entries), truncated: snap.size >= CONVERSION_LIMIT };
}

// ── Test de la connexion au CRM principal ────────────────────────────────────

export interface ConnectionTest {
  ok: boolean;
  ms: number;
  message: string;
}

/** Lecture d'un seul dossier du CRM principal : prouve que la base répond et que le compte de service y a accès. Aucune écriture. */
export async function testMainCrm(db: Firestore, clock: () => number = Date.now): Promise<ConnectionTest> {
  const t0 = clock();
  try {
    const snap = await db.collection('dossiers').limit(1).get();
    return { ok: true, ms: clock() - t0, message: snap.empty ? 'Connexion établie ; aucun dossier dans le CRM principal.' : 'Connexion établie : le CRM principal répond en lecture.' };
  } catch (e) {
    return { ok: false, ms: clock() - t0, message: `Lecture du CRM principal impossible (${(e as { code?: string | number }).code ?? 'erreur'}).` };
  }
}

// ── Reprise d'un lead refusé ─────────────────────────────────────────────────

export interface ReplayArgs {
  uid: string;
  rawLeadId: string;
  /** Corrections apportées avant de rejouer (le payload d'origine n'est JAMAIS modifié). */
  overrides?: { phone?: string; email?: string };
  nowMs: number;
}

export type ReplayOutcome =
  | { ok: true; kind: 'created' | 'attached' | 'replay'; leadId: string; message: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'already' | 'busy' | 'still_rejected'; message: string };

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

export async function replayRawLead(db: Firestore, args: ReplayArgs, deps: { ingest: typeof ingestLead } = { ingest: ingestLead }): Promise<ReplayOutcome> {
  const rawRef = db.collection(COL.rawLeads).doc(args.rawLeadId);
  const snap = await rawRef.get();
  if (!snap.exists) return { ok: false, code: 'not_found', message: 'Donnée brute introuvable.' };
  if (snap.get('replayedAt')) return { ok: false, code: 'already', message: 'Cette donnée a déjà été reprise.' };
  const state = String(snap.get('processingState') ?? '');
  const receivedAt = ms(snap.get('receivedAt')) ?? 0;
  const stuck = state === 'received' && args.nowMs - receivedAt > 5 * 60_000;
  if (state !== 'rejected' && !stuck) return { ok: false, code: 'invalid', message: "Cette donnée n'est pas à reprendre : elle a été traitée ou est en cours de traitement." };

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(snap.get('payloadJson') ?? 'null'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload');
    payload = { ...(parsed as Record<string, unknown>) };
  } catch {
    return { ok: false, code: 'invalid', message: 'Le contenu reçu est illisible : saisissez le lead à la main.' };
  }
  const phone = clean(args.overrides?.phone);
  const email = clean(args.overrides?.email);
  if (phone) payload.phone = phone;
  if (email) payload.email = email;

  // Garde : une seule reprise à la fois pour une même donnée (double clic, deux administrateurs).
  const guard = db.collection(COL.idempotency).doc(`replay_${args.rawLeadId}`.slice(0, 200));
  try {
    await guard.create({ uid: args.uid, at: new Date(args.nowMs) });
  } catch {
    return { ok: false, code: 'busy', message: 'Une reprise est déjà en cours pour cette donnée.' };
  }

  try {
    const channel = (['webhook', 'import', 'manual', 'api'] as const).find((c) => c === snap.get('channel')) ?? 'webhook';
    const res = await deps.ingest(db, { channel, sourceId: (snap.get('sourceId') as string | null) ?? null, payload, nowMs: args.nowMs, meta: { actorId: args.uid, batchId: `replay_${args.rawLeadId}` } });
    const at = new Date(args.nowMs);
    const audit = db.collection(COL.audit).doc(`replay_${args.rawLeadId}_${args.nowMs}`.slice(0, 200));
    if (!res.ok) {
      await guard.delete();
      await audit.set({ id: audit.id, at, actorId: args.uid, action: 'integration.replay', entityType: 'raw_lead', entityId: args.rawLeadId, before: null, after: { rawLeadId: args.rawLeadId, outcome: 'rejected', leadId: null, reason: res.reason }, reason: null });
      return { ok: false, code: 'still_rejected', message: `Toujours refusé : ${res.reason}` };
    }
    await rawRef.update({ replayedAt: at, replayedBy: args.uid, replayLeadId: res.leadId });
    await audit.set({ id: audit.id, at, actorId: args.uid, action: 'integration.replay', entityType: 'raw_lead', entityId: args.rawLeadId, before: null, after: { rawLeadId: args.rawLeadId, outcome: res.kind, leadId: res.leadId, corrected: [phone ? 'phone' : null, email ? 'email' : null].filter(Boolean) }, reason: null });
    return { ok: true, kind: res.kind, leadId: res.leadId, message: res.kind === 'created' ? 'Lead créé à partir de la donnée reprise.' : res.kind === 'attached' ? 'Rattaché à un lead existant : aucun doublon créé.' : 'Ce lead existait déjà.' };
  } catch (e) {
    // Erreur technique : la garde est levée pour permettre une nouvelle tentative ; la donnée brute reste intacte.
    await guard.delete().catch(() => undefined);
    throw e;
  }
}
