import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, Info, Phone, User, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatPhoneDisplay, type LeadListItem } from '../../domain/leads/leadList';

export const fieldClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';
export const labelClass = 'mb-1.5 block text-xs font-medium text-slate-600';

/** Fenêtre de résultat d'appel (figs. 6 à 13) : titre, fermeture, carte du client, corps, pied d'actions. */
export function OutcomeModal({
  title,
  onClose,
  busy,
  lead,
  icon,
  badge,
  width = 'max-w-2xl',
  children,
  footerNote,
  actions,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  lead: LeadListItem;
  /** Pictogramme de la carte client (carré ou rond coloré, propre à chaque résultat). */
  icon?: ReactNode;
  /** Pastille à droite de la carte client (ex. « Mauvais moment », « Faux lead »). */
  badge?: ReactNode;
  width?: string;
  children: ReactNode;
  footerNote?: ReactNode;
  actions: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className={cn('flex max-h-[92vh] w-full flex-col rounded-2xl bg-white shadow-2xl', width)}>
        <div className="flex items-center justify-between px-6 pb-3 pt-5">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-5">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
            <div className="flex items-center gap-3">
              {icon ?? (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                  <User className="h-5 w-5" />
                </span>
              )}
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {lead.fullName || 'Sans nom'}
                  {lead.productCode && <span className="font-normal text-slate-500"> · {lead.productCode}</span>}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-slate-600"><Phone className="h-3 w-3" />{formatPhoneDisplay(lead.phone)}</p>
              </div>
            </div>
            {badge}
          </div>
          <div className="mt-4">{children}</div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <p className="max-w-xs text-xs text-slate-500">{footerNote}</p>
          <div className="flex items-center gap-3">{actions}</div>
        </div>
      </div>
    </div>
  );
}

export function InfoBar({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'danger' }) {
  const styles = { info: 'border-blue-100 bg-blue-50/70 text-slate-800', warning: 'border-amber-200 bg-amber-50 text-amber-900', danger: 'border-red-200 bg-red-50 text-red-800' }[tone];
  const Icon = tone === 'info' ? Info : AlertTriangle;
  const color = { info: 'text-blue-600', warning: 'text-amber-600', danger: 'text-red-600' }[tone];
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm', styles)}>
      <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', color)} />
      <div>{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-slate-800">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition', checked ? 'bg-blue-600' : 'bg-slate-300')}>
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function PrimaryButton({ children, onClick, disabled, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn('inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50', danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700')}>
      {children}
    </button>
  );
}

export function CancelButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
      Annuler
    </button>
  );
}
