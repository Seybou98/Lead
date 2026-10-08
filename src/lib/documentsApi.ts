// Appels du workflow documentaire (voir netlify/functions/lead-documents.ts) et dépôt de fichiers.
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { ref, uploadBytes } from 'firebase/storage';
import { auth, storage } from './firebase';
import { newRequestId } from './qualifyApi';
import type { DocumentActionInput, FileMeta } from '../domain/documents/plan';

export type DocumentsResponse =
  | { ok: true; replay: boolean; message: string; status: string; state: string }
  | { ok: false; message: string; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** Refus avant tout envoi : type non géré ou fichier trop lourd. null = accepté. */
export function checkFile(file: { type: string; size: number }): string | null {
  if (file.size <= 0) return 'Le fichier est vide.';
  if (file.size > MAX_FILE_BYTES) return 'Fichier trop volumineux (15 Mo maximum).';
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return 'Format non accepté : PDF, JPEG, PNG, WebP ou HEIC.';
  return null;
}

/** Nom de fichier sûr pour un chemin Storage. */
export const safeFileName = (name: string): string => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'fichier';

/** Envoie le fichier dans Storage et rend ses métadonnées, à joindre à l'action « receive ». */
export async function uploadDocumentFile(leadId: string, code: string, file: File): Promise<FileMeta> {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  const storagePath = `cl_documents/${leadId}/${code}/${Date.now()}_${safeFileName(file.name)}`;
  await uploadBytes(ref(storage, storagePath), file, { contentType: file.type });
  return { storagePath, contentType: file.type, sizeBytes: file.size, originalName: file.name.slice(0, 120) };
}

export async function sendDocumentAction(leadId: string, input: DocumentActionInput, requestId: string = newRequestId()): Promise<DocumentsResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/lead-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadId, requestId, input }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.', retryable: true };
  }

  let body: { ok?: boolean; message?: string; replay?: boolean; status?: string; state?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, replay: body.replay === true, message: String(body.message ?? ''), status: String(body.status ?? ''), state: String(body.state ?? '') };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction « documents » est introuvable : redéployez le site ou relancez le serveur de développement.', retryable: true };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.', retryable: true };
  return { ok: false, message: body?.message ?? 'Action refusée.', retryable: false };
}
