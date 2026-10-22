// Appel de l'import et de la saisie manuelle (voir netlify/functions/import-leads.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';

export type ImportRowResult =
  | { row: number; ok: true; kind: 'created' | 'attached' | 'replay'; leadId: string; assignmentState?: string; ownerId?: string | null; bufferReason?: string | null; outcome?: string }
  | { row: number; ok: false; code: string; reason: string };

export type ImportResponse = { ok: true; replay: boolean; results: ImportRowResult[]; processed: number; summary: { created: number; attached: number; rejected: number } } | { ok: false; message: string; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export const newBatchId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function sendImportBatch(args: { channel: 'import' | 'manual'; sourceId: string | null; batchId: string; startRow: number; rows: Record<string, string>[] }): Promise<ImportResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/import-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: args.channel, sourceId: args.sourceId, batchId: args.batchId, startRow: args.startRow, rows: args.rows }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.', retryable: true };
  }
  let body: { ok?: boolean; message?: string; replay?: boolean; results?: ImportRowResult[]; processed?: number; summary?: { created: number; attached: number; rejected: number } } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok && Array.isArray(body.results) && body.summary) return { ok: true, replay: body.replay === true, results: body.results, processed: typeof body.processed === 'number' ? body.processed : body.results.length, summary: body.summary };
  if (res.status === 404 && !body?.message) return { ok: false, message: "La fonction d'import est introuvable : redéployez le site ou relancez le serveur de développement.", retryable: true };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Le lot peut être renvoyé sans risque de doublon.', retryable: true };
  return { ok: false, message: body?.message ?? "L'import a été refusé.", retryable: false };
}
