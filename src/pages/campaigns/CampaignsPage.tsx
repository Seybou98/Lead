import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpDown,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Euro,
  Download,
  FileCheck2,
  Megaphone,
  Plus,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  TrendingUp,
  Users,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { KebabMenu } from '../../components/ui/KebabMenu';
import { SourceLogo } from '../../components/ui/SourceLogo';
import {
  computeCampaignStats,
  computeTotals,
  filterCampaigns,
  formatEuros,
  formatPercent,
  NO_CAMPAIGN_FILTERS,
  sortCampaignRows,
  type CampaignFilters,
  type CampaignSortKey,
  type CampaignStats,
  type SortDir,
} from '../../domain/admin/campaignStats';
import { PERIOD_LABELS, periodLabel, periodRange, type PeriodKey } from '../../domain/admin/period';
import { toCsv, downloadText } from '../../domain/csv';
import { errorMessage, saveCampaign, type CampaignInput } from '../../lib/adminApi';
import { LEAD_READ_LIMIT, useCampaignsData, type CampaignsData, type CampaignRecord } from './useCampaignsData';
import { campaignToInput } from './campaignInput';
import { SpendModal } from './SpendModal';

const STATUS_STYLE: Record<CampaignInput['status'], { label: string; cls: string }> = {
  draft: { label: 'Brouillon', cls: 'bg-slate-100 text-slate-600' },
  active: { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' },
  suspended: { label: 'Suspendue', cls: 'bg-amber-100 text-amber-700' },
  ended: { label: 'Terminée', cls: 'bg-slate-100 text-slate-500' },
};

const PAGE_SIZES = [10, 25, 50];

const selectClass = 'h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

/** Colonnes du tableau ; « Campagne » et « Actions » sont toujours affichées. */
const COLUMNS: { key: CampaignSortKey; label: string; hideable: boolean }[] = [
  { key: 'name', label: 'Campagne', hideable: false },
  { key: 'source', label: 'Source', hideable: true },
  { key: 'product', label: 'Produit', hideable: true },
  { key: 'zone', label: 'Zone', hideable: true },
  { key: 'budget', label: 'Budget', hideable: true },
  { key: 'leads', label: 'Leads', hideable: true },
  { key: 'cpl', label: 'CPL', hideable: true },
  { key: 'docs', label: 'Docs complets', hideable: true },
  { key: 'sales', label: 'Ventes', hideable: true },
  { key: 'installed', label: 'Installées', hideable: true },
  { key: 'invoiced', label: 'Facturées', hideable: true },
  { key: 'status', label: 'Statut', hideable: true },
];

/** Carte de synthèse : icône dans un carré arrondi teinté, libellé, valeur (fig. 15). */
function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className={cn('flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl', tone)}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-slate-600">{label}</p>
        <p className="text-2xl font-semibold leading-tight text-slate-900">{value}</p>
        {sub && <p className="text-[11px] leading-tight text-slate-500">{sub}</p>}
      </div>
    </div>
  );
}

/** Entonnoir en trapèzes (fig. 15). Les largeurs sont décoratives : ce sont les chiffres qui informent. */
function Funnel({ stats }: { stats: CampaignStats }) {
  const f = stats.funnel;
  // Retrait (en %) du haut et du bas de chaque trapèze : chaque bas rejoint le haut du suivant.
  const insets = [0, 9, 19, 29, 38];
  const steps = [
    { label: 'Leads', value: f.leads, cls: 'bg-blue-100 text-blue-950' },
    { label: 'Contactés', value: f.contacted, cls: 'bg-emerald-100 text-emerald-950' },
    { label: 'Documents', value: f.documents, cls: 'bg-amber-100 text-amber-950' },
    { label: 'Ventes', value: f.sales, cls: 'bg-rose-100 text-rose-950' },
  ];
  return (
    <div>
      {steps.map((s, i) => {
        const top = insets[i];
        const bottom = insets[i + 1];
        return (
          <div key={s.label}>
            <div
              className={cn('flex h-[70px] flex-col items-center justify-center text-center', s.cls)}
              style={{ clipPath: `polygon(${top}% 0, ${100 - top}% 0, ${100 - bottom}% 100%, ${bottom}% 100%)` }}
              aria-label={`${s.label} : ${s.value}`}
            >
              <span className="text-xs">{s.label}</span>
              <span className="text-xl font-semibold leading-tight">{s.value}</span>
            </div>
            {i < steps.length - 1 && <p className="py-0.5 text-center text-sm leading-none text-slate-700" aria-hidden="true">↓</p>}
          </div>
        );
      })}
    </div>
  );
}

