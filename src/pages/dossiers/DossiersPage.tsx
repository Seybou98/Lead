import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { LEAD_STATUS_LABELS } from '../../domain/labels';
import { DOSSIER_TABS, dossierStage, dossierTabCounts, filterDossiers, type DossierTab } from '../../domain/dossiers/board';
import { formatEuros } from '../../domain/conversion/finance';
import { buildLeadRows, formatPhoneDisplay } from '../../domain/leads/leadList';
import { LEAD_LIST_LIMIT, useLeadsList } from '../leads/useLeadsData';

export const TONE_CLASS = {
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  green: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
} as const;

/** Section « Dossiers » : tous les leads arrivés au montage, de la pièce complète à la transmission (§12.2). */
export function DossiersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const data = useLeadsList(user?.role ?? 'telepro', user?.uid ?? '');
  const [tab, setTab] = useState<DossierTab>('all');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => buildLeadRows(data.items, data.names), [data.items, data.names]);
  const counts = useMemo(() => dossierTabCounts(rows), [rows]);
  const shown = useMemo(() => filterDossiers(rows, tab, search), [rows, tab, search]);
  const showOwner = user?.role !== 'telepro';

  return (
    <div className="w-full">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Dossiers</h1>
        <p className="mt-1 text-sm text-slate-600">Montage, validation du manager, vente et transmission au CRM principal.</p>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200">
        <div role="tablist" aria-label="Étapes des dossiers" className="flex flex-wrap gap-x-5">
          {DOSSIER_TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)} className={cn('-mb-px border-b-2 px-1 pb-3 text-sm font-semibold', tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent font-medium text-slate-600 hover:text-slate-900')}>
              {t.label} <span className={cn('ml-1 rounded-full px-2 py-0.5 text-xs', tab === t.key ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500')}>{counts[t.key]}</span>
            </button>
          ))}
        </div>
        <label className="relative mb-2 block">
          <span className="sr-only">Rechercher un dossier</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un dossier, un client…" className="w-72 rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </label>
      </div>

      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
      {data.truncated && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Seuls les {LEAD_LIST_LIMIT} leads les plus récents sont lus : la liste peut être incomplète.</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Produit / campagne</th>
              <th className="px-4 py-3">Statut</th>
              {showOwner && <th className="px-4 py-3">Propriétaire</th>}
              <th className="px-4 py-3 text-right">Prix TTC</th>
              <th className="px-4 py-3 text-right">Reste à charge</th>
              <th className="px-4 py-3">Contrôles</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.loading && <tr><td colSpan={showOwner ? 7 : 6} className="px-4 py-8 text-center text-slate-500">Chargement…</td></tr>}
            {!data.loading && shown.length === 0 && (
              <tr><td colSpan={showOwner ? 7 : 6} className="px-4 py-10 text-center text-slate-500">{search ? 'Aucun dossier ne correspond à la recherche.' : 'Aucun dossier pour le moment. Un lead devient dossier quand toutes ses pièces obligatoires sont conformes.'}</td></tr>
            )}
            {shown.map((r) => {
              const stage = dossierStage(r.status);
              const m = r.montage;
              return (
                <tr key={r.id} tabIndex={0} onClick={() => navigate(`/dossiers/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/dossiers/${r.id}`)} className="cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{r.fullName || 'Contact sans nom'}</p>
                    <p className="text-xs text-slate-500">{formatPhoneDisplay(r.phone)}{r.city ? ` · ${r.city}` : ''}</p>
                  </td>
                  <td className="px-4 py-3"><p className="text-slate-800">{r.productCode ?? '—'}</p><p className="text-xs text-slate-500">{r.campaignName}</p></td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-block rounded-full px-2.5 py-1 text-xs font-semibold', TONE_CLASS[stage.tone])}>{LEAD_STATUS_LABELS[r.status]}</span>
                    {r.conversion?.clientId && <p className="mt-1 text-xs text-slate-500">Dossier n° {r.conversion.clientId}</p>}
                  </td>
                  {showOwner && <td className="px-4 py-3 text-slate-700">{r.ownerName}</td>}
                  <td className="px-4 py-3 text-right tabular-nums">{m ? formatEuros(m.totalTtcCents) : '—'}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{m ? formatEuros(m.remainderCents) : '—'}</td>
                  <td className="px-4 py-3 text-xs">
                    {m && m.blocking > 0 && <span className="font-medium text-red-600">{m.blocking} bloquant{m.blocking > 1 ? 's' : ''}</span>}
                    {m && m.blocking === 0 && m.toConfirm > 0 && <span className="font-medium text-amber-600">{m.toConfirm} exception{m.toConfirm > 1 ? 's' : ''}</span>}
                    {m && m.blocking === 0 && m.toConfirm === 0 && <span className="font-medium text-emerald-600">Complet</span>}
                    {!m && <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
