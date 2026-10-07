// Appel de la fonction de changement de statut (voir netlify/functions/set-status.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';

export type StatusResponse = { ok: true; changed: boolean; status: string } | { ok: false; message: string };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendStatus(status: string): Promise<StatusResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.' };
  }

  let body: { ok?: boolean; changed?: boolean; status?: string; message?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, changed: body.changed === true, status: String(body.status ?? status) };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction de statut est introuvable : redéployez le site ou relancez le serveur de développement.' };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.' };
  return { ok: false, message: body?.message ?? 'Le changement de statut a été refusé.' };
}
