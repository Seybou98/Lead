// Appels des absences et des transferts de portefeuille (voir netlify/functions/portfolio.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import { newRequestId } from './qualifyApi';
import type { Handling } from '../domain/portfolio/portfolio';

export type PortfolioResponse = { ok: true; message: string; data?: Record<string, unknown> } | { ok: false; message: string; errors?: Record<string, string> };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';
/** Taille d'un envoi : la fonction en accepte 25 au plus, chaque élément étant sa propre transaction. */
export const TRANSFER_CHUNK = 25;

async function post(body: unknown): Promise<PortfolioResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/portfolio`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.' };
  }
  let json: { ok?: boolean; message?: string; data?: Record<string, unknown>; errors?: Record<string, string> } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok && json?.ok) return { ok: true, message: String(json.message ?? ''), data: json.data };
  if (res.status === 404 && !json?.message) return { ok: false, message: 'La fonction est introuvable : redéployez le site ou relancez le serveur de développement.' };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.' };
  return { ok: false, message: json?.message ?? 'Demande refusée.', errors: json?.errors };
}

export interface AbsencePayload {
  type: string;
  fromMs: number;
  toMs: number;
  reason: string;
  restoreDistribution: boolean;
  handling: Handling;
}

export const sendAbsence = (userId: string, input: AbsencePayload, requestId = newRequestId()) => post({ kind: 'declare_absence', userId, requestId, input });
export const sendEndAbsence = (absenceId: string) => post({ kind: 'end_absence', absenceId });

/** Un envoi du lot de transfert. Le même `batchId` sert à tous les envois d'un même transfert (rejeu sans doublon). */
export const sendTransferChunk = (args: { fromUid: string; batchId: string; assignments: { leadId: string; targetUid: string }[]; reason: string; returnAtMs: number | null }) =>
  post({ kind: 'transfer', ...args });
