import { cn } from '../../lib/utils';
import type { Evaluation, FieldState } from '../../domain/qualification/form';

const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-100 disabled:text-slate-500';

/** Saisie d'un champ évalué : le même rendu sert au test du constructeur et au remplissage d'un lead. */
export function FieldInput({ state, value, onChange, disabled }: { state: FieldState; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { def } = state;
  const id = `qf-${def.id}`;
  const dis = disabled || state.computed;
  switch (def.type) {
    case 'yesno':
      return (
        <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex gap-2">
          {([[true, 'Oui'], [false, 'Non']] as const).map(([v, label]) => (
            <button key={label} type="button" role="radio" aria-checked={value === v} disabled={dis} onClick={() => onChange(value === v ? undefined : v)} className={cn('rounded-lg border px-4 py-1.5 text-sm font-medium disabled:opacity-60', value === v ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>{label}</button>
          ))}
        </div>
      );
    case 'list':
      return (
        <select id={id} disabled={dis} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} className={input}>
          <option value="">Choisir…</option>
          {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'multi': {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {def.options.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" disabled={dis} checked={cur.includes(o.value)} onChange={(e) => { const next = e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value); onChange(next.length ? next : undefined); }} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'confirm':
    case 'document':
      return (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" disabled={dis} checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />
          {def.type === 'document' ? 'Document reçu' : 'Confirmé'}
        </label>
      );
    case 'number':
    case 'amount':
    case 'area':
      return (
        <div className="flex items-center gap-2">
          <input id={id} type="number" inputMode="decimal" disabled={dis} min={def.min ?? undefined} max={def.max ?? undefined} value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className={cn(input, 'max-w-[200px]')} />
          <span className="text-sm text-slate-500">{def.type === 'amount' ? '€' : def.type === 'area' ? 'm²' : ''}</span>
          {state.computed && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">calculé</span>}
        </div>
      );
    case 'datetime':
      return <input id={id} type="datetime-local" disabled={dis} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} className={cn(input, 'max-w-[240px]')} />;
    case 'address':
      return <input id={id} type="text" disabled={dis} maxLength={def.max ?? 300} value={typeof value === 'string' ? value : ''} placeholder="Numéro, rue, code postal, ville" onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} className={input} />;
    default:
      return <input id={id} type="text" disabled={dis} maxLength={def.max ?? 300} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} className={input} />;
  }
}

/** Formulaire évalué : seuls les champs visibles sont montrés, avec libellé, aide, obligation et erreur. */
export function FormFields({ evaluation, onChange, disabled }: { evaluation: Evaluation; onChange: (id: string, v: unknown) => void; disabled?: boolean }) {
  const shown = evaluation.fields.filter((s) => s.visible);
  if (shown.length === 0) return <p className="text-sm text-slate-500">Aucun champ à afficher avec ces réponses.</p>;
  return (
    <div className="space-y-4">
      {shown.map((s) => (
        <div key={s.def.id}>
          <p id={`qf-${s.def.id}-l`} className="text-sm font-medium text-slate-800">
            <label htmlFor={`qf-${s.def.id}`}>{s.def.label}</label>
            {s.required && <span className="ml-1 text-red-500" aria-label="obligatoire">*</span>}
            {s.def.blocking && <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">bloquant</span>}
          </p>
          {s.def.help && <p className="mb-1 text-xs text-slate-500">{s.def.help}</p>}
          <FieldInput state={s} value={s.value} onChange={(v) => onChange(s.def.id, v)} disabled={disabled} />
          {s.error && <p role="alert" className="mt-1 text-xs text-red-600">{s.error}</p>}
        </div>
      ))}
    </div>
  );
}
