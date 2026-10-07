// Sonneries des alertes (§5.1, §12.11), générées par le navigateur : aucun fichier audio à héberger.
// Un navigateur n'autorise le son qu'APRÈS un geste de l'utilisateur (clic, touche) : tant que ce n'est pas
// fait, l'état est « locked » et l'interface le dit au télépro au lieu de rester silencieuse sans explication.

import type { AlertSound } from '../domain/alerts/engine';

export type AudioStatus = 'unsupported' | 'locked' | 'ready';

type AudioCtor = typeof AudioContext;
const Ctor = (): AudioCtor | undefined =>
  typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);

let ctx: AudioContext | null = null;

export function audioStatus(): AudioStatus {
  if (!Ctor()) return 'unsupported';
  return ctx && ctx.state === 'running' ? 'ready' : 'locked';
}

/** À appeler depuis un geste utilisateur. Renvoie true si le son est maintenant autorisé. */
export async function unlockAudio(): Promise<boolean> {
  const C = Ctor();
  if (!C) return false;
  try {
    ctx ??= new C();
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

interface Note {
  freq: number;
  start: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
}

/** Une sonnerie = quelques notes courtes ; distinctes pour qu'on reconnaisse l'alerte sans regarder l'écran. */
const PATTERNS: Record<AlertSound, Note[]> = {
  // Arrivée d'un lead : trois notes montantes, fortes.
  new_lead: [
    { freq: 784, start: 0, duration: 0.16, gain: 0.55, type: 'triangle' },
    { freq: 988, start: 0.18, duration: 0.16, gain: 0.6, type: 'triangle' },
    { freq: 1319, start: 0.36, duration: 0.3, gain: 0.65, type: 'triangle' },
  ],
  // Rappel périodique d'un lead non pris en charge : un bip net.
  sla: [{ freq: 660, start: 0, duration: 0.22, gain: 0.4, type: 'sine' }],
  // Rappel client dû : deux notes.
  callback: [
    { freq: 740, start: 0, duration: 0.2, gain: 0.45, type: 'sine' },
    { freq: 988, start: 0.24, duration: 0.28, gain: 0.45, type: 'sine' },
  ],
  // SLA dépassé / alerte critique : quatre bips alternés, plus graves et plus insistants.
  critical: [
    { freq: 880, start: 0, duration: 0.14, gain: 0.6, type: 'square' },
    { freq: 620, start: 0.18, duration: 0.14, gain: 0.6, type: 'square' },
    { freq: 880, start: 0.36, duration: 0.14, gain: 0.6, type: 'square' },
    { freq: 620, start: 0.54, duration: 0.2, gain: 0.6, type: 'square' },
  ],
};

/** Joue la sonnerie ; sans effet (et sans erreur) si le son n'est pas encore autorisé. */
export function playAlert(sound: AlertSound): boolean {
  if (!ctx || ctx.state !== 'running') return false;
  try {
    const t0 = ctx.currentTime + 0.02;
    for (const n of PATTERNS[sound]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.value = n.freq;
      // Enveloppe courte : pas de « clic » au début ni à la fin.
      g.gain.setValueAtTime(0.0001, t0 + n.start);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + n.start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.duration);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.duration + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Notifications du navigateur (onglet en arrière-plan) ─────────────────────

export type NotifStatus = 'unsupported' | 'default' | 'granted' | 'denied';

export const notifStatus = (): NotifStatus =>
  typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as NotifStatus);

export async function askNotifPermission(): Promise<NotifStatus> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifStatus;
  } catch {
    return notifStatus();
  }
}

/** Notification système, seulement si l'onglet est caché (sinon l'écran suffit). */
export function notifyDesktop(title: string, body: string, tag: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && !document.hidden) return;
  try {
    const n = new Notification(title, { body, tag, requireInteraction: false });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* certains navigateurs mobiles refusent le constructeur : on ignore */
  }
}

// ── Préférence « son coupé » (propre à l'appareil) ───────────────────────────

const MUTE_KEY = 'cl_alerts_muted';
export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}
export function writeMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, '1');
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    /* stockage indisponible : la préférence ne survit pas au rechargement */
  }
}
