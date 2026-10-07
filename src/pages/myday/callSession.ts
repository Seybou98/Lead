// Appel en cours côté navigateur : sans téléphonie intégrée, le CRM sait qu'un appel a démarré (clic sur
// « Appeler maintenant ») et que le télépro doit ensuite déclarer son résultat (§12.1.2 : « l'action suivante
// reste verrouillée tant qu'aucun résultat valide n'est enregistré »). L'état survit à un rechargement de
// page (§25.9 : une opération longue peut être quittée et reprise) grâce au stockage de session.

import { OPERATIONAL_STATUSES } from '../../domain/enums';
import { statusAfterCall } from '../../domain/availability/status';

export interface CallSession {
  leadId: string;
  startedAtMs: number;
  /** calling : appel en cours · qualifying : appel terminé, résultat à déclarer. */
  phase: 'calling' | 'qualifying';
  endedAtMs: number | null;
  /** Identifiant d'idempotence du résultat : il survit aux nouveaux essais après une erreur réseau. */
  requestId: string;
  /** Statut du menu Disponible / Pause d'avant l'appel : rétabli à la fin de l'appel. */
  resumeStatus?: string;
}

/** Au-delà, une session oubliée (onglet laissé ouvert) est abandonnée plutôt que reprise à tort. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const KEY = (uid: string) => `cl_call_${uid}`;

export function parseSession(raw: string | null, nowMs: number): CallSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<CallSession> | null;
    if (!s || typeof s !== 'object') return null;
    if (typeof s.leadId !== 'string' || s.leadId === '' || typeof s.requestId !== 'string' || s.requestId.length < 8) return null;
    if (typeof s.startedAtMs !== 'number' || !Number.isFinite(s.startedAtMs) || s.startedAtMs > nowMs + 60_000) return null;
    if (nowMs - s.startedAtMs > SESSION_MAX_AGE_MS) return null;
    if (s.phase !== 'calling' && s.phase !== 'qualifying') return null;
    const endedAtMs = typeof s.endedAtMs === 'number' && Number.isFinite(s.endedAtMs) ? s.endedAtMs : null;
    const resumeStatus = (OPERATIONAL_STATUSES as readonly unknown[]).includes(s.resumeStatus) ? s.resumeStatus : undefined;
    return { leadId: s.leadId, startedAtMs: s.startedAtMs, phase: s.phase, endedAtMs, requestId: s.requestId, ...(resumeStatus ? { resumeStatus } : {}) };
  } catch {
    return null;
  }
}

export function loadSession(uid: string, nowMs: number): CallSession | null {
  try {
    return parseSession(sessionStorage.getItem(KEY(uid)), nowMs);
  } catch {
    return null; // stockage indisponible (navigation privée) : pas de reprise, l'écran reste utilisable
  }
}

export function saveSession(uid: string, s: CallSession | null): void {
  try {
    if (s) sessionStorage.setItem(KEY(uid), JSON.stringify(s));
    else sessionStorage.removeItem(KEY(uid));
  } catch {
    /* sans stockage : l'état reste en mémoire pour cette page */
  }
}

/** Évènement envoyé quand une session d'appel est démarrée depuis ailleurs que de Ma journée (barres d'alerte). */
export const CALL_SESSION_EVENT = 'cl-call-session';

export function announceCallSession(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CALL_SESSION_EVENT));
}

/** Durée de l'appel en secondes (jusqu'à la fin déclarée, sinon jusqu'à maintenant). */
export function callDurationSeconds(s: Pick<CallSession, 'startedAtMs' | 'endedAtMs'>, nowMs: number): number {
  return Math.max(0, Math.round(((s.endedAtMs ?? nowMs) - s.startedAtMs) / 1000));
}

/** « 06:18 », « 1:02:05 » : durée d'appel. */
export function formatDuration(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── Dates saisies dans le navigateur ─────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');

/** ms → valeurs des champs `date` (AAAA-MM-JJ) et `time` (HH:mm), en heure locale du navigateur. */
export function toLocalFields(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}` };
}

/** Champs `date` + `time` → ms ; NaN si l'un manque ou est invalide (jamais une date « par défaut »). */
export function fromLocalFields(date: string, time: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return Number.NaN;
  const dt = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Refuse les dates qui « débordent » (31/02) : le navigateur les décalerait en silence.
  if (dt.getFullYear() !== Number(d[1]) || dt.getMonth() !== Number(d[2]) - 1 || dt.getDate() !== Number(d[3])) return Number.NaN;
  return dt.getTime();
}

/** Raccourcis de la fig. 7 : « Dans 30 min », « Cet après-midi », « Demain matin ». */
export function callbackPresets(nowMs: number): { key: string; label: string; atMs: number }[] {
  const now = new Date(nowMs);
  const at = (dayOffset: number, h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m).getTime();
  const out = [{ key: '30', label: 'Dans 30 min', atMs: nowMs + 30 * 60_000 }];
  // « Cet après-midi » n'a de sens que s'il est encore à venir ; sinon on ne propose pas un créneau déjà passé.
  if (nowMs < at(0, 14)) out.push({ key: 'pm', label: 'Cet après-midi', atMs: at(0, 15) });
  out.push({ key: 'tomorrow', label: 'Demain matin', atMs: at(1, 9) });
  return out;
}

/** Copie dans le presse-papiers ; false si le navigateur refuse (page non sécurisée, droit refusé). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Nouvelle session d'appel : le statut en cours (hors « En appel ») est retenu pour être rétabli ensuite. */
export function buildCallSession(leadId: string, startedAtMs: number, requestId: string, currentStatus: string | null | undefined): CallSession {
  return { leadId, startedAtMs, phase: 'calling', endedAtMs: null, requestId, resumeStatus: statusAfterCall(currentStatus) };
}
