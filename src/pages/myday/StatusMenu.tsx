import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Lock } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { OperationalStatus } from '../../domain/enums';
import { OPERATIONAL_STATUS_LABELS } from '../../domain/labels';
import { LOCKED_STATUSES, SELECTABLE_STATUSES, STATUS_HINT, STATUS_TONE, type StatusTone } from '../../domain/availability/status';
import type { StatusResponse } from '../../lib/statusApi';

const DOT: Record<StatusTone, string> = { green: 'bg-emerald-500', blue: 'bg-blue-500', amber: 'bg-amber-500', slate: 'bg-slate-400', red: 'bg-red-500' };

const hm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Menu « Disponible / Pause… » de Ma journée (fig. 4, §12.1.4). */
export function StatusMenu({
  status,
  sinceMs,
  suspended,
  onChange,
  initialOpen = false,
}: {
  status: OperationalStatus;
  sinceMs: number | null;
  /** Distribution suspendue par le manager : indépendante du statut, mais le télépro doit le savoir. */
  suspended: boolean;
  onChange: (next: OperationalStatus) => Promise<StatusResponse>;
  /** Menu ouvert d'emblée (essais visuels). */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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

  const locked = LOCKED_STATUSES.includes(status);
  const tone = STATUS_TONE[status];

  const pick = async (next: OperationalStatus) => {
    if (busy) return;
    if (next === status) return setOpen(false);
    setBusy(true);
    setError(null);
    const res = await onChange(next);
    setBusy(false);
    if (res.ok) setOpen(false);
    else setError(res.message);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <span className={cn('h-2 w-2 rounded-full', DOT[tone])} aria-hidden="true" />
        {OPERATIONAL_STATUS_LABELS[status]}
        {locked && <Lock className="h-3.5 w-3.5 text-slate-400" aria-label="Statut géré par votre manager" />}
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>

      {open && (
        <div role="listbox" aria-label="Statut" className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          {sinceMs !== null && <p className="px-3 pb-1 pt-1.5 text-xs text-slate-500">{OPERATIONAL_STATUS_LABELS[status]} depuis {hm(sinceMs)}</p>}

          {locked ? (
            <p className="m-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">Votre statut « {OPERATIONAL_STATUS_LABELS[status].toLowerCase()} » est géré par votre manager : contactez-le pour le modifier.</p>
          ) : (
            <ul className="space-y-0.5">
              {SELECTABLE_STATUSES.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={status === s}
                    disabled={busy}
                    onClick={() => void pick(s)}
                    className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50 disabled:opacity-60', status === s && 'bg-slate-50')}
                  >
                    <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', DOT[STATUS_TONE[s]])} aria-hidden="true" />
                    <span className="flex-1">
                      <span className="block text-sm font-semibold text-slate-900">{OPERATIONAL_STATUS_LABELS[s]}</span>
                      <span className="block text-xs text-slate-500">{STATUS_HINT[s]}</span>
                    </span>
                    {status === s && <Check className="mt-0.5 h-4 w-4 text-blue-600" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(status === 'on_call' || status === 'processing' || status === 'in_meeting' || status === 'disconnected') && (
            <p className="mx-3 mb-1 mt-2 text-xs text-slate-500">Statut actuel : {OPERATIONAL_STATUS_LABELS[status].toLowerCase()}. {status === 'on_call' ? 'Il est rétabli quand vous enregistrez le résultat de l’appel.' : ''}</p>
          )}
          {suspended && <p className="m-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">Votre distribution est suspendue par votre manager : aucun nouveau lead ne vous est attribué, quel que soit votre statut.</p>}
          {error && <p role="alert" className="m-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">{error}</p>}
        </div>
      )}
    </div>
  );
}
