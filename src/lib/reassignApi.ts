// Appel de la réattribution manuelle (voir netlify/functions/reassign-lead.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import { newRequestId } from './qualifyApi';

export type ReassignResponse = { ok: true; replay: boolean; message: string; ownerId: string } | { ok: false; message: string; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendReassign(args: { leadId: string; targetUid: string; reason: string; requestId?: string }): Promise<ReassignResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/reassign-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadId: args.leadId, targetUid: args.targetUid, reason: args.reason, requestId: args.requestId ?? newRequestId() }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.', retryable: true };
  }

  let body: { ok?: boolean; message?: string; replay?: boolean; ownerId?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, replay: body.replay === true, message: String(body.message ?? ''), ownerId: String(body.ownerId ?? args.targetUid) };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction de réattribution est introuvable : redéployez le site ou relancez le serveur de développement.', retryable: true };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.', retryable: true };
  return { ok: false, message: body?.message ?? 'La réattribution a été refusée.', retryable: false };
}
