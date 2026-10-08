import { useEffect, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { parseEuroCents } from '../../domain/conversion/finance';
import type { ControlLevel } from '../../domain/conversion/controls';
import { inputCls } from '../settings/settingsUi';

export { inputCls };

export function SaleCard({ id, title, icon, aside, children, className }: { id?: string; title: string; icon?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-24 rounded-xl border border-slate-200 bg-white p-5', className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2.5 text-[15px] font-semibold text-slate-900">
          {icon}
          {title}
        </h3>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({ label, children, className, hint }: { label: string; children: React.ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cn('block text-sm', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

/** Montant en euros saisi librement (« 11 990,50 ») et rendu en centimes. Le texte tapé n'est pas réécrit pendant la saisie. */
export function EuroField({ cents, onChange, disabled, ariaLabel, className }: { cents: number; onChange: (cents: number) => void; disabled?: boolean; ariaLabel?: string; className?: string }) {
  const [text, setText] = useState(cents === 0 ? '' : String(cents / 100).replace('.', ','));
  useEffect(() => {
    const current = parseEuroCents(text) ?? 0;
    if (current !== cents) setText(cents === 0 ? '' : String(cents / 100).replace('.', ','));
    // Le texte ne se resynchronise que si la valeur change de l'extérieur (brouillon rechargé).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);
  return (
    <div className={cn('relative', className)}>
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled}
        value={text}
        placeholder="0"
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseEuroCents(e.target.value) ?? 0);
        }}
        className={cn(inputCls, 'w-full pr-7 text-right tabular-nums')}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">€</span>
    </div>
  );
}

export function LevelIcon({ level, className }: { level: ControlLevel; className?: string }) {
  if (level === 'ok') return <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white', className)}><Check className="h-3 w-3" strokeWidth={3} /></span>;
  if (level === 'to_confirm') return <AlertTriangle className={cn('h-5 w-5 flex-shrink-0 text-amber-500', className)} />;
  return <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-red-500 text-white', className)}><X className="h-3 w-3" strokeWidth={3} /></span>;
}

export const SEVERITY_LABEL = { medium: 'Exception moyenne', high: 'Exception bloquante' } as const;

export const ownerLabel = (names: ReadonlyMap<string, string>, uid: string | null): string => (uid ? (names.get(uid) ?? uid) : '—');
export const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
export const whenLabel = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
