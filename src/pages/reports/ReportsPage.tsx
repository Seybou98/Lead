import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download, Euro, FileCheck2, Info, Phone, ShoppingCart, Tag, Users, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { computeCampaignStats, computeTotals, formatEuros, formatPercent, type CampaignStats, type LeadStatView } from '../../domain/admin/campaignStats';
import { downloadText, toCsv } from '../../domain/csv';
import { ratePct } from '../../domain/sales/outcome';
import type { LeadListItem } from '../../domain/leads/leadList';
import { buildDirectionReport, DATE_MODE_LABELS, directionRows, stagePopulation, STAGE_DEFINITIONS, type DateMode, type Kpi, type ReportFilters, type Stage } from '../../domain/reports/direction';
import { PERIOD_LABELS, PERIODS, periodRange, type PeriodKey } from '../../domain/reports/periods';
import { inputCls } from '../settings/settingsUi';
import { useNow } from '../leads/useLeadsData';
import { useReportsData, type ReportsData } from './useReportsData';

type View = 'direction' | 'campaigns';

const toStat = (l: LeadListItem): LeadStatView => ({ campaignId: l.campaignId, status: l.status, receivedAtMs: l.receivedAtMs, documentsState: l.documentsState, duplicate: l.duplicate, excluded: l.excluded, commercialState: l.commercialState ?? null, financialState: l.financialState ?? null, mainStage: l.mainStatus?.stage ?? null });
const fmtInt = (n: number | null) => (n === null ? '—' : n.toLocaleString('fr-FR'));

export function ReportsPage() {
  const { user } = useAuth();
  const role = user?.role ?? 'manager';
  return <ReportsView data={useReportsData(role, user?.uid ?? '')} />;
}

