import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { LEAD_STATUSES, type Role } from '../../domain/enums';
import { ASSIGNMENT_STATE_LABELS, LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from '../../domain/labels';
import {
  buildLeadRows,
  filterLeadRows,
  formatAgo,
  formatCounter,
  formatPhoneDisplay,
  NO_LEAD_FILTERS,
  quickTabCounts,
  slaAgeMs,
  slaLevel,
  sortLeadRows,
  type LeadFilters,
  type LeadRow,
  type QuickTab,
} from '../../domain/leads/leadList';
import { LEAD_LIST_LIMIT, useLeadsList, useNow, type LeadsListData } from './useLeadsData';

const PAGE_SIZES = [10, 25, 50];
const selectClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

const TABS: { key: QuickTab; label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'new', label: 'Nouveaux' },
  { key: 'buffer', label: 'File tampon' },
  { key: 'interested', label: 'Intéressés' },
  { key: 'documents', label: 'Documents' },
  { key: 'closed', label: 'Clôturés' },
];

const TEMP_STYLE = { hot: 'bg-violet-50 text-violet-700', warm: 'bg-amber-50 text-amber-700', to_work: 'bg-slate-100 text-slate-600' } as const;

/** Compteur SLA vivant : couleur progressive (§5.1) accompagnée d'un libellé, jamais de la couleur seule (§12.11). */
export function SlaBadge({ ageMs }: { ageMs: number }) {
  const level = slaLevel(ageMs);
  const tone = { ok: 'bg-emerald-50 text-emerald-700', warning: 'bg-amber-50 text-amber-700', breached: 'bg-red-50 text-red-700' }[level];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums', tone)} title="Âge du lead : le compteur ne s'arrête qu'à un changement de statut">
      {formatCounter(ageMs)}
      {level === 'breached' && <span className="font-medium">· SLA dépassé</span>}
    </span>
  );
}

export function LeadsListPage({ basePath }: { basePath: string }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const wanted = params.get('onglet');
  const initialTab = TABS.find((t) => t.key === wanted)?.key;
  // RequireAuth garantit un utilisateur ; la liste est cadrée par son rôle (règles Firestore).
  const role: Role = user?.role ?? 'telepro';
  return <LeadsListView data={useLeadsList(role, user?.uid ?? '')} role={role} basePath={basePath} initialTab={initialTab} />;
}

