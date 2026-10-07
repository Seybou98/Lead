import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildAlertBars, EMPTY_ALERT_STATE, parseAlertState, strongestSound, tickAlerts, titlePrefix, type AlertBars, type AlertFire, type AlertSound, type AlertState } from '../../domain/alerts/engine';
import { askNotifPermission, audioStatus, notifStatus, notifyDesktop, playAlert, readMuted, unlockAudio, writeMuted, type AudioStatus, type NotifStatus } from '../../lib/alertSound';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { newRequestId } from '../../lib/qualifyApi';
import { sendStatus } from '../../lib/statusApi';
import { announceCallSession, buildCallSession, loadSession, saveSession } from '../../pages/myday/callSession';
import { useLeadsList, useNow } from '../../pages/leads/useLeadsData';

export interface AlertToast {
  id: string;
  kind: AlertFire['kind'];
  leadId: string;
  title: string;
  description: string;
}

export interface AlertsValue {
  /** false : l'utilisateur n'est pas un télépro, aucune alerte n'est calculée. */
  enabled: boolean;
  bars: AlertBars;
  toasts: AlertToast[];
  dismissToast: (id: string) => void;
  audio: AudioStatus;
  muted: boolean;
  setMuted: (m: boolean) => void;
  unlock: () => Promise<void>;
  testSound: () => void;
  notif: NotifStatus;
  askNotif: () => Promise<void>;
  /**
   * Démarre l'appel du lead et ouvre Ma journée. false = impossible (pas de numéro, lead d'un autre) :
   * l'appelant propose alors la fiche. Un appel déjà en cours n'est jamais écrasé.
   */
  startCall: (leadId: string) => boolean;
}

const EMPTY: AlertsValue = {
  enabled: false,
  bars: { newLeads: null, callbacks: [], total: 0 },
  toasts: [],
  dismissToast: () => undefined,
  audio: 'unsupported',
  muted: false,
  setMuted: () => undefined,
  unlock: async () => undefined,
  testSound: () => undefined,
  notif: 'unsupported',
  askNotif: async () => undefined,
  startCall: () => false,
};

const Ctx = createContext<AlertsValue>(EMPTY);
/** Exporté pour les essais visuels : permet de fournir des alertes sans écouter Firestore. */
export const AlertsContext = Ctx;
export const useAlerts = () => useContext(Ctx);

const TOAST_MS = 10_000;
const stateKey = (uid: string) => `cl_alerts_${uid}`;

function loadState(uid: string): AlertState {
  try {
    return parseAlertState(sessionStorage.getItem(stateKey(uid)));
  } catch {
    return EMPTY_ALERT_STATE;
  }
}
function saveState(uid: string, s: AlertState): void {
  try {
    sessionStorage.setItem(stateKey(uid), JSON.stringify(s));
  } catch {
    /* sans stockage : au rechargement, les alertes en cours sont rejouées une fois, rien de plus */
  }
}

/** Les alertes ne concernent que le télépro : ailleurs, aucune écoute Firestore n'est ouverte. */
export function AlertsProvider({ uid, enabled, children }: { uid: string; enabled: boolean; children: ReactNode }) {
  if (!enabled) return <Ctx.Provider value={EMPTY}>{children}</Ctx.Provider>;
  return <ActiveAlerts uid={uid}>{children}</ActiveAlerts>;
}

