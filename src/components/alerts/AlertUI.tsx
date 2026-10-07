import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, BellRing, Clock, Phone, Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatCounter } from '../../domain/leads/leadList';
import type { CallbackBar, CallbackLevel } from '../../domain/alerts/engine';
import { useAlerts } from './AlertsProvider';

const minutesLate = (dueAtMs: number, now: number) => Math.max(0, Math.floor((now - dueAtMs) / 60_000));

const CB_STYLE: Record<CallbackLevel, string> = {
  soon: 'border-blue-200 bg-blue-50 text-blue-900',
  due: 'border-blue-300 bg-blue-100 text-blue-950',
  orange: 'border-amber-300 bg-amber-50 text-amber-900',
  red: 'border-red-300 bg-red-50 text-red-900',
};

function callbackText(c: CallbackBar, now: number): string {
  switch (c.level) {
    case 'soon':
      return `Rappel dans ${formatCounter(Math.max(0, c.dueAtMs - now))} : ${c.name}`;
    case 'due':
      return `Rappel client à faire maintenant : ${c.name}`;
    default:
      return `Rappel en retard de ${minutesLate(c.dueAtMs, now)} min : ${c.name}`;
  }
}

/** Heure courante pour les libellés des barres ; recalculée chaque seconde, comme les compteurs. */
function useTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Barres sous l'en-tête. Elles ne se ferment PAS : elles disparaissent quand le lead change de statut
 * (§5.1 : « fermer une notification ne suffit pas à arrêter l'alerte »).
 */
export function AlertBars() {
  const { enabled, bars, audio, muted, testSound, startCall } = useAlerts();
  const navigate = useNavigate();
  const now = useTick();
  if (!enabled) return null;

  /** Lance l'appel ; sans numéro (ou lead d'un autre), ouvre la fiche pour que le télépro ne reste pas bloqué. */
  const act = (leadId: string) => {
    if (!startCall(leadId)) navigate(`/mes-leads/${leadId}`);
  };

  const nl = bars.newLeads;
  const lvl = nl?.oldest.level;
  const newStyle = lvl === 'breached' ? 'border-red-300 bg-red-50 text-red-900' : lvl === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900';
  const callbacks = bars.callbacks.slice(0, 3);

  return (
    <div className="space-y-px" aria-live="polite">
      {audio === 'locked' && !muted && (
        <p role="status" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 sm:px-6">
          <VolumeX className="h-3.5 w-3.5 flex-shrink-0" /> Le son des alertes est bloqué par le navigateur : cliquez n'importe où dans la page pour l'activer.
          <button type="button" onClick={testSound} className="ml-1 rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-700">Activer et tester le son</button>
        </p>
      )}

      {nl && (
        <div role="alert" className={cn('flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 text-sm sm:px-6', newStyle)}>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <BellRing className="h-4 w-4 flex-shrink-0" />
            <span className="font-semibold">Nouveau lead à prendre en charge : {nl.oldest.name}</span>
            <span className="font-bold tabular-nums">{formatCounter(nl.oldest.ageMs)}</span>
            {lvl === 'breached' && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">SLA dépassé</span>}
            {lvl === 'warning' && <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">Bientôt dépassé</span>}
            {nl.count > 1 && <span className="text-xs opacity-80">+ {nl.count - 1} autre(s) lead(s) en attente</span>}
          </p>
          <span className="flex items-center gap-3">
            <Link to={`/mes-leads/${nl.oldest.id}`} className="text-xs font-medium underline opacity-80 hover:opacity-100">Voir la fiche</Link>
            <button type="button" onClick={() => act(nl.oldest.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-blue-700"><Phone className="h-3.5 w-3.5" /> Prendre en charge</button>
          </span>
        </div>
      )}

      {callbacks.map((c) => (
        <div key={`${c.leadId}@${c.dueAtMs}`} role="alert" className={cn('flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 text-sm sm:px-6', CB_STYLE[c.level])}>
          <p className="flex items-center gap-3">
            <Clock className="h-4 w-4 flex-shrink-0" />
            <span className="font-semibold">{callbackText(c, now)}</span>
            {c.level === 'red' && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">Urgent</span>}
            {c.level === 'orange' && <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">En retard</span>}
          </p>
          <span className="flex items-center gap-3">
            <Link to={`/mes-leads/${c.leadId}`} className="text-xs font-medium underline opacity-80 hover:opacity-100">Voir la fiche</Link>
            <button type="button" onClick={() => act(c.leadId)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-blue-700"><Phone className="h-3.5 w-3.5" /> Appeler</button>
          </span>
        </div>
      ))}
      {bars.callbacks.length > callbacks.length && (
        <p className="border-b border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-600 sm:px-6">+ {bars.callbacks.length - callbacks.length} autre(s) rappel(s) à traiter</p>
      )}
    </div>
  );
}

/** Notification d'arrivée : visible quelques secondes, jamais seule (la barre reste tant que le lead attend). */
export function AlertToasts() {
  const { enabled, toasts, dismissToast } = useAlerts();
  if (!enabled || toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="assertive">
      {toasts.map((t) => {
        const strong = t.kind === 'new_lead' || t.kind === 'sla_breached';
        return (
          <div key={t.id} role="alert" className={cn('pointer-events-auto flex items-start gap-3 rounded-xl border p-4 shadow-xl', strong ? 'border-blue-300 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-900', t.kind === 'sla_breached' && 'border-red-300 bg-red-600')}>
            <BellRing className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{t.title}</p>
              <p className={cn('truncate text-sm', strong ? 'text-white/90' : 'text-slate-600')}>{t.description}</p>
              <Link to="/ma-journee" onClick={() => dismissToast(t.id)} className={cn('mt-2 inline-block text-xs font-bold uppercase tracking-wide underline', strong ? 'text-white' : 'text-blue-700')}>Ouvrir Ma journée</Link>
            </div>
            <button type="button" onClick={() => dismissToast(t.id)} aria-label="Fermer la notification" className={cn('rounded p-1', strong ? 'hover:bg-white/20' : 'hover:bg-slate-100')}><X className="h-4 w-4" /></button>
          </div>
        );
      })}
    </div>
  );
}

/** Cloche de l'en-tête : pastille du nombre d'éléments à traiter, et réglages du son. */
export function AlertBell() {
  const { enabled, bars, audio, muted, setMuted, unlock, testSound, notif, askNotif } = useAlerts();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useTick();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!enabled) {
    return (
      <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
        <Bell size={20} />
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={bars.total > 0 ? `Notifications : ${bars.total} à traiter` : 'Notifications'} className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100">
        {bars.total > 0 ? <BellRing size={20} className="text-red-600" /> : <Bell size={20} />}
        {bars.total > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{bars.total}</span>}
      </button>

      {open && (
        <div role="dialog" aria-label="Alertes" className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
          <p className="text-sm font-bold text-slate-900">Alertes</p>
          {bars.total === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Rien à traiter pour le moment.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {bars.newLeads && (
                <li className="rounded-lg bg-blue-50 p-2.5 text-blue-900">
                  <span className="font-semibold">{bars.newLeads.count} nouveau(x) lead(s)</span> — le plus ancien : {bars.newLeads.oldest.name} ({formatCounter(bars.newLeads.oldest.ageMs)})
                </li>
              )}
              {bars.callbacks.map((c) => (
                <li key={`${c.leadId}@${c.dueAtMs}`} className={cn('rounded-lg border p-2.5', CB_STYLE[c.level])}>{callbackText(c, now)}</li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-700">{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />} Son des alertes</span>
              <button type="button" onClick={() => setMuted(!muted)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">{muted ? 'Réactiver' : 'Couper'}</button>
            </div>
            {audio === 'unsupported' ? (
              <p className="text-xs text-slate-500">Ce navigateur ne sait pas jouer les sons d'alerte.</p>
            ) : (
              <button type="button" onClick={audio === 'ready' ? testSound : () => void unlock()} className="text-xs font-medium text-blue-600 hover:underline">{audio === 'ready' ? 'Tester le son' : 'Activer le son'}</button>
            )}
            {notif !== 'unsupported' && notif !== 'granted' && (
              <div>
                <button type="button" disabled={notif === 'denied'} onClick={() => void askNotif()} className="text-xs font-medium text-blue-600 hover:underline disabled:text-slate-400 disabled:no-underline">Activer les notifications du navigateur</button>
                <p className="text-[11px] text-slate-500">{notif === 'denied' ? 'Refusées : à réautoriser dans les réglages du site.' : 'Pour être prévenu même si cet onglet est en arrière-plan.'}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
