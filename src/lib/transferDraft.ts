// Brouillons de transfert de portefeuille (cl_transferDrafts) : écrits directement par le manager qui les crée, seul à
// pouvoir les lire (règles Firestore). Voir src/domain/portfolio/draft.ts pour ce qui est conservé.

import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { COL } from '../domain/collections';
import { draftId, parseTransferDraft, type TransferDraft } from '../domain/portfolio/draft';
import { ms } from './firestoreViews';

export interface StoredDraft {
  draft: TransferDraft;
  savedAtMs: number | null;
}

export async function loadTransferDraft(actorUid: string, fromUid: string): Promise<StoredDraft | null> {
  const snap = await getDoc(doc(db, COL.transferDrafts, draftId(actorUid, fromUid)));
  return snap.exists() ? { draft: parseTransferDraft(snap.data(), fromUid), savedAtMs: ms(snap.get('updatedAt')) } : null;
}

export async function saveTransferDraft(actorUid: string, draft: TransferDraft): Promise<void> {
  await setDoc(doc(db, COL.transferDrafts, draftId(actorUid, draft.fromUid)), { id: draftId(actorUid, draft.fromUid), createdBy: actorUid, ...draft, updatedAt: serverTimestamp() });
}

export async function deleteTransferDraft(actorUid: string, fromUid: string): Promise<void> {
  await deleteDoc(doc(db, COL.transferDrafts, draftId(actorUid, fromUid)));
}
