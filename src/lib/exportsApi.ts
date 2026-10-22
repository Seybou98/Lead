// Appels des rapports programmés (voir netlify/functions/exports-hub.ts). L'identité est celle du jeton Firebase de
// l'utilisateur connecté ; les droits sont revérifiés par le serveur.

import { auth } from './firebase';
import type { ExportRun } from '../domain/reports/schedule';

export type RunsResponse = { ok: true; runs: ExportRun[] } | { ok: false; message: string };
export type RunResponse = { ok: true; run: ExportRun } | { ok: false; message: string };
export type FileResponse = { ok: true; filename: string; mime: string; content: string } | { ok: false; message: string; gone?: boolean };

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
    const res = await fetch(`${BASE}/api/exports-hub`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
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
  if (r.status === 404 && !r.json?.message) return 'La fonction des rapports programmés est introuvable : redéployez le site ou relancez le serveur de développement.';
  if (r.status === 401) return 'Votre session a expiré. Reconnectez-vous.';
  if (r.status === 403) return typeof r.json?.message === 'string' ? r.json.message : 'Action réservée aux administrateurs et aux managers.';
  if (r.status >= 500) return 'Le serveur a rencontré une erreur. Réessayez dans un instant.';
  return typeof r.json?.message === 'string' ? r.json.message : fallback;
}

export async function fetchRuns(): Promise<RunsResponse> {
  const r = await call({ action: 'runs' });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok && Array.isArray(r.json.runs)) return { ok: true, runs: r.json.runs as ExportRun[] };
  return { ok: false, message: failure(r, 'L’historique est indisponible.') };
}

export async function runScheduleNow(scheduleId: string): Promise<RunResponse> {
  const r = await call({ action: 'run', scheduleId });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok && r.json.run) return { ok: true, run: r.json.run as ExportRun };
  return { ok: false, message: failure(r, 'L’exécution a été refusée.') };
}

export async function resendRunEmails(runId: string): Promise<RunResponse> {
  const r = await call({ action: 'resend', runId });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok && r.json.run) return { ok: true, run: r.json.run as ExportRun };
  return { ok: false, message: failure(r, 'Le renvoi a été refusé.') };
}

export async function fetchRunFile(runId: string, file: string): Promise<FileResponse> {
  const r = await call({ action: 'download', runId, file });
  if ('error' in r) return { ok: false, message: r.error };
  if (r.status === 200 && r.json?.ok && typeof r.json.content === 'string') return { ok: true, filename: String(r.json.filename ?? 'rapport'), mime: String(r.json.mime ?? 'text/plain'), content: r.json.content };
  return { ok: false, message: failure(r, 'Le fichier est indisponible.'), gone: r.status === 410 };
}
