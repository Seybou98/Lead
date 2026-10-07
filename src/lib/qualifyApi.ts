// Appel de la fonction de qualification de fin d'appel (voir netlify/functions/qualify-call.ts).
// L'identité est celle du jeton Firebase de l'utilisateur connecté : aucun secret dans le navigateur.

import { auth } from './firebase';
import type { CallOutcomeInput } from '../domain/call/outcomes';

export interface QualifyRequest {
  leadId: string;
  /** Identifiant d'idempotence : généré à l'ouverture du formulaire, réutilisé tel quel à chaque nouvel essai. */
  requestId: string;
  expectedStatus: string | null;
  durationSeconds: number | null;
  input: CallOutcomeInput;
}

export type QualifyResponse =
  | { ok: true; replay: boolean; summary: string; status: string; nextActionAtMs: number | null }
  | { ok: false; message: string; errors: Record<string, string>; retryable: boolean };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/** Identifiant unique, sûr pour Firestore et pour l'URL (8 à 100 caractères). */
export function newRequestId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `q${rnd}`.slice(0, 60);
}

export async function sendQualification(req: QualifyRequest): Promise<QualifyResponse> {
  let token: string;
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', errors: {}, retryable: false };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/qualify-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion : votre saisie est conservée, vous pouvez réessayer.', errors: {}, retryable: true };
  }

  let body: { ok?: boolean; message?: string; errors?: Record<string, string>; replay?: boolean; summary?: string; status?: string; nextActionAtMs?: number | null } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok) {
    return { ok: true, replay: body.replay === true, summary: String(body.summary ?? ''), status: String(body.status ?? ''), nextActionAtMs: body.nextActionAtMs ?? null };
  }
  // 404 sur /api/... : la fonction n'est pas déployée ou `netlify dev` n'est pas lancé.
  if (res.status === 404 && !body?.message) {
    return { ok: false, message: "La fonction de qualification est introuvable. Lancez « netlify dev » (en local) ou redéployez le site.", errors: {}, retryable: true };
  }
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.', errors: {}, retryable: false };
  if (res.status >= 500) return { ok: false, message: 'Le serveur a rencontré une erreur. Votre saisie est conservée : réessayez dans un instant.', errors: {}, retryable: true };
  return { ok: false, message: body?.message ?? 'Le résultat a été refusé.', errors: body?.errors ?? {}, retryable: false };
}