function SortHeader({ col, sort, onSort }: { col: (typeof COLUMNS)[number]; sort: { key: CampaignSortKey; dir: SortDir }; onSort: (k: CampaignSortKey) => void }) {
  const active = sort.key === col.key;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="whitespace-nowrap px-3 py-3 font-semibold">
      <button type="button" onClick={() => onSort(col.key)} className="inline-flex items-center gap-1 hover:text-slate-900">
        {col.label}
        <ArrowUpDown className={cn('h-3 w-3', active ? 'text-blue-600' : 'text-slate-400')} aria-hidden="true" />
      </button>
    </th>
  );
}

/** Pagination « « ‹ 1 2 3 › » » : au plus 5 numéros autour de la page courante. */
function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const nums = Array.from({ length: Math.min(5, pageCount) }, (_, i) => start + i);
  const btn = 'flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40';
  return (
    <nav aria-label="Pagination" className="flex items-center gap-1.5">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)} aria-label="Première page"><ChevronsLeft className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Page précédente"><ChevronLeft className="h-4 w-4" /></button>
      {nums.map((n) => (
        <button key={n} type="button" onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} className={cn('flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-sm', n === page ? 'border-blue-600 bg-blue-600 font-semibold text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>
          {n}
        </button>
      ))}
      <button type="button" className={btn} disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Page suivante"><ChevronRight className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={page >= pageCount} onClick={() => onPage(pageCount)} aria-label="Dernière page"><ChevronsRight className="h-4 w-4" /></button>
    </nav>
  );
}

type Notice = { kind: 'ok' | 'error'; text: string; warnings?: string[] };

export function CampaignsPage() {
  // La période est choisie ici : elle borne la lecture des leads (voir useCampaignsData).
  const [period, setPeriod] = useState<PeriodKey>('this_month');
  const nowMs = useMemo(() => Date.now(), []);
  const range = useMemo(() => periodRange(period, nowMs), [period, nowMs]);
  const data = useCampaignsData(range.fromMs);

  // Message laissé par la page de création après un enregistrement réussi.
  const location = useLocation();
  const incoming = (location.state as { notice?: { text: string; warnings?: string[] } } | null)?.notice;
  const initialNotice: Notice | null = incoming ? { kind: 'ok', text: incoming.text, warnings: incoming.warnings } : null;

  return <CampaignsView data={data} period={period} onPeriodChange={setPeriod} nowMs={nowMs} initialNotice={initialNotice} />;
}

