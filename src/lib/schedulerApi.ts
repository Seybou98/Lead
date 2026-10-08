// Déclenchement manuel du planificateur (voir netlify/functions/scheduler-run.ts) — administrateur uniquement.

import { auth } from './firebase';

export interface SchedulerReportView {
  atMs: number;
  leadsRead: number;
  escalations: number;
  recycled: number;
  archived: number;
  assigned: number;
  stillWaiting: number;
  errors: string[];
}

export type SchedulerRunResponse = { ok: true; report: SchedulerReportView } | { ok: false; message: string };

const BASE = (import.meta.env.VITE_QUALIFY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function sendSchedulerRun(): Promise<SchedulerRunResponse> {
  let token = '';
  try {
    token = (await auth.currentUser?.getIdToken()) ?? '';
  } catch {
    token = '';
  }
  if (!token) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/scheduler-run`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, message: 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.' };
  }
  let body: { ok?: boolean; report?: SchedulerReportView; message?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.ok && body.report) return { ok: true, report: body.report };
  if (res.status === 404 && !body?.message) return { ok: false, message: 'La fonction du planificateur est introuvable : redéployez le site ou relancez le serveur de développement.' };
  if (res.status === 401) return { ok: false, message: 'Votre session a expiré. Reconnectez-vous.' };
  if (res.status === 403) return { ok: false, message: body?.message ?? 'Réservé aux administrateurs.' };
  return { ok: false, message: res.status >= 500 ? 'Le serveur a rencontré une erreur. Réessayez dans un instant.' : (body?.message ?? 'Exécution refusée.') };
}
