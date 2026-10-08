// Transmission d'une vente au CRM principal (§11.3, §11.8, §11.9, §24.7) : crée le dossier (collection `dossiers`,
// avec sa fiche `subventions` et son historique), copie les pièces conformes, puis confirme la conversion du lead.
//
// Garanties :
//  - idempotente : le dossier et la subvention ont un identifiant déterministe (`cl_<leadId>`) et sont créés avec
//    `create()`, qui échoue s'ils existent déjà. Une relance, un double clic ou deux exécutions simultanées ne créent
//    jamais un second dossier ;
//  - reprenable : l'avancement (numéro de dossier, identifiant, pièces copiées) est enregistré sur
//    `cl_conversions/{leadId}` ; une reprise continue là où l'échec s'est produit ;
//  - sans perte : en cas d'échec la vente et le lead restent, avec le code d'erreur, l'heure et le nombre de tentatives.
//
// La charge utile du dossier vient de src/domain/conversion/dossierPayload.ts (reprise du CRM principal).

import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import { sanitizeDraft } from '../../src/domain/conversion/montage';
import { buildDossierFromImported, clientNumberCandidate, saleToImportedData, type SaleToDossierInput } from '../../src/domain/conversion/dossierPayload';
import { buildAddressQuery, fetchParcelId } from '../../src/domain/conversion/parcel';
import { usefulHistory, type LeadEventLike } from '../../src/domain/conversion/history';
import { displayName } from './ingest';

/** Copie d'un fichier Storage (adaptateur : firebase-admin en production, faux dans les tests). */
export interface StorageLike {
  copy(srcPath: string, destPath: string): Promise<{ url: string }>;
}

export interface TransmitArgs {
  leadId: string;
  /** uid de l'auteur (utilisateur, ou « system » pour une reprise automatique). */
  actorId: string;
  nowMs: number;
  /** Doublon détecté : « link » rattache au dossier existant, « create » crée quand même. Absent : on s'arrête. */
  onDuplicate?: 'link' | 'create' | null;
  storage: StorageLike | null;
  random?: () => number;
  /** Parcelle cadastrale d'une adresse (service public de l'IGN) ; injectable pour les tests. Rend null si introuvable. */
  fetchParcel?: (query: string) => Promise<string | null>;
}

export type TransmitResult =
  | { ok: true; replay: boolean; state: 'confirmed'; clientId: string; dossierId: string; documents: number; message: string }
  | { ok: false; code: 'not_found' | 'busy' | 'duplicate' | 'failed'; message: string; duplicates?: { id: string; clientNumber: string }[] };

/** Tentatives automatiques avant d'alerter l'administrateur, et pause entre deux tentatives (minutes, doublée à chaque échec). */
export const MAX_AUTO_ATTEMPTS = 5;
export const backoffMinutes = (attempts: number): number => Math.min(60, 2 ** Math.max(0, attempts));
const LOCK_MS = 90_000;
const MAX_DOCS = 40;

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const d = (m: number) => new Date(m);
const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};
const safeName = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'fichier';

