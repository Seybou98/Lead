import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ChipOption {
  /** Identifiant unique, préfixé par le type (« team:abc », « user:xyz ») pour mélanger plusieurs listes. */
  id: string;
  label: string;
  /** Texte discret à droite (ex. « 3 membres »). */
  hint?: string;
  /** Option non sélectionnable, avec la raison affichée. */
  disabledReason?: string;
}

/**
 * Sélecteur multiple à pastilles (fig. 16) : les choix faits s'affichent comme des pastilles
 * retirables ; une liste déroulante avec recherche permet d'en ajouter. Clavier : Entrée/Espace ouvre,
 * Échap ferme. Les identifiants déjà choisis mais disparus de la liste restent visibles (à retirer).
 */
export function ChipMultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Choisir…',
  ariaLabel,
}: {
  options: readonly ChipOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const q = search.trim().toLowerCase();
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div ref={root} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <div className="flex min-h-[42px] w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {selected.length === 0 && <span className="px-1 text-sm text-slate-400">{placeholder}</span>}
          {selected.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-sm text-slate-800">
              {byId.get(id)?.label ?? `${id} (introuvable)`}
              <button type="button" onClick={() => toggle(id)} aria-label={`Retirer ${byId.get(id)?.label ?? id}`} className="rounded text-slate-400 hover:text-slate-700">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox" aria-label={ariaLabel} className="rounded p-1 text-slate-500 hover:bg-slate-100">
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <input autoFocus type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…" aria-label="Rechercher dans la liste" className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-label={ariaLabel} className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 && <li className="px-4 py-3 text-sm text-slate-500">Aucun résultat.</li>}
            {shown.map((o) => {
              const on = selected.includes(o.id);
              return (
                <li key={o.id} role="option" aria-selected={on} aria-disabled={!!o.disabledReason}>
                  <button
                    type="button"
                    disabled={!!o.disabledReason && !on}
                    onClick={() => toggle(o.id)}
                    className={cn('flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50', on && 'bg-blue-50/60')}
                  >
                    <span className={cn('flex h-4 w-4 items-center justify-center rounded border', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300')}>
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <span className="flex-1 text-slate-800">{o.label}</span>
                    {(o.disabledReason || o.hint) && <span className="text-xs text-slate-400">{o.disabledReason ?? o.hint}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
