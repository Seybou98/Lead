// Appel des décisions sur les alertes du cockpit (voir netlify/functions/cockpit-alert.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import { newRequestId } from './qualifyApi';
import type { AlertKey, PostponeKey } from '../domain/cockpit/alertStates';

export type AlertResponse = { ok: true; replay: boolean; message: string } | { ok: false; message: string };

export type AlertRequest = { leadId: string; alertKey: AlertKey; sinceMs: number } & (
  | { action: 'close'; reasonCode: string; comment: string }
  | { action: 'postpone'; choice: PostponeKey; comment?: string }
  | { action: 'reopen' }
);

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendAlertAction(req: AlertRequest, requestId: string = newRequestId()): Promise<AlertResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/cockpit-alert`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...req, requestId }) });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.' };
  }
  let body: { ok?: boolean; message?: string; replay?: boolean } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, replay: body.replay === true, message: String(body.message ?? '') };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction des alertes est introuvable : redéployez le site ou relancez le serveur de développement.' };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.' };
  return { ok: false, message: body?.message ?? 'La décision a été refusée.' };
}
