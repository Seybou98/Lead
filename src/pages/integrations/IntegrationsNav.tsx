import { NavLink } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';

const TABS = [
  { to: '/integrations', label: 'Connecteurs', end: true },
  { to: '/integrations/journal', label: 'Journal', end: false },
  { to: '/integrations/erreurs', label: 'Erreurs & reprises', end: false },
  { to: '/integrations/transmission', label: 'Transmission au CRM principal', end: false },
  { to: '/integrations/sources', label: 'Sources de leads', end: false },
];

/** En-tête commun des écrans du hub d'intégrations (§24.10) : titre, onglets, actualisation. */
export function IntegrationsHeader({ title, subtitle, onRefresh, refreshing, updatedAt }: { title: string; subtitle: string; onRefresh?: () => void; refreshing?: boolean; updatedAt?: string | null }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          <p className="mt-1 text-slate-500">{subtitle}</p>
        </div>
        {onRefresh && (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {updatedAt && <span>Dernière mise à jour : {updatedAt}</span>}
            <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"><RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Actualiser</button>
          </div>
        )}
      </div>
      <nav aria-label="Intégrations" className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn('-mb-px border-b-2 px-3 pb-2.5 text-sm font-medium', isActive ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900')}>{t.label}</NavLink>
        ))}
      </nav>
    </>
  );
}