class StepError extends Error {
  constructor(public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export async function transmitConversion(db: Firestore, args: TransmitArgs): Promise<TransmitResult> {
  const { leadId, nowMs } = args;
  const leadRef = db.collection(COL.leads).doc(leadId);
  const convRef = db.collection(COL.conversions).doc(leadId);
  const saleRef = db.collection(COL.sales).doc(leadId);
  const dossierRef = db.collection('dossiers').doc(`cl_${leadId}`);
  const subRef = db.collection('subventions').doc(`cl_${leadId}`);
  const at = d(nowMs);

  const [convSnap, leadSnap, saleSnap] = await Promise.all([convRef.get(), leadRef.get(), saleRef.get()]);
  if (!convSnap.exists || !leadSnap.exists || !saleSnap.exists) return { ok: false, code: 'not_found', message: "Aucune vente à transmettre pour ce lead." };
  if (convSnap.get('state') === 'confirmed') {
    return { ok: true, replay: true, state: 'confirmed', clientId: String(convSnap.get('clientId')), dossierId: String(convSnap.get('dossierId')), documents: Number(convSnap.get('documentsCount') ?? 0), message: 'Le dossier est déjà créé dans le CRM principal.' };
  }

  // ── Réservation : une seule exécution à la fois par lead ──
  const claim = await db.runTransaction(async (tx) => {
    const c = await tx.get(convRef);
    const lockedUntil = toMs(c.get('lockedUntil'));
    if (c.get('state') === 'confirmed') return { busy: false, attempts: Number(c.get('attempts') ?? 0), confirmed: true };
    if (lockedUntil !== null && lockedUntil > nowMs) return { busy: true, attempts: 0, confirmed: false };
    const attempts = Number(c.get('attempts') ?? 0) + 1;
    tx.update(convRef, { state: c.get('state') === 'failed' || c.get('state') === 'pending' ? 'sent' : c.get('state'), attempts, lockedUntil: d(nowMs + LOCK_MS), lastAttemptAt: at, updatedAt: at });
    return { busy: false, attempts, confirmed: false };
  });
  if (claim.busy) return { ok: false, code: 'busy', message: 'Une transmission est déjà en cours pour ce lead.' };
  if (claim.confirmed) return transmitConversion(db, args);

  const fail = async (e: unknown): Promise<TransmitResult> => {
    const code = e instanceof StepError ? e.code : 'unexpected';
    // Message métier : jamais de détail technique exposé au télépro (§11.9).
    const message = e instanceof StepError ? e.message : 'La transmission a échoué. Elle sera reprise automatiquement.';
    if (!(e instanceof StepError)) console.error('transmission : erreur inattendue', leadId, e);
    const err = { code, message: message.slice(0, 300), at };
    await db.runTransaction(async (tx) => {
      const [l, c] = await Promise.all([tx.get(leadRef), tx.get(convRef)]);
      // Une autre exécution a déjà confirmé : cet échec ne doit rien défaire.
      if (c.get('state') === 'confirmed') return;
      tx.update(convRef, { state: 'failed', lastError: { ...err, ...(e instanceof StepError && e.extra ? { extra: e.extra } : {}) }, lockedUntil: null, updatedAt: at });
      if (l.get('status') === 'transmitting') tx.update(leadRef, { status: 'transmission_error', updatedAt: at });
      const ev = leadRef.collection(SUB.events).doc(`transmit_err_${leadId}_${claim.attempts}`);
      tx.set(ev, { id: ev.id, type: 'conversion', at, actorId: args.actorId, note: `Transmission au CRM principal échouée (tentative ${claim.attempts}) : ${message}`, meta: { op: 'transmit_failed', code, attempt: claim.attempts } });
    });
    if (e instanceof StepError && e.code === 'duplicate_dossier') return { ok: false, code: 'duplicate', message, duplicates: (e.extra?.duplicates ?? []) as { id: string; clientNumber: string }[] };
    return { ok: false, code: 'failed', message };
  };

  try {
    const lead = leadSnap.data()!;
    const sale = saleSnap.data()!;
    let conv = (await convRef.get()).data()!;
    let clientNumber: string | null = typeof conv.clientId === 'string' ? conv.clientId : null;
    let dossierId: string | null = typeof conv.dossierId === 'string' ? conv.dossierId : null;

    // ── Étape A : client (numéro de dossier) et dossier ──
    if (!dossierId) {
      const draftSnap = await leadRef.collection(SUB.montage).doc('draft').get();
      if (!draftSnap.exists) throw new StepError('draft_missing', 'Le brouillon du dossier est introuvable.');
      const draft = sanitizeDraft(draftSnap.data());

      // Parcelle cadastrale automatique : si le montage ne l'a pas renseignée, on la cherche à partir de l'adresse.
      // Un service indisponible ne bloque jamais la transmission : le champ reste simplement vide.
      if (!draft.project.cadastralRef) {
        const find = args.fetchParcel ?? defaultFetchParcel;
        try {
          draft.project.cadastralRef = (await find(buildAddressQuery({ street: draft.identity.addressLine, postalCode: draft.identity.postalCode, city: draft.identity.city }))) ?? '';
        } catch {
          draft.project.cadastralRef = '';
        }
      }

      const duplicates = await findDuplicates(db, leadId, draft.identity.email, draft.identity.phone);
      if (duplicates.length > 0 && !args.onDuplicate) {
        throw new StepError('duplicate_dossier', `Un dossier existe déjà pour ce contact (n° ${duplicates.map((x) => x.clientNumber || x.id).join(', ')}). Une décision est nécessaire.`, { duplicates });
      }

      if (duplicates.length > 0 && args.onDuplicate === 'link') {
        dossierId = duplicates[0].id;
        clientNumber = duplicates[0].clientNumber || duplicates[0].id;
        await convRef.update({ state: 'dossier_created', clientId: clientNumber, dossierId, subventionId: null, linkedExisting: true, updatedAt: at });
      } else {
        const docsSnap = await leadRef.collection(SUB.documents).get();
        const docs = docsSnap.docs.map((s) => ({ code: String(s.get('typeCode') ?? s.id), mandatory: s.get('mandatory') === true, status: String(s.get('status')) }));
        const categories = await Promise.all(
          (Array.isArray(sale.lines) ? sale.lines : []).map(async (l: { productId?: string | null }) => {
            if (!l.productId) return null;
            const p = await db.collection('products').doc(l.productId).get();
            return p.exists && typeof p.get('category') === 'string' ? (p.get('category') as string) : null;
          })
        );
        const ownerId: string | null = lead.ownerId ?? null;
        const ownerSnap = ownerId ? await db.collection('users').doc(ownerId).get() : null;
        const ownerName = ownerSnap?.exists ? displayName(ownerSnap.data()!) : '';
        const [firstName, ...rest] = ownerName.split(' ');
        const campaignName: string | null = sale.campaignName ?? null;
        const input: SaleToDossierInput = {
          leadId,
          saleNumber: String(sale.number),
          draft,
          totals: { mprCents: Number(sale.mprCents ?? 0), ceeCents: Number(sale.ceeCents ?? 0), remainderCents: Number(sale.remainderCents ?? 0), totalTtcCents: Number(sale.totalTtcCents ?? 0), discountCents: Number(sale.discountCents ?? 0) },
          lineCategories: categories,
          conformDocs: docs.filter((x) => x.status === 'conform').map((x) => x.code),
          missingDocs: docs.filter((x) => x.mandatory && x.status !== 'conform').map((x) => x.code),
          owner: ownerId ? { id: ownerId, firstName: firstName ?? '', lastName: rest.join(' ') } : null,
          campaignName,
          consent: typeof lead.consent === 'boolean' ? lead.consent : null,
          lastNote: typeof lead.lastNote?.text === 'string' ? lead.lastNote.text : null,
          marketing: {
            campaignId: typeof lead.origin?.campaignId === 'string' ? lead.origin.campaignId : null,
            sourceId: typeof lead.origin?.sourceId === 'string' ? lead.origin.sourceId : null,
            platform: typeof lead.origin?.platform === 'string' ? lead.origin.platform : null,
            adsetId: typeof lead.origin?.adsetId === 'string' ? lead.origin.adsetId : null,
            adId: typeof lead.origin?.adId === 'string' ? lead.origin.adId : null,
            formId: typeof lead.origin?.formId === 'string' ? lead.origin.formId : null,
            externalId: typeof lead.origin?.externalId === 'string' ? lead.origin.externalId : null,
            receivedAtMs: toMs(lead.origin?.receivedAt),
          },
        };

        clientNumber = clientNumber ?? (await freeClientNumber(db, at, args.random));
        const built = buildDossierFromImported(saleToImportedData(input), { clientNumber, now: at, owner: input.owner, ids: { leadId, saleNumber: String(sale.number), dossierId: dossierRef.id, subventionId: subRef.id } });
        const historyRef = db.collection('historique_dossier').doc(`cl_created_${leadId}`);
        await db.runTransaction(async (tx) => {
          const existing = await tx.get(dossierRef);
          // Déjà créé (reprise après un échec survenu juste après l'écriture) : on le reprend sans le recréer.
          if (existing.exists) {
            if (existing.get('leadId') !== leadId) throw new StepError('dossier_conflict', "L'identifiant de dossier est déjà utilisé par un autre lead.");
            clientNumber = String(existing.get('clientNumber'));
          } else {
            tx.create(dossierRef, built.dossier);
            tx.create(subRef, built.subvention);
            tx.set(historyRef, { action: built.history.action, user: ownerName || 'CRM Leads', userId: args.actorId, clientName: built.history.clientName, clientId: dossierRef.id, details: built.history.details, newValue: built.history.newValue, timestamp: at, source: 'crm-leads' });
          }
          tx.update(convRef, { state: 'dossier_created', clientId: clientNumber, dossierId: dossierRef.id, subventionId: subRef.id, linkedExisting: false, updatedAt: at });
        });
        dossierId = dossierRef.id;
      }
      conv = (await convRef.get()).data()!;
    }
    if (!dossierId || !clientNumber) throw new StepError('state_invalid', 'État de la transmission incohérent.');

    // ── Étape B : pièces conformes ──
    let documentsCount = Number(conv.documentsCount ?? 0);
    if (conv.documentsTransferred !== true) {
      const docsSnap = await leadRef.collection(SUB.documents).get();
      const files = docsSnap.docs
        .filter((s) => s.get('status') === 'conform' && s.get('file') && typeof (s.get('file') as DocumentData).storagePath === 'string')
        .slice(0, MAX_DOCS);
      if (files.length > 0 && !args.storage) throw new StepError('storage_unavailable', "Le stockage des pièces n'est pas disponible.");
      const done: Record<string, unknown>[] = [];
      for (const s of files) {
        const code = String(s.get('typeCode') ?? s.id);
        const f = s.get('file') as { storagePath: string; originalName?: string; sizeBytes?: number; contentType?: string };
        const destPath = `dossiers/${dossierId}/documents/${code}/lead_${safeName(f.originalName ?? code)}`;
        const docRef = db.collection('dossiers').doc(dossierId).collection('documents').doc(`lead_${code}`);
        const existing = await docRef.get();
        if (existing.exists) {
          done.push({ id: docRef.id, ...existing.data() });
          continue;
        }
        let copied: { url: string };
        try {
          copied = await args.storage!.copy(f.storagePath, destPath);
        } catch (e) {
          throw new StepError('document_copy_failed', `La pièce « ${s.get('label') ?? code} » n'a pas pu être transférée.`, { code, cause: (e as Error).message?.slice(0, 120) });
        }
        const payload = { name: f.originalName ?? code, originalName: f.originalName ?? code, type: code, url: copied.url, path: destPath, size: Number(f.sizeBytes ?? 0), uploadedAt: at.toISOString(), uploadedBy: 'CRM Leads', createdAt: at, source: 'crm-leads', leadId };
        await docRef.set(payload);
        done.push({ id: docRef.id, ...payload });
      }
      documentsCount = done.length;
      await db.collection('dossiers').doc(dossierId).update({ ...(done.length ? { uploadedDocuments: done } : {}), updatedAt: at });
      await convRef.update({ documentsTransferred: true, documentsCount, updatedAt: at });
    }

    // ── Étape B bis : historique utile du lead, repris dans l'historique du dossier (fig. 44 « Historique ») ──
    let historyCount = Number(conv.historyCount ?? 0);
    if (conv.historyTransferred !== true) {
      const evSnap = await leadRef.collection(SUB.events).get();
      const events: LeadEventLike[] = evSnap.docs.map((e) => ({
        id: e.id,
        type: String(e.get('type') ?? ''),
        atMs: toMs(e.get('at')) ?? NaN,
        actorId: String(e.get('actorId') ?? ''),
        note: (e.get('note') as string | undefined) ?? null,
        reason: (e.get('reason') as string | undefined) ?? null,
        before: (e.get('before') as Record<string, unknown> | undefined) ?? null,
        after: (e.get('after') as Record<string, unknown> | undefined) ?? null,
      }));
      const entries = usefulHistory(leadId, events);
      const dossierName = String((await dossierRef.get()).get('name') ?? lead.fullName ?? '');
      // Identifiants déterministes : retransmettre réécrit les mêmes entrées, jamais de doublon.
      for (const h of entries) {
        await db.collection('historique_dossier').doc(h.id).set({ action: 'comment_added', user: 'CRM Leads', userId: h.actorId || 'system', clientName: dossierName, clientId: dossierId, details: `Historique CRM Leads : ${h.text}`, timestamp: d(h.atMs), source: 'crm-leads', leadId });
      }
      historyCount = entries.length;
      await convRef.update({ historyTransferred: true, historyCount, updatedAt: at });
    }

    // ── Étape C : confirmation ──
    const managerIds = arr(lead.managerIds);
    const ownerId: string | null = lead.ownerId ?? null;
    await db.runTransaction(async (tx) => {
      const l = await tx.get(leadRef);
      tx.update(convRef, { state: 'confirmed', confirmedAt: at, lockedUntil: null, lastError: null, updatedAt: at });
      const status = l.get('status');
      tx.update(leadRef, {
        ...(status === 'transmitting' || status === 'transmission_error' ? { status: 'converted' } : {}),
        conversion: { state: 'confirmed', clientId: clientNumber, dossierId, convertedAt: at },
        updatedAt: at,
      });
      if (status === 'transmitting' || status === 'transmission_error') {
        const ev = leadRef.collection(SUB.events).doc(`transmit_${leadId}_status`);
        tx.set(ev, { id: ev.id, type: 'status_changed', at, actorId: args.actorId, before: { status }, after: { status: 'converted' } });
      }
      const ev2 = leadRef.collection(SUB.events).doc(`transmit_${leadId}_done`);
      tx.set(ev2, { id: ev2.id, type: 'conversion', at, actorId: args.actorId, note: `Dossier n° ${clientNumber} créé dans le CRM principal`, after: { clientId: clientNumber, dossierId, documents: documentsCount }, meta: { op: 'transmitted' } });
      const audit = db.collection(COL.audit).doc(`conv_transmit_${leadId}`);
      tx.set(audit, { id: audit.id, at, actorId: args.actorId, action: 'conversion.transmit', entityType: 'lead', entityId: leadId, before: { status }, after: { status: 'converted', clientId: clientNumber, dossierId }, reason: null });
      const recipients = [...new Set([ownerId, ...managerIds].filter((x): x is string => !!x && x !== args.actorId))];
      if (recipients.length > 0) {
        const n = db.collection(COL.notifications).doc(`transmit_${leadId}_done`);
        tx.set(n, { id: n.id, type: 'conversion', title: 'Dossier créé dans le CRM principal', description: `${lead.fullName ?? 'Lead'} : dossier n° ${clientNumber}`.slice(0, 300), leadId, recipientIds: recipients, sound: null, readBy: [], createdAt: at });
      }
    });

    return { ok: true, replay: false, state: 'confirmed', clientId: clientNumber, dossierId, documents: documentsCount, message: `Dossier n° ${clientNumber} créé dans le CRM principal.` };
  } catch (e) {
    return fail(e);
  }
}

/** Recherche réelle (IGN) avec un délai court : la transmission ne doit pas attendre un service lent. */
async function defaultFetchParcel(query: string): Promise<string | null> {
  if (!query) return null;
  try {
    return (await fetchParcelId(query, { signal: AbortSignal.timeout(5000) })).parcelId;
  } catch {
    return null;
  }
}

/** Dossiers existants du même contact (même e-mail ou même téléphone), hors celui de ce lead. */
async function findDuplicates(db: Firestore, leadId: string, email: string, phone: string): Promise<{ id: string; clientNumber: string }[]> {
  const found = new Map<string, { id: string; clientNumber: string }>();
  const terms = [email.trim().toLowerCase(), phone.replace(/\D/g, '')].filter((t) => t.length >= 6);
  for (const term of terms) {
    const snap = await db.collection('dossiers').where('searchIndex', 'array-contains', term).limit(5).get();
    for (const s of snap.docs) {
      if (s.get('leadId') === leadId) continue;
      found.set(s.id, { id: s.id, clientNumber: String(s.get('clientNumber') ?? '') });
    }
  }
  return [...found.values()];
}

/** Numéro de dossier à 7 chiffres libre dans `dossiers` et `clients` (même règle que le CRM principal). */
async function freeClientNumber(db: Firestore, at: Date, random?: () => number): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const candidate = clientNumberCandidate(at, random);
    const [a, b] = await Promise.all([
      db.collection('dossiers').where('clientNumber', '==', candidate).limit(1).get(),
      db.collection('clients').where('clientNumber', '==', candidate).limit(1).get(),
    ]);
    if (a.empty && b.empty) return candidate;
  }
  throw new StepError('client_number', "Impossible de générer un numéro de dossier unique.");
}
