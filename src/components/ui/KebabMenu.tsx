import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Trait de séparation avant cet élément. */
  separator?: boolean;
}

/**
 * Menu « ⋮ ». Le panneau est positionné en `fixed` à partir du bouton : il n'est donc jamais coupé par
 * un tableau défilant (overflow) ni par une carte basse. Se ferme au clic extérieur, à Échap et au défilement.
 */
export function KebabMenu({ items, ariaLabel }: { items: readonly MenuItem[]; ariaLabel: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setPos(null);
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const width = 230;
    // Sous le bouton, aligné à droite ; remonte si le bas de l'écran est trop proche.
    const height = items.length * 38 + 12;
    const top = r.bottom + height > window.innerHeight ? Math.max(8, r.top - height) : r.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
  };

  return (
    <>
      <button ref={button} type="button" onClick={toggle} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div ref={panel} role="menu" style={{ top: pos.top, left: pos.left, width: 230 }} className="fixed z-50 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {items.map((it) => (
            <div key={it.label}>
              {it.separator && <hr className="my-1 border-slate-100" />}
              <button
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setPos(null);
                  it.onSelect();
                }}
                className={cn('block w-full px-4 py-2 text-left hover:bg-slate-50 disabled:opacity-50', it.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-800')}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