export function ReportsView({ data, nowOverride, initialView = 'direction' }: { data: ReportsData; nowOverride?: number; initialView?: View }) {
  const liveNow = useNow(60_000);
  const now = nowOverride ?? liveNow;
  const [view, setView] = useState<View>(initialView);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [mode, setMode] = useState<DateMode>('event');
  const [sourceId, setSourceId] = useState('');
  const [product, setProduct] = useState('');
  const [owner, setOwner] = useState('');
  const [raw, setRaw] = useState(false);
  const range = useMemo(() => periodRange(period, now), [period, now]);
  const filters: ReportFilters = useMemo(() => ({ ...range, mode, sourceId, campaignId: '', product, owner }), [range, mode, sourceId, product, owner]);
  const products = useMemo(() => [...new Set(data.leads.map((l) => l.productCode).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, 'fr')), [data.leads]);
  const owners = useMemo(() => [...new Map(data.leads.filter((l) => l.ownerId).map((l) => [l.ownerId as string, data.names.users.get(l.ownerId as string) ?? (l.ownerId as string)])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr')), [data.leads, data.names]);
  const active = [sourceId && 'source', product && 'produit', owner && 'télépro'].filter(Boolean).length;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{view === 'direction' ? 'Rapport Direction' : 'Performance des campagnes'}</h1>
          <p className="mt-1 text-slate-500">{view === 'direction' ? 'Vue consolidée de l’acquisition à la vente.' : 'Rentabilité et qualité des campagnes sur la période.'}</p>
        </div>
        <div role="tablist" aria-label="Rapports" className="flex rounded-lg border border-slate-200 bg-white p-1 text-sm">
          {([['direction', 'Direction'], ['campaigns', 'Campagnes']] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k} type="button" onClick={() => setView(k)} className={cn('rounded-md px-4 py-1.5 font-medium', view === k ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{label}</button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Période" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className={inputCls}>{PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}</select>
        <select aria-label="Source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={inputCls}><option value="">Toutes les sources</option>{data.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select aria-label="Produit" value={product} onChange={(e) => setProduct(e.target.value)} className={inputCls}><option value="">Tous les produits</option>{products.map((p) => <option key={p}>{p}</option>)}</select>
        <select aria-label="Télépro" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}><option value="">Tous les télépros</option>{owners.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
        {view === 'direction' ? (
          <div role="radiogroup" aria-label="Mode de date" className="ml-auto flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(Object.keys(DATE_MODE_LABELS) as DateMode[]).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} type="button" onClick={() => setMode(m)} title={m === 'event' ? 'Chaque étape est comptée à sa date réelle.' : 'Toutes les étapes sont rattachées à la date de réception du lead.'} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', mode === m ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'text-slate-500 hover:text-slate-800')}>{DATE_MODE_LABELS[m]}</button>
            ))}
          </div>
        ) : (
          <div role="radiogroup" aria-label="Lecture des données" className="ml-auto flex rounded-lg border border-slate-200 bg-white p-0.5">
            {([[false, 'Données corrigées'], [true, 'Données brutes']] as const).map(([v, label]) => (
              <button key={label} role="radio" aria-checked={raw === v} type="button" onClick={() => setRaw(v)} title={v ? 'Tous les événements enregistrés, doublons et faux leads compris.' : 'Hors doublons, faux leads et leads exclus (§22.5).'} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', raw === v ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'text-slate-500 hover:text-slate-800')}>{label}</button>
            ))}
          </div>
        )}
        {active > 0 && <button type="button" onClick={() => { setSourceId(''); setProduct(''); setOwner(''); }} className="text-xs font-medium text-blue-700 hover:underline">Réinitialiser les filtres ({active})</button>}
      </div>

      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
      {data.truncated && <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Seuls les leads les plus récents sont chargés : les chiffres peuvent être incomplets.</p>}

      {view === 'direction' ? <DirectionView data={data} filters={filters} now={now} /> : <CampaignsView data={data} filters={filters} raw={raw} now={now} />}
    </div>
  );
}

// ── Direction (fig. 30) ──────────────────────────────────────────────────────

function Delta({ k, invert = false }: { k: Kpi; invert?: boolean }) {
  if (k.delta === null) return <span className="text-xs text-slate-400" title="Période précédente vide ou non calculable">—</span>;
  const up = k.delta > 0;
  const good = k.delta === 0 ? null : invert ? !up : up;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', good === null ? 'text-slate-500' : good ? 'text-emerald-600' : 'text-red-600')} title={`Période précédente : ${k.previous === null ? '—' : fmtInt(k.previous)}`}>
      {k.delta !== 0 && <Icon className="h-3 w-3" />}
      {Math.abs(k.delta).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} {k.deltaUnit === 'pts' ? 'pts' : '%'}
    </span>
  );
}

function KpiCard({ icon, tone, label, value, kpi, invert, hint }: { icon: React.ReactNode; tone: string; label: string; value: string; kpi: Kpi; invert?: boolean; hint: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4" title={hint}>
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-xl font-bold tabular-nums text-slate-900">{value}</p>
        <Delta k={kpi} invert={invert} />
      </div>
    </div>
  );
}

function DirectionView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const [open, setOpen] = useState<Stage | null>(null);
  const report = useMemo(() => buildDirectionReport({ leads: data.leads, spends: data.spends, campaigns: data.reportCampaigns, filters, nowMs: now }), [data.leads, data.spends, data.reportCampaigns, filters, now]);
  const k = report.kpis;
  const euro = (c: number | null) => formatEuros(c, 0);
  const maxSpend = Math.max(1, ...report.weeks.map((w) => w.spendCents));
  const maxSales = Math.max(1, ...report.weeks.map((w) => w.sales));
  const exportCsv = () => downloadText(`rapport-direction-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Rapport Direction'], directionRows(report, filters.mode)));
  const population = open ? stagePopulation(data.leads, data.reportCampaigns, filters, open) : [];

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard icon={<Euro className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" label="Dépenses" value={euro(k.spendCents.value)} kpi={k.spendCents} invert hint="Dépenses publicitaires saisies sur la période et le périmètre filtré. « — » : aucune dépense saisie, ou filtre télépro (une dépense ne se rattache pas à un télépro)." />
        <KpiCard icon={<Users className="h-5 w-5 text-indigo-600" />} tone="bg-indigo-50" label="Leads reçus" value={fmtInt(k.received.value)} kpi={k.received} hint={STAGE_DEFINITIONS.received} />
        <KpiCard icon={<Tag className="h-5 w-5 text-violet-600" />} tone="bg-violet-50" label="Coût par lead valide" value={formatEuros(k.costPerLeadCents.value)} kpi={k.costPerLeadCents} invert hint="Dépenses / leads valides (hors doublons, faux leads, exclus)." />
        <KpiCard icon={<Phone className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" label="Taux de contact" value={k.contactRate.value === null ? '—' : formatPercent(k.contactRate.value)} kpi={k.contactRate} hint={`Contactés / leads valides : ${report.current.counts.contacted} sur ${report.current.counts.valid}. ${STAGE_DEFINITIONS.contacted}`} />
        <KpiCard icon={<FileCheck2 className="h-5 w-5 text-amber-600" />} tone="bg-amber-50" label="Dossiers complets" value={fmtInt(k.docsComplete.value)} kpi={k.docsComplete} hint={STAGE_DEFINITIONS.docsComplete} />
        <KpiCard icon={<ShoppingCart className="h-5 w-5 text-rose-600" />} tone="bg-rose-50" label="Ventes" value={fmtInt(k.sales.value)} kpi={k.sales} hint={STAGE_DEFINITIONS.sales} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> {DATE_MODE_LABELS[filters.mode]} · période comparée : {new Date(report.previousRange.fromMs).toLocaleDateString('fr-FR')} au {new Date(report.previousRange.toMs - 1).toLocaleDateString('fr-FR')}</span>
        <span>Coût par vente : <strong className="text-slate-700">{formatEuros(k.costPerSaleCents.value)}</strong> <Delta k={k.costPerSaleCents} invert /></span>
        <span>Après la vente : {report.current.installed} installée{report.current.installed > 1 ? 's' : ''}, {report.current.invoiced} facturée{report.current.invoiced > 1 ? 's' : ''}, {report.current.cancelled} annulée{report.current.cancelled > 1 ? 's' : ''}</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>

      <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Entonnoir commercial</h2>
          <ol className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 xl:grid-cols-8">
            {report.funnel.map((s, i) => {
              const last = i === report.funnel.length - 1;
              return (
                <li key={s.stage} className={cn('bg-white', last && 'bg-blue-600 text-white')}>
                  <button type="button" onClick={() => setOpen(s.stage)} title={`${STAGE_DEFINITIONS[s.stage]} Cliquez pour voir les ${s.count} leads.`} className="flex h-full w-full flex-col items-start gap-0.5 px-3 py-3 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                    <span className={cn('text-[11px] leading-tight', last ? 'text-blue-100' : 'text-slate-500')}>{s.label}</span>
                    <span className="text-xl font-bold tabular-nums">{fmtInt(s.count)}</span>
                    {filters.mode === 'cohort' ? (
                      <span className={cn('text-[11px] tabular-nums', last ? 'text-blue-100' : 'text-slate-500')}>{s.rateOfReceived === null ? '—' : `${s.rateOfReceived.toLocaleString('fr-FR')} %`}{s.passage !== null && <span className="ml-1 opacity-70" title="Taux de passage depuis l’étape précédente">· {s.passage.toLocaleString('fr-FR')} %</span>}</span>
                    ) : (
                      <span className={cn('text-[11px]', last ? 'text-blue-100' : 'text-slate-400')}>à sa date</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-slate-400">{filters.mode === 'cohort' ? 'Volume, part des leads reçus, puis taux de passage depuis l’étape précédente.' : 'Chaque étape est comptée à sa date réelle : les taux de passage n’ont de sens qu’en cohorte d’acquisition, où toutes les étapes se rattachent à la réception.'} « Intéressés » se déduit du statut actuel (plancher).</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Points d’attention</h2>
          <ul className="mt-3 space-y-2">
            {report.alerts.map((a) => (
              <li key={a.id} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', a.level === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : a.level === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
                {a.level === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />}
                <span><span className="block font-medium">{a.title}</span><span className="block text-xs opacity-80">{a.detail}</span></span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Dépenses et ventes par semaine</h2>
          <div className="mt-3 flex gap-4 text-xs text-slate-500"><span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-blue-300" /> Dépenses (€)</span><span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-emerald-500" /> Ventes (n)</span></div>
          <WeeklyChart weeks={report.weeks} maxSpend={maxSpend} maxSales={maxSales} nowMs={now} />
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Projection mensuelle</h2>
          {report.projection ? (
            <div className="mt-3">
              <dl className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-lg border border-slate-200 p-3"><dt className="text-xs text-slate-500">Réalisé</dt><dd className="text-2xl font-bold text-slate-900">{report.projection.salesSoFar}</dd><dd className="text-xs text-slate-400">ventes en {report.projection.elapsedDays} j</dd></div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3"><dt className="text-xs text-blue-700">Projection</dt><dd className="text-2xl font-bold text-blue-700">{report.projection.projected}</dd><dd className="text-xs text-blue-600">ventes sur {report.projection.totalDays} j</dd></div>
              </dl>
              <p className="mt-3 text-xs text-slate-500">Estimation au rythme observé, recalculée à chaque mise à jour. Aucun objectif n’est encore défini : l’écart à l’objectif n’est pas calculé.</p>
            </div>
          ) : <p className="mt-3 text-sm text-slate-500">La projection n’a de sens que pour une période en cours.</p>}
        </section>
      </div>

      <p className="mt-4 text-xs text-slate-400">Dernière actualisation : {new Date(now).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · données en temps réel, lecture seule.</p>

      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <aside role="dialog" aria-modal="true" aria-label={`Leads : ${report.funnel.find((s) => s.stage === open)?.label}`} className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">{report.funnel.find((s) => s.stage === open)?.label} ({population.length})</h2>
              <button type="button" onClick={() => setOpen(null)} aria-label="Fermer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
            </div>
            <p className="border-b border-slate-100 px-5 py-2 text-xs text-slate-500">{STAGE_DEFINITIONS[open]}</p>
            <ul className="flex-1 space-y-1.5 overflow-y-auto px-5 py-3">
              {population.length === 0 && <li className="text-sm text-slate-500">Aucun lead.</li>}
              {population.slice(0, 300).map((l) => (
                <li key={l.id}><Link to={`/leads/${l.id}`} className="block rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"><span className="font-medium text-slate-900">{l.fullName || 'Contact sans nom'}</span><span className="block text-xs text-slate-500">{l.productCode ?? 'Produit non renseigné'} · {data.names.users.get(l.ownerId ?? '') ?? 'Non attribué'} · {new Date(l.receivedAtMs).toLocaleDateString('fr-FR')}</span></Link></li>
              ))}
              {population.length > 300 && <li className="text-xs text-slate-400">+ {population.length - 300} autres : affinez les filtres.</li>}
            </ul>
          </aside>
        </div>
      )}
    </>
  );
}

/** Barres de dépenses et courbe des ventes (SVG, sans bibliothèque). Échelle des ventes à droite, des dépenses à gauche. */
function WeeklyChart({ weeks, maxSpend, maxSales, nowMs }: { weeks: { startMs: number; label: string; spendCents: number; sales: number }[]; maxSpend: number; maxSales: number; nowMs: number }) {
  const W = 640;
  const H = 200;
  const pad = { l: 44, r: 28, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = Math.max(1, weeks.length);
  const step = iw / n;
  const y = (v: number, max: number) => pad.t + ih - (v / max) * ih;
  // Une semaine pas encore commencée n'a pas de ventes « à zéro » : elle n'a pas de point.
  const seen = weeks.map((w, i) => ({ w, i })).filter(({ w }) => w.startMs <= nowMs);
  const line = seen.map(({ w, i }, k) => `${k === 0 ? 'M' : 'L'}${pad.l + step * i + step / 2},${y(w.sales, maxSales)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Dépenses et ventes par semaine" className="mt-2 h-52 w-full">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - t)} y2={pad.t + ih * (1 - t)} className="stroke-slate-100" />
          <text x={pad.l - 6} y={pad.t + ih * (1 - t) + 3} textAnchor="end" className="fill-slate-400 text-[9px]">{Math.round((maxSpend * t) / 100).toLocaleString('fr-FR')} €</text>
          <text x={W - pad.r + 6} y={pad.t + ih * (1 - t) + 3} className="fill-slate-400 text-[9px]">{Math.round(maxSales * t)}</text>
        </g>
      ))}
      {weeks.map((w, i) => {
        const h = (w.spendCents / maxSpend) * ih;
        return (
          <g key={w.label + i}>
            <rect x={pad.l + step * i + step * 0.2} y={pad.t + ih - h} width={step * 0.6} height={h} rx={2} className="fill-blue-300"><title>{`Semaine du ${w.label} : ${(w.spendCents / 100).toLocaleString('fr-FR')} € · ${w.sales} vente${w.sales > 1 ? 's' : ''}`}</title></rect>
            <text x={pad.l + step * i + step / 2} y={H - 8} textAnchor="middle" className="fill-slate-400 text-[9px]">{w.label}</text>
          </g>
        );
      })}
      <path d={line} fill="none" strokeWidth={2} className="stroke-emerald-500" />
      {seen.map(({ w, i }) => <circle key={i} cx={pad.l + step * i + step / 2} cy={y(w.sales, maxSales)} r={3} className="fill-emerald-500" />)}
    </svg>
  );
}