function ActiveAlerts({ uid, children }: { uid: string; children: ReactNode }) {
  const data = useLeadsList('telepro', uid);
  const now = useNow(1000);

  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const [audio, setAudio] = useState<AudioStatus>(() => audioStatus());
  const [muted, setMutedState] = useState<boolean>(() => readMuted());
  const [notif, setNotif] = useState<NotifStatus>(() => notifStatus());
  const stateRef = useRef<AlertState>(loadState(uid));
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Sonnerie déclenchée alors que le navigateur bloquait encore le son : rejouée dès le premier clic.
  const pendingRef = useRef<AlertSound | null>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const profileStatus = user?.profile?.operationalStatus ?? null;
  const hasProfile = !!user?.profile;

  const bars = useMemo(() => buildAlertBars(data.items, uid, now), [data.items, uid, now]);

  // ── Déclenchement : une fois par seconde, depuis les données ──
  useEffect(() => {
    if (data.loading) return;
    const { state, fires } = tickAlerts(stateRef.current, data.items, uid, now);
    stateRef.current = state;
    if (fires.length === 0) return;
    saveState(uid, state);

    // Plusieurs alertes dans la même seconde : une seule sonnerie, la plus forte (pas de cacophonie).
    const sound = strongestSound(fires.map((f) => f.sound));
    if (sound && !mutedRef.current && !playAlert(sound)) {
      // Son bloqué (aucun clic depuis le chargement, ou module rechargé) : on le retient au lieu de le perdre,
      // et on remet l'état affiché d'accord avec la réalité pour que la bande « son bloqué » apparaisse.
      pendingRef.current = strongestSound([pendingRef.current, sound]);
      setAudio(audioStatus());
    }

    for (const f of fires) notifyDesktop(f.title, f.description, f.id);

    setToasts((cur) => [...cur, ...fires.map((f) => ({ id: f.id, kind: f.kind, leadId: f.leadId, title: f.title, description: f.description }))].slice(-4));
    for (const f of fires) setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== f.id)), TOAST_MS);
  }, [now, data.items, data.loading, uid]);

  // L'état n'est pas rejoué : on le sauvegarde aussi quand rien ne se déclenche mais que des alertes se terminent.
  useEffect(() => {
    if (!data.loading) saveState(uid, stateRef.current);
  }, [bars.total, data.loading, uid]);

  // ── Son : débloqué au premier geste n'importe où dans la page ──
  const unlock = useCallback(async () => {
    const ok = await unlockAudio();
    setAudio(audioStatus());
    // Confirmation audible que le son marche ; si une alerte a sonné dans le vide, c'est elle qu'on rejoue.
    if (ok && !mutedRef.current) playAlert(pendingRef.current ?? 'sla');
    pendingRef.current = null;
  }, []);
  useEffect(() => {
    if (audio === 'ready' || audio === 'unsupported') return;
    const on = () => void unlock();
    window.addEventListener('pointerdown', on, { once: true });
    window.addEventListener('keydown', on, { once: true });
    return () => {
      window.removeEventListener('pointerdown', on);
      window.removeEventListener('keydown', on);
    };
  }, [audio, unlock]);

  // ── Titre de l'onglet : « (2) Nouveau lead · … » ──
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) (Nouveau lead|Rappel client) · /, '');
    document.title = titlePrefix(bars) + base;
    return () => {
      document.title = base;
    };
  }, [bars]);

  const startCall = useCallback(
    (leadId: string): boolean => {
      // Un appel est déjà en cours : on y retourne au lieu de l'écraser.
      if (loadSession(uid, Date.now())) {
        navigate('/ma-journee');
        announceCallSession();
        return true;
      }
      const lead = data.items.find((l) => l.id === leadId);
      if (!lead || !lead.phone || lead.ownerId !== uid) return false;
      const current = profileStatus ?? 'available';
      saveSession(uid, buildCallSession(lead.id, Date.now(), newRequestId(), current));
      // Statut « En appel » (§12.1.2), sans bloquer l'appel si le serveur ne répond pas.
      if (hasProfile && current !== 'on_call') void sendStatus('on_call');
      navigate('/ma-journee');
      announceCallSession();
      return true;
    },
    [data.items, uid, navigate, profileStatus, hasProfile]
  );

  const value = useMemo<AlertsValue>(
    () => ({
      enabled: true,
      bars,
      toasts,
      dismissToast: (id) => setToasts((cur) => cur.filter((t) => t.id !== id)),
      audio,
      muted,
      setMuted: (m) => {
        writeMuted(m);
        setMutedState(m);
      },
      unlock,
      testSound: () => {
        void unlockAudio().then(() => {
          setAudio(audioStatus());
          playAlert('new_lead');
        });
      },
      notif,
      askNotif: async () => setNotif(await askNotifPermission()),
      startCall,
    }),
    [bars, toasts, audio, muted, notif, unlock, startCall]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
