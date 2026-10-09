import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { LeadListItem } from '../../domain/leads/leadList';

export const fmtInt = (n: number | null) => (n === null ? '—' : n.toLocaleString('fr-FR'));
export const fmtPct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);

/**
 * Liste des leads qui composent un chiffre (§22.12 : « chaque nombre cliquable ouvre une liste dont le total
 * correspond exactement au KPI »). Lecture seule : chaque ligne ouvre la fiche du lead.
 */
export function PopulationDrawer({ title, definition, leads, onClose }: { title: string; definition: string; leads: readonly LeadListItem[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={`Leads : ${title}`} className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title} ({leads.length})</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <p className="border-b border-slate-100 px-5 py-2 text-xs text-slate-500">{definition}</p>
        <ul className="flex-1 space-y-1.5 overflow-y-auto px-5 py-3">
          {leads.length === 0 && <li className="text-sm text-slate-500">Aucun lead.</li>}
          {leads.slice(0, 300).map((l) => (
            <li key={l.id}>
              <Link to={`/leads/${l.id}`} className="block rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-900">{l.fullName || 'Contact sans nom'}</span>
                <span className="ml-2 text-xs text-slate-500">{[l.productCode, l.city].filter(Boolean).join(' · ')}</span>
              </Link>
            </li>
          ))}
          {leads.length > 300 && <li className="text-xs text-slate-400">+ {leads.length - 300} autres : affinez les filtres.</li>}
        </ul>
      </aside>
    </div>
  );
}