// ── Campagnes (fig. 31) ──────────────────────────────────────────────────────

function CampaignsView({ data, filters, raw, now }: { data: ReportsData; filters: ReportFilters; raw: boolean; now: number }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const campaigns = useMemo(() => data.campaigns.filter((c) => (!filters.sourceId || c.sourceId === filters.sourceId) && (!filters.product || c.productCode === filters.product)), [data.campaigns, filters.sourceId, filters.product]);
  const leads = useMemo(() => data.leads.filter((l) => (!filters.owner || l.ownerId === filters.owner) && (!filters.product || l.productCode === filters.product)).map(toStat), [data.leads, filters.owner, filters.product]);
  const spends = useMemo(() => data.spends.map((s) => ({ campaignId: s.campaignId, amountCents: s.amountCents, atMs: s.atMs })), [data.spends]);
  const rows = useMemo(() => computeCampaignStats(campaigns, leads, spends, { fromMs: filters.fromMs, toMs: filters.toMs }, raw ? 'raw' : 'corrected'), [campaigns, leads, spends, filters.fromMs, filters.toMs, raw]);
  const totals = useMemo(() => computeTotals(rows), [rows]);
  const budget = campaigns.reduce((s, c) => s + (c.budgetCents ?? 0), 0);
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.spendCents ?? -1) - (a.spendCents ?? -1) || a.campaign.name.localeCompare(b.campaign.name, 'fr')), [rows]);
  const selected = sorted.find((r) => r.campaign.id === selectedId) ?? sorted[0] ?? null;
  const sourceName = (id: string) => data.sources.find((s) => s.id === id)?.name ?? id;
  const maxCps = Math.max(1, ...rows.map((r) => r.costPerSaleCents ?? 0));

  const exportCsv = () =>
    downloadText(
      `rapport-campagnes-${new Date(now).toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['Campagne', 'Lecture', 'Dépenses (€)', 'Leads bruts', 'Leads de la lecture', 'CPL (€)', 'Contactés', 'Taux de contact (%)', 'Dossiers complets', 'Ventes nettes', 'Ventes annulées', 'Installées', 'Facturées', 'Coût par vente (€)'],
        rows.map((r) => [r.campaign.name, raw ? 'Brutes' : 'Corrigées', r.spendCents === null ? '' : r.spendCents / 100, r.gross, r.leads, r.cplCents === null ? '' : r.cplCents / 100, r.contacted, r.contactRate ?? '', r.docsComplete, r.sales, r.cancelled, r.installed, r.invoiced, r.costPerSaleCents === null ? '' : r.costPerSaleCents / 100])
      )
    );

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <KpiPlain icon={<Tag className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" label="Budget prévu" value={budget > 0 ? formatEuros(budget, 0) : '—'} />
        <KpiPlain icon={<Euro className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" label="Dépenses" value={formatEuros(totals.spendCents, 0)} />
        <KpiPlain icon={<Users className="h-5 w-5 text-violet-600" />} tone="bg-violet-50" label={raw ? 'Leads reçus (bruts)' : 'Leads valides'} value={fmtInt(totals.leads)} sub={!raw && totals.duplicates + totals.fakeLeads > 0 ? `+ ${totals.duplicates + totals.fakeLeads} à part` : undefined} />
        <KpiPlain icon={<FileCheck2 className="h-5 w-5 text-amber-600" />} tone="bg-amber-50" label="Dossiers complets" value={fmtInt(totals.docsComplete)} />
        <KpiPlain icon={<ShoppingCart className="h-5 w-5 text-rose-600" />} tone="bg-rose-50" label="Ventes" value={fmtInt(totals.sales)} sub={totals.cancelled > 0 ? `${totals.cancelled} annulée${totals.cancelled > 1 ? 's' : ''}` : undefined} />
        <KpiPlain icon={<Euro className="h-5 w-5 text-orange-600" />} tone="bg-orange-50" label="Coût par vente" value={formatEuros(totals.costPerSaleCents)} />
      </div>
      <p className="mt-2 flex items-center gap-3 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> {raw ? 'Données brutes : tous les événements enregistrés.' : 'Données corrigées : hors doublons, faux leads et leads exclus.'} Les dépenses et les ventes comparées ont le même périmètre.</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>

      <div className="mt-4 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-medium text-slate-500">
                  <tr>{['Campagne', 'Dépenses', 'Leads bruts', raw ? 'Leads' : 'Leads valides', 'CPL', 'Contact', 'Docs complets', 'Ventes', 'Installées', 'Coût/vente'].map((h) => <th key={h} className="px-3 py-2.5">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">{data.loading ? 'Chargement…' : 'Aucune campagne pour ces filtres.'}</td></tr>}
                  {sorted.map((r) => (
                    <tr key={r.campaign.id} onClick={() => setSelectedId(r.campaign.id)} className={cn('cursor-pointer border-t border-slate-100 hover:bg-slate-50', selected?.campaign.id === r.campaign.id && 'bg-blue-50/60')}>
                      <td className="px-3 py-3 font-medium text-blue-700">{r.campaign.name}</td>
                      <td className="px-3 py-3 tabular-nums">{formatEuros(r.spendCents, 0)}</td>
                      <td className="px-3 py-3 tabular-nums">{r.gross}</td>
                      <td className="px-3 py-3 tabular-nums">{r.leads}</td>
                      <td className="px-3 py-3 tabular-nums">{formatEuros(r.cplCents)}</td>
                      <td className="px-3 py-3 tabular-nums" title={`${r.contacted} contactés sur ${r.leads}`}>{r.contactRate === null ? '—' : `${r.contactRate.toLocaleString('fr-FR')} %`}</td>
                      <td className="px-3 py-3 tabular-nums">{r.docsComplete}</td>
                      <td className="px-3 py-3 tabular-nums">{r.sales}{r.cancelled > 0 && <span className="ml-1 text-xs text-red-500" title="Ventes annulées, retirées">(−{r.cancelled})</span>}</td>
                      <td className="px-3 py-3 tabular-nums">{r.installed}</td>
                      <td className="px-3 py-3 font-medium tabular-nums">{formatEuros(r.costPerSaleCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Coût par vente par campagne</h2>
            {rows.every((r) => r.costPerSaleCents === null) ? <p className="mt-3 text-sm text-slate-500">Aucune campagne n’a à la fois des dépenses et des ventes sur la période.</p> : (
              <ul className="mt-3 space-y-2.5">
                {[...rows].filter((r) => r.costPerSaleCents !== null).sort((a, b) => (b.costPerSaleCents as number) - (a.costPerSaleCents as number)).map((r) => (
                  <li key={r.campaign.id} className="grid grid-cols-[150px_minmax(0,1fr)_90px] items-center gap-3 text-sm">
                    <span className="truncate text-slate-700" title={r.campaign.name}>{r.campaign.name}</span>
                    <span className="h-5 rounded bg-slate-100"><span className="block h-5 rounded bg-blue-600" style={{ width: `${((r.costPerSaleCents as number) / maxCps) * 100}%` }} /></span>
                    <span className="text-right font-medium tabular-nums">{formatEuros(r.costPerSaleCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {selected && <CampaignPanel r={selected} sourceName={sourceName(selected.campaign.sourceId)} raw={raw} filters={filters} />}
      </div>
    </>
  );
}

function KpiPlain({ icon, tone, label, value, sub }: { icon: React.ReactNode; tone: string; label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div className="min-w-0"><p className="text-xs text-slate-500">{label}</p><p className="text-xl font-bold tabular-nums text-slate-900">{value}</p>{sub && <p className="text-[11px] text-slate-400">{sub}</p>}</div>
    </div>
  );
}

function CampaignPanel({ r, sourceName, raw, filters }: { r: CampaignStats; sourceName: string; raw: boolean; filters: ReportFilters }) {
  const c = r.campaign;
  const budget = c.budgetCents;
  const pct = budget && r.spendCents !== null ? Math.min(100, Math.round((r.spendCents / budget) * 100)) : null;
  const passage = (a: number, b: number) => ratePct(a, b);
  return (
    <aside className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-sm">
      <h2 className="text-base font-semibold text-slate-900">{c.name}</h2>
      <dl className="space-y-1.5">
        {[['Source principale', sourceName], ['Produit', c.productCode ?? '—'], ['Zone', c.zones.length ? c.zones.join(', ') : '—'], ['Période', `${new Date(filters.fromMs).toLocaleDateString('fr-FR')} au ${new Date(filters.toMs - 1).toLocaleDateString('fr-FR')}`], ['Lecture', raw ? 'Données brutes' : 'Données corrigées']].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{v}</dd></div>
        ))}
      </dl>
      <div className="border-t border-slate-100 pt-3">
        <p className="font-medium text-slate-800">Budget et dépenses</p>
        <p className="mt-1 flex justify-between"><span className="text-slate-500">Dépenses</span><span className="font-medium">{formatEuros(r.spendCents, 0)}</span></p>
        {pct !== null && <><div className="mt-2 h-2 rounded-full bg-slate-100"><div className={cn('h-2 rounded-full', pct >= 100 ? 'bg-red-500' : 'bg-blue-600')} style={{ width: `${pct}%` }} /></div><p className="mt-1 text-xs text-slate-500">{formatEuros(budget, 0)} de budget ({pct} %)</p></>}
        {budget === null && <p className="mt-1 text-xs text-slate-400">Aucun budget prévu.</p>}
      </div>
      <div className="border-t border-slate-100 pt-3">
        <p className="font-medium text-slate-800">Qualité des données</p>
        <p className={cn('mt-1 flex items-center gap-1.5', r.duplicates + r.fakeLeads > 0 ? 'text-amber-700' : 'text-emerald-700')}>
          {r.duplicates + r.fakeLeads > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {r.duplicates} doublon{r.duplicates > 1 ? 's' : ''}, {r.fakeLeads} faux lead{r.fakeLeads > 1 ? 's' : ''}
        </p>
        <p className="mt-0.5 text-xs text-slate-400">{raw ? 'Inclus dans les chiffres (lecture brute).' : 'Exclus des leads valides, comptés à part.'}</p>
      </div>
      <div className="border-t border-slate-100 pt-3">
        <p className="font-medium text-slate-800">Parcours</p>
        <ul className="mt-1 space-y-1 text-xs text-slate-600">
          <li className="flex justify-between"><span>Contactés / leads</span><span className="tabular-nums">{r.contacted} / {r.leads} · {formatPercent(passage(r.contacted, r.leads))}</span></li>
          <li className="flex justify-between"><span>Dossiers complets / contactés</span><span className="tabular-nums">{r.docsComplete} / {r.contacted} · {formatPercent(passage(r.docsComplete, r.contacted))}</span></li>
          <li className="flex justify-between"><span>Ventes / dossiers complets</span><span className="tabular-nums">{r.sales} / {r.docsComplete} · {formatPercent(passage(r.sales, r.docsComplete))}</span></li>
          <li className="flex justify-between"><span>Installées / ventes</span><span className="tabular-nums">{r.installed} / {r.sales} · {formatPercent(passage(r.installed, r.sales))}</span></li>
        </ul>
      </div>
      <Link to={`/campagnes/${c.id}`} className="block rounded-lg bg-blue-600 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-blue-700">Ouvrir la campagne</Link>
    </aside>
  );
}