export function LeadsListView({ data, role, basePath, nowOverride, initialTab }: { data: LeadsListData; role: Role; basePath: string; nowOverride?: number; initialTab?: QuickTab }) {
  const navigate = useNavigate();
  const liveNow = useNow(1000);
  const now = nowOverride ?? liveNow;
  const [filters, setFilters] = useState<LeadFilters>(initialTab ? { ...NO_LEAD_FILTERS, tab: initialTab } : NO_LEAD_FILTERS);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const isTelepro = role === 'telepro';

  const allRows = useMemo(() => buildLeadRows(data.items, data.names), [data.items, data.names]);
  const counts = useMemo(() => quickTabCounts(data.items), [data.items]);
  const filtered = useMemo(() => filterLeadRows(allRows, filters), [allRows, filters]);
  const rows = useMemo(() => sortLeadRows(filtered, now), [filtered, now]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);

  const setFilter = <K extends keyof LeadFilters>(k: K, v: LeadFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtersActive = JSON.stringify({ ...filters, tab: 'all' }) !== JSON.stringify(NO_LEAD_FILTERS);

  const campaignIds = [...new Set(data.items.map((i) => i.campaignId).filter((c): c is string => !!c))];
  const ownerIds = [...new Set(data.items.map((i) => i.ownerId).filter((c): c is string => !!c))];

  const open = (r: LeadRow) => navigate(`${basePath}/${r.id}`);

  const statusCell = (r: LeadRow) => {
    const age = slaAgeMs(r, now);
    if (age !== null) return <SlaBadge ageMs={age} />;
    return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{LEAD_STATUS_LABELS[r.status]}</span>;
  };

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold text-slate-900">{isTelepro ? 'Mes leads' : 'Leads'}</h1>
      <p className="mt-1 text-slate-500">{isTelepro ? 'Les leads dont vous êtes propriétaire.' : 'Tous les leads de votre périmètre.'}</p>

      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}
      {data.truncated && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4" /> Plus de {LEAD_LIST_LIMIT} leads : la liste est incomplète. Utilisez la recherche et les filtres.
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Filtres rapides">
        {TABS.filter((t) => !(isTelepro && t.key === 'buffer')).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={filters.tab === t.key}
            type="button"
            onClick={() => setFilter('tab', t.key)}
            className={cn('rounded-full border px-4 py-1.5 text-sm font-medium transition', filters.tab === t.key ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}
          >
            {t.label} <span className={cn('ml-1 tabular-nums', filters.tab === t.key ? 'text-blue-100' : 'text-slate-400')}>{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input type="search" value={filters.search} onChange={(e) => setFilter('search', e.target.value)} placeholder="Nom, téléphone, email, ville" aria-label="Rechercher un lead" className="w-64 rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <select aria-label="Statut" className={selectClass} value={filters.status} onChange={(e) => setFilter('status', e.target.value as LeadFilters['status'])}>
            <option value="all">Tous les statuts</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {!isTelepro && (
            <select aria-label="Campagne" className={selectClass} value={filters.campaignId} onChange={(e) => setFilter('campaignId', e.target.value)}>
              <option value="all">Toutes les campagnes</option>
              {campaignIds.map((c) => (
                <option key={c} value={c}>{data.names.campaigns.get(c) ?? c}</option>
              ))}
            </select>
          )}
          {!isTelepro && (
            <select aria-label="Propriétaire" className={selectClass} value={filters.ownerId} onChange={(e) => setFilter('ownerId', e.target.value)}>
              <option value="all">Tous les propriétaires</option>
              <option value="none">Sans propriétaire</option>
              {ownerIds.map((o) => (
                <option key={o} value={o}>{data.names.users.get(o) ?? o}</option>
              ))}
            </select>
          )}
          <select aria-label="Température" className={selectClass} value={filters.temperature} onChange={(e) => setFilter('temperature', e.target.value as LeadFilters['temperature'])}>
            <option value="all">Toutes les températures</option>
            {(Object.keys(TEMPERATURE_LABELS) as (keyof typeof TEMPERATURE_LABELS)[]).map((t) => (
              <option key={t} value={t}>{TEMPERATURE_LABELS[t]}</option>
            ))}
          </select>
          {filtersActive && (
            <button type="button" onClick={() => { setFilters((f) => ({ ...NO_LEAD_FILTERS, tab: f.tab })); setPage(1); }} className="text-sm text-blue-600 underline">Réinitialiser</button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-[13px]">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {['Lead', 'Campagne', 'Produit', ...(isTelepro ? [] : ['Propriétaire']), 'Statut', 'Température', 'Reçu', 'Prochaine action'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.loading && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">Chargement…</td></tr>}
              {!data.loading && pageRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    {data.items.length === 0 ? (isTelepro ? "Aucun lead ne vous est attribué pour le moment." : 'Aucun lead dans votre périmètre.') : 'Aucun lead pour ces filtres.'}
                  </td>
                </tr>
              )}
              {pageRows.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => open(r)}
                  onKeyDown={(e) => e.key === 'Enter' && open(r)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-blue-50/60 focus:outline-none"
                >
                  <td className="px-3 py-3">
                    <p className="font-medium text-slate-900">{r.fullName || 'Sans nom'}</p>
                    <p className="text-xs text-slate-500">{formatPhoneDisplay(r.phone)}{r.city ? ` · ${r.city}` : ''}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-700">{r.campaignName}</td>
                  <td className="px-3 py-3 text-slate-700">{r.productCode ?? <span className="text-slate-400">—</span>}</td>
                  {!isTelepro && (
                    <td className="px-3 py-3 text-slate-700">
                      {r.ownerId ? r.ownerName : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{r.assignmentState === 'to_assign' ? 'À examiner' : ASSIGNMENT_STATE_LABELS[r.assignmentState]}</span>}
                    </td>
                  )}
                  <td className="px-3 py-3">{statusCell(r)}</td>
                  <td className="px-3 py-3">
                    {r.temperature ? <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', TEMP_STYLE[r.temperature])}>{TEMPERATURE_LABELS[r.temperature]}</span> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-600">{formatAgo(r.receivedAtMs, now)}</td>
                  <td className="px-3 py-3 text-slate-600">
                    {r.nextAction ? (
                      <span className={r.nextAction.dueAtMs < now ? 'font-medium text-red-600' : ''}>
                        {r.nextAction.dueAtMs < now ? 'En retard · ' : ''}
                        {new Date(r.nextAction.dueAtMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
          <span>{rows.length === 0 ? 'Aucun lead' : `Affichage de ${(current - 1) * pageSize + 1} à ${Math.min(current * pageSize, rows.length)} sur ${rows.length} lead${rows.length > 1 ? 's' : ''}`}</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              Lignes par page
              <select className={selectClass} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">Précédent</button>
            <span>{current} / {pageCount}</span>
            <button type="button" disabled={current >= pageCount} onClick={() => setPage(current + 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">Suivant</button>
          </div>
        </div>
      </section>
    </div>
  );
}
