// Appels du hub d'intégrations (voir netlify/functions/integrations-hub.ts). Administrateur seulement ; l'identité est
// celle du jeton Firebase de l'utilisateur connecté.

import { auth } from './firebase';
import type { JournalEntry } from '../domain/integrations/hub';

export type JournalResponse = { ok: true; entries: JournalEntry[]; truncated: boolean; limits: { raw: number; conversions: number } } | { ok: false; message: string };
export type ReplayResponse = { ok: true; kind: 'created' | 'attached' | 'replay'; leadId: string; message: string } | { ok: false; message: string };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | { error: string }> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { error: 'Votre session a expiré. Reconnectez-vous.' };
  try {
    const res = await fetch(`${BASE}/api/integrations-hub`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    let json: Record<string, unknown> | null = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return { error: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.' };
  }
}

function failure(r: { status: number; json: Record<string, unknown> | null }, fallback: string): string {
  if (r.status === 404 && !r.json?.message) return "La fonction du hub est introuvable : redéployez le site ou relancez le serveur de développement.";
  if (r.status === 401) return 'Votre session a expiré. Reconnectez-vous.';
  if (r.status === 403) return "Le hub d'intégrations est réservé à l'administrateur.";
  if (r.status >= 500) return 'Le serveur a rencontré une erreur. Réessayez dans un instant.';
  return typeof r.json?.message === 'string' ? r.json.message : fallback;
}

export async function fetchJournal(): Promise<JournalResponse> {
  const r = await call({ action: 'journal' });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok && Array.isArray(r.json.entries)) return { ok: true, entries: r.json.entries as JournalEntry[], truncated: r.json.truncated === true, limits: (r.json.limits as { raw: number; conversions: number }) ?? { raw: 0, conversions: 0 } };
  return { ok: false, message: failure(r, 'Le journal est indisponible.') };
}

export async function replayRawLead(rawLeadId: string, overrides: { phone?: string; email?: string } = {}): Promise<ReplayResponse> {
  const r = await call({ action: 'replay', rawLeadId, overrides });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok) return { ok: true, kind: r.json.kind as 'created', leadId: String(r.json.leadId ?? ''), message: String(r.json.message ?? '') };
  return { ok: false, message: failure(r, 'La reprise a été refusée.') };
}
