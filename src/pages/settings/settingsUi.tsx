import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export const inputCls = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-100 disabled:text-slate-500';

export function SettingsCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-5', className)}>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-blue-600' : 'bg-slate-300')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

export function NumberField({ value, onChange, label, min = 0, max, suffix, disabled, width = 'w-20' }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; suffix?: string; disabled?: boolean; width?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <input aria-label={label} type="number" inputMode="numeric" min={min} max={max} disabled={disabled} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} className={cn(inputCls, width)} />
      {suffix && <span className="text-sm text-slate-500">{suffix}</span>}
    </span>
  );
}

const UNITS = [
  { key: 'min', label: 'minutes', factor: 1 },
  { key: 'h', label: 'heures', factor: 60 },
  { key: 'j', label: 'jours', factor: 24 * 60 },
] as const;

/** Durée saisie en minutes, heures ou jours (affichée dans la plus grande unité qui tombe juste). */
export function DelayField({ minutes, onChange, label, disabled }: { minutes: number; onChange: (m: number) => void; label: string; disabled?: boolean }) {
  const unit = UNITS.slice().reverse().find((u) => Number.isFinite(minutes) && minutes > 0 && minutes % u.factor === 0) ?? UNITS[0];
  const shown = Number.isFinite(minutes) ? minutes / unit.factor : Number.NaN;
  return (
    <span className="inline-flex items-center gap-2">
      <input aria-label={label} type="number" inputMode="decimal" min={1} disabled={disabled} value={Number.isFinite(shown) ? shown : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value) * unit.factor))} className={cn(inputCls, 'w-20')} />
      <select aria-label={`${label} : unité`} disabled={disabled} value={unit.key} onChange={(e) => { const next = UNITS.find((u) => u.key === e.target.value) ?? UNITS[0]; onChange(Math.round((Number.isFinite(shown) ? shown : 1) * next.factor)); }} className={cn(inputCls, 'py-2')}>
        {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
      </select>
    </span>
  );
}

export function SaveBar({ onCancel, onSave, busy, blocked = false, dirty, saveLabel = 'Enregistrer les paramètres', extra }: { onCancel: () => void; onSave: () => void; busy: boolean; /** Saisie invalide : l'enregistrement est refusé, avec les raisons affichées plus haut. */ blocked?: boolean; dirty: boolean; saveLabel?: string; extra?: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-3 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-3 py-4 backdrop-blur sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
      {extra}
      <button type="button" onClick={onCancel} disabled={busy || !dirty} className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Annuler</button>
      <button type="button" onClick={onSave} disabled={busy || blocked || !dirty} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Enregistrement…' : saveLabel}</button>
    </div>
  );
}

export function Feedback({ errors, notice }: { errors: string[]; notice: { kind: 'ok' | 'error'; text: string } | null }) {
  return (
    <>
      {errors.length > 0 && (
        <ul role="alert" className="mt-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {errors.map((e) => <li key={e} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {e}</li>)}
        </ul>
      )}
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
        </p>
      )}
    </>
  );
}