export function CampaignsView({
  data,
  period,
  onPeriodChange,
  nowMs,
  initialNotice = null,
}: {
  data: CampaignsData;
  period: PeriodKey;
  onPeriodChange: (p: PeriodKey) => void;
  nowMs: number;
  initialNotice?: Notice | null;
}) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<CampaignFilters>(NO_CAMPAIGN_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [spendFor, setSpendFor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: CampaignSortKey; dir: SortDir }>({ key: 'name', dir: 'asc' });
  const [hidden, setHidden] = useState<ReadonlySet<CampaignSortKey>>(new Set());
  const [colsOpen, setColsOpen] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const colsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => !colsRef.current?.contains(e.target as Node) && setColsOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const range = useMemo(() => periodRange(period, nowMs), [period, nowMs]);
  const sourceKind = (id: string) => data.sources.find((s) => s.id === id)?.kind ?? 'manual';
  const sourceName = (id: string) => data.sources.find((s) => s.id === id)?.name ?? '—';

  const visible = useMemo(() => filterCampaigns(data.campaigns, filters), [data.campaigns, filters]);
  const stats = useMemo(() => computeCampaignStats(visible, data.leads, data.spend, range), [visible, data.leads, data.spend, range]);
  const totals = useMemo(() => computeTotals(stats), [stats]);
  const rows = useMemo(() => sortCampaignRows(stats, sort.key, sort.dir, sourceName), [stats, sort, data.sources]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);
  const selected = rows.find((r) => r.campaign.id === selectedId) ?? rows[0] ?? null;

  const products = [...new Set(data.campaigns.map((c) => c.productCode).filter((p): p is string => !!p))].sort();
  const zones = [...new Set(data.campaigns.flatMap((c) => c.zones))].sort();
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(NO_CAMPAIGN_FILTERS);
  const setFilter = <K extends keyof CampaignFilters>(k: K, v: CampaignFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const show = (k: CampaignSortKey) => !hidden.has(k);
  const onSort = (key: CampaignSortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const changeStatus = async (c: CampaignRecord, status: CampaignInput['status']) => {
    setBusyId(c.id);
    setNotice(null);
    try {
      const res = await saveCampaign(campaignToInput(c, { status, reason: `Passage au statut « ${STATUS_STYLE[status].label} » depuis la liste` }));
      setNotice({ kind: 'ok', text: `Campagne « ${c.name} » : ${STATUS_STYLE[status].label.toLowerCase()}.`, warnings: res.warnings });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = () =>
    downloadText(
      `campagnes-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['Campagne', 'Source', 'Produit', 'Zones', 'Budget (€)', 'Leads valides', 'Doublons', 'Faux leads', 'Dépenses (€)', 'CPL (€)', 'Dossiers complets', 'Ventes nettes', 'Ventes annulées', 'Ventes sécurisées', 'Installées', 'Facturées', 'Coût par vente (€)', 'Statut'],
        rows.map((r) => [
          r.campaign.name,
          sourceName(r.campaign.sourceId),
          r.campaign.productCode ?? '',
          r.campaign.zones.join(' + '),
          r.campaign.budgetCents === null ? '' : r.campaign.budgetCents / 100,
          r.leads,
          r.duplicates,
          r.fakeLeads,
          r.spendCents === null ? '' : r.spendCents / 100,
          r.cplCents === null ? '' : r.cplCents / 100,
          r.docsComplete,
          r.sales,
          r.cancelled,
          r.secured,
          r.installed,
          r.invoiced,
          r.costPerSaleCents === null ? '' : r.costPerSaleCents / 100,
          STATUS_STYLE[r.campaign.status].label,
        ])
      )
    );

  const menuFor = (c: CampaignRecord) => [
    { label: 'Modifier la configuration', onSelect: () => navigate(`/campagnes/${c.id}`) },
    { label: 'Dépenses', onSelect: () => setSpendFor(c.id) },
    { label: "Règles d'attribution", onSelect: () => navigate(`/parametres/attribution?campagne=${c.id}`) },
    { label: 'Journal de distribution', onSelect: () => navigate(`/journal?campagne=${c.id}`) },
    ...(c.status !== 'active' && c.status !== 'ended' ? [{ label: 'Activer', onSelect: () => void changeStatus(c, 'active'), disabled: busyId === c.id, separator: true }] : []),
    ...(c.status === 'active' ? [{ label: 'Suspendre', onSelect: () => void changeStatus(c, 'suspended'), disabled: busyId === c.id, separator: true }] : []),
    ...(c.status !== 'ended' ? [{ label: 'Terminer', onSelect: () => void changeStatus(c, 'ended'), danger: true, disabled: busyId === c.id }] : []),
  ];

  const colCount = 2 + COLUMNS.filter((c) => show(c.key)).length;

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold text-slate-900">Campagnes &amp; performances</h1>

      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 font-medium">
                {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {notice.text}
              </p>
              {notice.warnings?.map((w) => (
                <p key={w} className="mt-1 text-amber-800">⚠ {w}</p>
              ))}
            </div>
            <button type="button" onClick={() => setNotice(null)} className="text-xs underline">Fermer</button>
          </div>
        </div>
      )}
      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}
      {data.leadsTruncated && (
        <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Plus de {LEAD_READ_LIMIT} leads sur cette période : les chiffres sont partiels. Choisissez une période plus courte.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <select aria-label="Période" className={cn(selectClass, 'pl-9')} value={period} onChange={(e) => { onPeriodChange(e.target.value as PeriodKey); setPage(1); }}>
            {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
              <option key={k} value={k}>{k === 'all' ? PERIOD_LABELS[k] : `Période : ${periodLabel(k, nowMs)}`}</option>
            ))}
          </select>
        </div>
        <select aria-label="Source" className={selectClass} value={filters.sourceId} onChange={(e) => setFilter('sourceId', e.target.value)}>
          <option value="all">Toutes les sources</option>
          {data.sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select aria-label="Produit" className={selectClass} value={filters.productCode} onChange={(e) => setFilter('productCode', e.target.value)}>
          <option value="all">Tous les produits</option>
          {products.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select aria-label="Zone" className={selectClass} value={filters.zone} onChange={(e) => setFilter('zone', e.target.value)}>
          <option value="all">Toutes les zones</option>
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        {/* Le cahier des charges (§19.1) demande aussi le filtre par statut, absent de la maquette. */}
        <select aria-label="Statut" className={selectClass} value={filters.status} onChange={(e) => setFilter('status', e.target.value as CampaignFilters['status'])}>
          <option value="all">Tous les statuts</option>
          {(Object.keys(STATUS_STYLE) as CampaignInput['status'][]).map((s) => (
            <option key={s} value={s}>{STATUS_STYLE[s].label}</option>
          ))}
        </select>
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <input type="search" value={filters.search} onChange={(e) => setFilter('search', e.target.value)} placeholder="Rechercher une campagne" aria-label="Rechercher une campagne" className="h-10 w-full rounded-lg border border-slate-300 pl-3 pr-9 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        </div>
        {filtersActive && <button type="button" onClick={() => { setFilters(NO_CAMPAIGN_FILTERS); setPage(1); }} className="text-sm text-blue-600 underline">Réinitialiser</button>}
        <button type="button" onClick={() => navigate('/campagnes/nouvelle')} className="ml-auto inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> Créer une campagne
        </button>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
        <Kpi icon={<Euro className="h-6 w-6" />} label="Dépenses" value={formatEuros(totals.spendCents, 0)} tone="bg-blue-50 text-blue-600" />
        <Kpi
          icon={<Users className="h-6 w-6" />}
          label="Leads reçus"
          value={totals.leads.toLocaleString('fr-FR')}
          sub={totals.duplicates + totals.fakeLeads > 0 ? `+ ${totals.duplicates} doublon${totals.duplicates > 1 ? 's' : ''}, ${totals.fakeLeads} faux lead${totals.fakeLeads > 1 ? 's' : ''} (à part)` : undefined}
          tone="bg-emerald-50 text-emerald-600"
        />
        <Kpi icon={<TrendingUp className="h-6 w-6" />} label="Coût par lead" value={formatEuros(totals.cplCents)} tone="bg-violet-50 text-violet-600" />
        <Kpi icon={<FileCheck2 className="h-6 w-6" />} label="Dossiers complets" value={String(totals.docsComplete)} tone="bg-amber-50 text-amber-600" />
        <Kpi icon={<ShoppingCart className="h-6 w-6" />} label="Ventes" value={String(totals.sales)} sub={totals.cancelled > 0 ? `${totals.cancelled} annulée${totals.cancelled > 1 ? 's' : ''} (retirées)` : undefined} tone="bg-emerald-50 text-emerald-600" />
        <Kpi icon={<FileCheck2 className="h-6 w-6" />} label="Installées / facturées" value={`${totals.installed} / ${totals.invoiced}`} sub={totals.installRate === null ? undefined : `${formatPercent(totals.installRate)} des ventes installées`} tone="bg-sky-50 text-sky-600" />
        <Kpi icon={<Euro className="h-6 w-6" />} label="Coût par vente" value={formatEuros(totals.costPerSaleCents)} tone="bg-rose-50 text-rose-600" />
      </div>

      <div className="mt-5 grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="text-base font-semibold text-slate-900">Toutes les campagnes</h2>
            <div className="flex items-center gap-2">
              <button type="button" onClick={exportCsv} disabled={rows.length === 0} aria-label="Exporter en CSV" title="Exporter en CSV" className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                <Download className="h-4 w-4" />
              </button>
              <div ref={colsRef} className="relative">
                <button type="button" onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen} aria-label="Choisir les colonnes" title="Choisir les colonnes" className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                  <SlidersHorizontal className="h-4 w-4" />
                </button>
                {colsOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                    <p className="px-2 pb-1 text-xs font-semibold text-slate-500">Colonnes affichées</p>
                    {COLUMNS.filter((c) => c.hideable).map((c) => (
                      <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                        <input type="checkbox" checked={show(c.key)} onChange={(e) => setHidden((h) => { const n = new Set(h); if (e.target.checked) n.delete(c.key); else n.add(c.key); return n; })} />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="border-y border-slate-200 bg-slate-50/60 text-xs text-slate-700">
                <tr>
                  <th scope="col" className="w-10 px-3 py-3"><span className="sr-only">Sélection</span></th>
                  {COLUMNS.filter((c) => show(c.key)).map((c) => (
                    <SortHeader key={c.key} col={c} sort={sort} onSort={onSort} />
                  ))}
                  <th scope="col" className="px-3 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.loading && <tr><td colSpan={colCount} className="px-4 py-12 text-center text-slate-500">Chargement…</td></tr>}
                {!data.loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="px-4 py-12 text-center text-slate-500">
                      {data.campaigns.length === 0 ? (
                        <span className="inline-flex flex-col items-center gap-2"><Megaphone className="h-6 w-6 text-slate-300" />Aucune campagne. Créez la première pour rattacher et distribuer vos leads.</span>
                      ) : 'Aucune campagne pour ces filtres.'}
                    </td>
                  </tr>
                )}
                {pageRows.map((r) => {
                  const c = r.campaign;
                  const st = STATUS_STYLE[c.status];
                  const isSel = selected?.campaign.id === c.id;
                  const rec = data.campaigns.find((x) => x.id === c.id)!;
                  return (
                    <tr key={c.id} onClick={() => setSelectedId(c.id)} className={cn('h-[60px] cursor-pointer hover:bg-slate-50', isSel && 'bg-blue-50/70')}>
                      <td className="px-3">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => setSelectedId(c.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Sélectionner la campagne ${c.name}`}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="px-3 font-medium text-blue-700">{c.name}</td>
                      {show('source') && (
                        <td className="whitespace-nowrap px-3 text-slate-800">
                          <span className="inline-flex items-center gap-2"><SourceLogo kind={sourceKind(c.sourceId)} className="h-4 w-5" />{sourceName(c.sourceId)}</span>
                        </td>
                      )}
                      {show('product') && <td className="px-3 text-slate-700">{c.productCode ?? <span className="text-slate-400">—</span>}</td>}
                      {show('zone') && <td className="px-3 text-slate-700">{c.zones.length ? c.zones.join(' + ') : <span className="text-slate-400">—</span>}</td>}
                      {show('budget') && <td className="whitespace-nowrap px-3 text-slate-700">{formatEuros(c.budgetCents, 0)}</td>}
                      {show('leads') && (
                        <td className="whitespace-nowrap px-3 text-slate-800">
                          {r.leads}
                          {r.duplicates + r.fakeLeads > 0 && <span className="ml-1 text-xs text-slate-400" title="Doublons et faux leads, comptés à part">(+{r.duplicates + r.fakeLeads})</span>}
                        </td>
                      )}
                      {show('cpl') && <td className="whitespace-nowrap px-3 text-slate-700">{formatEuros(r.cplCents)}</td>}
                      {show('docs') && <td className="px-3 text-slate-800">{r.docsComplete}</td>}
                      {show('sales') && <td className="px-3 text-slate-800">{r.sales}{r.cancelled > 0 && <span className="ml-1 text-xs text-red-500" title="Ventes annulées, retirées du total">(−{r.cancelled})</span>}</td>}
                      {show('installed') && <td className="px-3 text-slate-800">{r.installed}</td>}
                      {show('invoiced') && <td className="px-3 text-slate-800">{r.invoiced}</td>}
                      {show('status') && (
                        <td className="px-3"><span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', st.cls)}>{st.label}</span></td>
                      )}
                      <td className="px-3" onClick={(e) => e.stopPropagation()}>
                        <KebabMenu ariaLabel={`Actions pour ${c.name}`} items={menuFor(rec)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-xs text-slate-600">
            <span>
              {rows.length === 0 ? 'Aucune campagne' : `Affichage de ${(current - 1) * pageSize + 1} à ${Math.min(current * pageSize, rows.length)} sur ${rows.length} campagne${rows.length > 1 ? 's' : ''}`}
            </span>
            <div className="flex items-center gap-3">
              <select aria-label="Lignes par page" className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>{n} par page</option>
                ))}
              </select>
              <Pager page={current} pageCount={pageCount} onPage={setPage} />
            </div>
          </div>
        </section>

        <aside className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Performance de la campagne sélectionnée</h2>
          {selected ? (
            <>
              <p className="mt-0.5 text-xs text-blue-700">{selected.campaign.name}</p>
              <div className="mt-3">
                <Funnel stats={selected} />
              </div>
              <p className="mt-4 flex items-center justify-between text-xs text-slate-700">
                <span>Taux de conversion global</span>
                <span className="text-sm font-semibold text-emerald-600">{formatPercent(selected.conversionRate)}</span>
              </p>
              <p className="mt-3 text-[11px] leading-snug text-slate-400">« Contactés » = leads dont un échange a eu lieu (un « pas de réponse » n'en est pas un). Doublons et faux leads ne sont pas comptés.</p>
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-500">Sélectionnez une campagne pour voir son entonnoir.</p>
          )}
        </aside>
      </div>

      {spendFor && (
        <SpendModal
          key={spendFor}
          campaignId={spendFor}
          campaignName={data.campaigns.find((c) => c.id === spendFor)?.name ?? ''}
          entries={data.spend}
          onClose={() => setSpendFor(null)}
          onSaved={(text) => setNotice({ kind: 'ok', text })}
        />
      )}
    </div>
  );
}
