// Appels du montage et de la vente (voir netlify/functions/lead-conversion.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import { newRequestId } from './qualifyApi';
import type { ConversionActionInput } from '../domain/conversion/plan';
import type { SaleAction } from '../domain/sales/track';

/** Les actions du montage, la reprise de la transmission au CRM principal (manager, administrateur) et le suivi de la vente. */
export type ConversionRequestInput = ConversionActionInput | { kind: 'transmit'; decision?: 'link' | 'create' } | { kind: 'sale_action'; action: SaleAction };

export type ConversionResponse =
  | { ok: true; replay: boolean; message: string; status: string; validationState: string; saleNumber: string | null }
  | { ok: false; message: string; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendConversionAction(leadId: string, input: ConversionRequestInput, requestId: string = newRequestId()): Promise<ConversionResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/lead-conversion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadId, requestId, input }),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.', retryable: true };
  }

  let body: { ok?: boolean; message?: string; replay?: boolean; status?: string; validationState?: string; saleNumber?: string | null } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) return { ok: true, replay: body.replay === true, message: String(body.message ?? ''), status: String(body.status ?? ''), validationState: String(body.validationState ?? ''), saleNumber: body.saleNumber ?? null };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction « vente » est introuvable : redéployez le site ou relancez le serveur de développement.', retryable: true };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Réessayez dans un instant.', retryable: true };
  return { ok: false, message: body?.message ?? 'Action refusée.', retryable: false };
}
