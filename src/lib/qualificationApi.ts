// Appel de l'enregistrement des réponses de qualification (voir netlify/functions/lead-qualification.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import { newRequestId } from './qualifyApi';

export type QualificationResponse = { ok: true; message: string; status: string; version: number; eligibility: string } | { ok: false; message: string; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendQualification(args: { leadId: string; answers: Record<string, unknown>; requestId?: string }): Promise<QualificationResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/lead-qualification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadId: args.leadId, answers: args.answers, requestId: args.requestId ?? newRequestId() }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.', retryable: true };
  }

  let body: { ok?: boolean; message?: string; status?: string; version?: number; eligibility?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, message: String(body.message ?? ''), status: String(body.status ?? ''), version: Number(body.version ?? 0), eligibility: String(body.eligibility ?? 'ok') };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction de qualification est introuvable : redéployez le site ou relancez le serveur de développement.', retryable: true };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.', retryable: true };
  return { ok: false, message: body?.message ?? 'La qualification a été refusée.', retryable: false };
}
