import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Clock, Euro, FileText, Inbox, RefreshCw, Users, WifiOff, X, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import { buildCockpit, PERIOD_LABELS, sinceLabel, type Cockpit, type LeadIssue, type Period } from '../../domain/cockpit/cockpit';
import { activeFilterCount, applyLeadFilters, applyRowFilters, COCKPIT_FILTER_KEYS, COCKPIT_FILTER_LABELS, filterOptions, filtersFromParams, paramsWithFilters, type CockpitFilterKey } from '../../domain/cockpit/filters';
import { watchItems } from '../../domain/integrations/hub';
import { cockpitKpiAlerts } from '../../domain/cockpit/kpiAlerts';
import { getSlaMs, slaElapsedMs } from '../../domain/leads/leadList';
import { buildDocViews, buildPipeline, DOC_VIEW_DEFINITIONS, DOC_VIEW_LABELS, DOC_VIEWS, type DocView, type PipelineKey } from '../../domain/cockpit/pipeline';
import { bufferReasonText, LEAD_STATUS_LABELS } from '../../domain/labels';
import type { LeadListItem } from '../../domain/leads/leadList';
import { useCockpitData, type CockpitData } from './useCockpitData';
import { ManagerNotifications } from './ManagerNotifications';
import { LeadPanel, ListPanel, SEVERITY_STYLE, TONE_PILL } from './CockpitPanel';
import { sendConversionAction } from '../../lib/conversionApi';

type Kpi = 'danger' | 'callbacks' | 'docs' | 'sales';
type Panel = { kind: 'list'; kpi: Kpi } | { kind: 'buffer' } | { kind: 'lead'; leadId: string } | { kind: 'stage'; key: PipelineKey } | { kind: 'doc'; view: DocView };
const PERIOD_PARAM = 'periode';

const selectCls = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';
const hm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function KpiCard({ tone, icon, value, label, sub, onOpen }: { tone: 'red' | 'orange' | 'blue' | 'green'; icon: React.ReactNode; value: string; label: string; sub?: string; onOpen?: () => void }) {
  const style = {
    red: { card: 'border-red-100 bg-red-50/70', icon: 'bg-red-100 text-red-600', num: 'text-red-600', link: 'text-red-700' },
    orange: { card: 'border-orange-100 bg-orange-50/70', icon: 'bg-orange-100 text-orange-600', num: 'text-orange-600', link: 'text-orange-700' },
    blue: { card: 'border-blue-100 bg-blue-50/70', icon: 'bg-blue-100 text-blue-600', num: 'text-blue-600', link: 'text-blue-700' },
    green: { card: 'border-emerald-100 bg-emerald-50/70', icon: 'bg-emerald-100 text-emerald-600', num: 'text-emerald-600', link: 'text-emerald-700' },
  }[tone];
  const body = (
    <>
      <span className={cn('flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full', style.icon)}>{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className={cn('block text-3xl font-bold leading-none', style.num)}>{value}</span>
        <span className="mt-1 block text-sm font-medium text-slate-800">{label}</span>
        {sub && <span className="block text-xs text-slate-500">{sub}</span>}
      </span>
      {onOpen && <span className={cn('inline-flex flex-shrink-0 items-center gap-1 self-end text-xs font-medium', style.link)}>Voir <ArrowRight className="h-3.5 w-3.5" /></span>}
    </>
  );
  const cls = cn('flex items-center gap-4 rounded-xl border p-4', style.card);
  return onOpen ? (
    <button type="button" onClick={onOpen} className={cn(cls, 'w-full transition hover:shadow-sm')}>{body}</button>
  ) : (
    <div className={cls} title="Les ventes arrivent avec le lot Conversion">{body}</div>
  );
}

function Card({ title, icon, children, className }: { title: string; icon: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-5', className)}>
      <h2 className="flex items-center gap-2.5 text-base font-semibold text-slate-900"><span className="text-blue-600">{icon}</span>{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function CockpitPage() {
  const { user } = useAuth();
  const role: Role = user?.role ?? 'manager';
  return <CockpitView data={useCockpitData(role, user?.uid ?? '')} role={role} />;
}

export function CockpitView({ data, role }: { data: CockpitData; role: Role }) {
  const navigate = useNavigate();
  // Période et filtres vivent dans l'adresse : un retour depuis une fiche retrouve la même sélection (§12.5).
  const [params, setParams] = useSearchParams();
  const periodParam = params.get(PERIOD_PARAM);
  const period: Period = periodParam && periodParam in PERIOD_LABELS ? (periodParam as Period) : 'today';
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setPeriod = (p: Period) => setParams((cur) => { const n = new URLSearchParams(cur); n.set(PERIOD_PARAM, p); return n; }, { replace: true });
  const setFilter = (k: CockpitFilterKey, v: string) => setParams((cur) => paramsWithFilters(cur, { ...filtersFromParams(cur), [k]: v }), { replace: true });
  const resetFilters = () => setParams((cur) => paramsWithFilters(cur, { team: '', product: '', campaign: '', zone: '' }), { replace: true });
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const options = useMemo(() => filterOptions(data.items, data.rows, data.names.campaigns), [data.items, data.rows, data.names.campaigns]);
  // Un filtre s'applique à TOUT ce que montre l'écran : on filtre les données avant de construire le cockpit.
  const items = useMemo(() => applyLeadFilters(data.items, data.rows, filters), [data.items, data.rows, filters]);
  const rows = useMemo(() => applyRowFilters(data.rows, filters), [data.rows, filters]);
  const cockpit: Cockpit = useMemo(() => buildCockpit({ items, rows, nowMs: data.nowMs, period }), [items, rows, data.nowMs, period]);
  const flagged = useMemo(() => new Set([...cockpit.danger, ...cockpit.lateCallbacks, ...cockpit.blockedDocs].map((i) => i.lead.id)), [cockpit]);
  const pipeline = useMemo(() => buildPipeline(items, flagged, data.nowMs), [items, flagged, data.nowMs]);
  const docViews = useMemo(() => buildDocViews(items, data.nowMs), [items, data.nowMs]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l])), [items]);
  // Alertes système du hub d'intégrations (§24.10) : planificateur arrêté, retour des statuts en erreur répétée.
  const systemAlerts = useMemo(() => watchItems([], data.nowMs, data.scheduler?.lastRunAtMs ?? null, data.scheduler?.statusReturn ?? null).filter((w) => w.level === 'critical' || w.id === 'status_return'), [data.nowMs, data.scheduler]);
  const kpi = useMemo(
    () => cockpitKpiAlerts({ rules: data.kpiRules, leads: items, spends: data.spends, campaigns: data.reportCampaigns, filters, period, nowMs: data.nowMs, slaMs: getSlaMs(), elapsed: slaElapsedMs }),
    [data.kpiRules, items, data.spends, data.reportCampaigns, filters, period, data.nowMs]
  );
  const filterLabel = (k: CockpitFilterKey, v: string): string =>
    k === 'team' ? (options.teams.find((t) => t.id === v)?.name ?? v) : k === 'campaign' ? (options.campaigns.find((c) => c.id === v)?.name ?? v) : k === 'zone' ? `Département ${v}` : v;
  const issueOf = (id: string): LeadIssue | null => [...cockpit.danger, ...cockpit.lateCallbacks, ...cockpit.blockedDocs].find((i) => i.lead.id === id) ?? null;
  const basePath = '/leads';
  const openLead = (id: string) => byId.has(id) && setPanel({ kind: 'lead', leadId: id });

  const lists: Record<Kpi, { title: string; issues: LeadIssue[] }> = {
    danger: { title: 'Leads en danger', issues: cockpit.danger },
    callbacks: { title: 'Rappels en retard', issues: cockpit.lateCallbacks },
    docs: { title: 'Documents bloqués', issues: cockpit.blockedDocs },
    sales: { title: 'Ventes à sécuriser', issues: cockpit.salesToSecure },
  };

  /** « Réessayer » d'une transmission au CRM principal. Un doublon de dossier se tranche sur la fiche du dossier. */
  const retryTransmission = async (leadId: string) => {
    setRetrying(leadId);
    setProblem(null);
    const r = await sendConversionAction(leadId, { kind: 'transmit' });
    setRetrying(null);
    if (r.ok) return setNotice(r.message);
    setProblem(r.message);
    if (/existe déjà/.test(r.message)) navigate(`/dossiers/${leadId}`);
  };
  // File tampon : chaque lead en attente est une ligne ; un clic ouvre le panneau d'attribution.
  const bufferIssues: LeadIssue[] = cockpit.buffer.leads.map((l) => ({
    lead: l,
    sinceMs: l.receivedAtMs,
    severity: data.nowMs - l.receivedAtMs > 15 * 60_000 ? 'critical' : 'high',
    reason: l.bufferReason ? `En attente d'attribution (${bufferReasonText(l.bufferReason)})` : "En attente d'attribution",
  }));
  const bulk = { team: cockpit.team, canAct: role === 'admin' || role === 'manager', onDone: (m: string) => { setPanel(null); setNotice(m); } };
  const panelLead: LeadListItem | null = panel?.kind === 'lead' ? (byId.get(panel.leadId) ?? null) : null;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cockpit Manager</h1>
          <p className="mt-1 text-slate-500">Les priorités qui nécessitent votre attention maintenant.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <select aria-label="Période" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
            ))}
          </select>
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-500" role="status">
            {data.offline ? <WifiOff className="h-4 w-4 text-red-600" /> : <RefreshCw className="h-4 w-4" />}
            {data.syncedAtMs ? `Mis à jour à ${hm(data.syncedAtMs)}` : 'Synchronisation…'}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Filtres globaux">
        <select aria-label="Équipe" value={filters.team} onChange={(e) => setFilter('team', e.target.value)} className={selectCls}><option value="">Toutes les équipes</option>{options.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select aria-label="Produit" value={filters.product} onChange={(e) => setFilter('product', e.target.value)} className={selectCls}><option value="">Tous les produits</option>{options.products.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <select aria-label="Campagne" value={filters.campaign} onChange={(e) => setFilter('campaign', e.target.value)} className={selectCls}><option value="">Toutes les campagnes</option>{options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select aria-label="Zone" value={filters.zone} onChange={(e) => setFilter('zone', e.target.value)} className={selectCls}><option value="">Toutes les zones</option>{options.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
        {COCKPIT_FILTER_KEYS.filter((k) => filters[k]).map((k) => (
          <button key={k} type="button" onClick={() => setFilter(k, '')} aria-label={`Retirer le filtre ${COCKPIT_FILTER_LABELS[k]}`} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">{COCKPIT_FILTER_LABELS[k]} : {filterLabel(k, filters[k])} <X className="h-3 w-3" /></button>
        ))}
        {activeFilterCount(filters) > 0 && <button type="button" onClick={resetFilters} className="text-xs font-medium text-blue-700 hover:underline">Réinitialiser les filtres ({activeFilterCount(filters)})</button>}
        {filters.team && <span className="text-xs text-slate-500">La file tampon n’appartient à aucune équipe : elle n’apparaît pas avec ce filtre.</span>}
      </div>

      {data.offline && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <WifiOff className="h-4 w-4" /> Connexion perdue : les chiffres affichés datent de {data.syncedAtMs ? hm(data.syncedAtMs) : 'la dernière synchronisation'}.
        </p>
      )}
      {systemAlerts.map((a) => <p key={a.id} role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /><span><strong>{a.title}</strong> {a.detail}</span></p>)}
      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
      {problem && (
        <p role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {problem}</span>
          <button type="button" onClick={() => setProblem(null)} className="text-xs underline">Fermer</button>
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> {notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">Fermer</button>
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard tone="red" icon={<AlertTriangle className="h-6 w-6" />} value={String(cockpit.danger.length)} label="Leads en danger" sub="SLA dépassé ou proche" onOpen={() => setPanel({ kind: 'list', kpi: 'danger' })} />
        <KpiCard tone="orange" icon={<Clock className="h-6 w-6" />} value={String(cockpit.lateCallbacks.length)} label="Rappels en retard" onOpen={() => setPanel({ kind: 'list', kpi: 'callbacks' })} />
        <KpiCard tone="blue" icon={<FileText className="h-6 w-6" />} value={String(cockpit.blockedDocs.length)} label="Documents bloqués" onOpen={() => setPanel({ kind: 'list', kpi: 'docs' })} />
        <KpiCard tone="green" icon={<Euro className="h-6 w-6" />} value={String(cockpit.salesToSecure.length)} label="Ventes à sécuriser" sub="Signature et paiement à confirmer" onOpen={() => setPanel({ kind: 'list', kpi: 'sales' })} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Équipe en temps réel" icon={<Users className="h-[18px] w-[18px]" />}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  {['Télépro', 'État', 'Action actuelle', 'Charge', 'Attribués', 'Résultat', 'Alerte'].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cockpit.team.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">{data.loading ? 'Chargement…' : 'Aucun télépro dans votre périmètre.'}</td></tr>
                )}
                {cockpit.team.slice(0, 6).map((t) => {
                  const pct = t.cap > 0 ? Math.min(100, Math.round((t.newLeads / t.cap) * 100)) : 0;
                  return (
                    <tr key={t.uid}>
                      <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-900"><Link to={`/utilisateurs/${t.uid}`} className="hover:text-blue-700 hover:underline">{t.name}</Link></td>
                      <td className="px-3 py-3"><span className={cn('whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', TONE_PILL[t.state.tone])}>● {t.state.label}</span></td>
                      <td className="max-w-[220px] truncate px-3 py-3 text-slate-700" title={t.current ?? undefined}>{t.current ?? '—'}</td>
                      <td className="px-3 py-3">
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-16 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Charge de ${t.name}`}>
                            <span className={cn('block h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                          </span>
                          <span className="text-xs tabular-nums text-slate-600">{t.newLeads}/{t.cap}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-700">{t.assignedInPeriod}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-slate-700" title="Ventes nettes de la période, dont installées et facturées dans le CRM principal">{t.result.sales === 0 ? '—' : `${t.result.sales} vente${t.result.sales > 1 ? 's' : ''}`}{t.result.installed > 0 && <span className="ml-1 text-xs text-slate-400">· {t.result.installed} inst.</span>}</td>
                      <td className="px-3 py-3">{t.alert ? <span className={cn('whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', TONE_PILL[t.alert.tone])}>● {t.alert.label}</span> : <span className="text-slate-300">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Link to="/equipe" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline">Voir toute l&apos;équipe <ArrowRight className="h-4 w-4" /></Link>
        </Card>

        <Card title="Décisions à prendre" icon={<Zap className="h-[18px] w-[18px]" />}>
          {cockpit.decisions.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Aucune décision en attente.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {cockpit.decisions.slice(0, 6).map((d) => {
                const sev = SEVERITY_STYLE[d.severity];
                return (
                  <li key={d.id} className="flex items-center gap-3 py-3">
                    <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', sev.dot)} role="img" aria-label={sev.label} title={sev.label} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{d.title}</span>
                      {d.sinceMs !== null && <span className="block text-xs text-slate-500">Depuis {sinceLabel(d.sinceMs, data.nowMs)}</span>}
                    </span>
                    <button
                      type="button"
                      disabled={retrying !== null && d.leadId === retrying}
                      onClick={() => {
                        if (d.action.kind === 'buffer') return setPanel({ kind: 'buffer' });
                        if (d.action.kind === 'docs' && d.leadId) return navigate(`${basePath}/${d.leadId}?onglet=documents`);
                        if (d.action.kind === 'validation' && d.leadId) return navigate(`/dossiers/${d.leadId}`);
                        if (d.action.kind === 'transmit' && d.leadId) return void retryTransmission(d.leadId);
                        if (d.leadId) openLead(d.leadId);
                      }}
                      className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {retrying !== null && d.leadId === retrying ? 'Reprise…' : d.action.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {items.some((l) => l.status === 'transmission_error') && <Link to="/integrations" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline">Erreurs de transmission au CRM principal <ArrowRight className="h-4 w-4" /></Link>}
          {cockpit.decisions.length > 6 && <p className="mt-2 text-xs text-slate-500">+ {cockpit.decisions.length - 6} autre(s) : ouvrez les cartes ci-dessus pour les voir toutes.</p>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`Flux — ${PERIOD_LABELS[period].toLowerCase()}`} icon={<BarChart3 className="h-[18px] w-[18px]" />}>
          <dl className="grid grid-cols-3 divide-x divide-slate-100 text-center sm:text-left">
            {[
              ['leads reçus', cockpit.flow.received, 'text-blue-600'],
              ['attribués', cockpit.flow.assigned, 'text-blue-600'],
              ['contactés', cockpit.flow.contacted, 'text-blue-600'],
            ].map(([label, value, tone]) => (
              <div key={label as string} className="px-4 first:pl-0">
                <dd className={cn('text-3xl font-bold', tone as string)}>{value}</dd>
                <dt className="text-sm text-slate-600">{label}</dt>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="File tampon" icon={<Inbox className="h-[18px] w-[18px]" />}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-slate-700"><span className="text-3xl font-bold text-slate-900">{cockpit.buffer.count}</span> lead{cockpit.buffer.count > 1 ? 's' : ''}</p>
              <p className="text-xs text-slate-500">{cockpit.buffer.oldestMs !== null ? `Plus ancien : ${sinceLabel(cockpit.buffer.oldestMs, data.nowMs)}` : 'Aucun lead en attente'}</p>
            </div>
            <button type="button" onClick={() => setPanel({ kind: 'buffer' })} className="rounded-md border border-blue-600 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-blue-700 hover:bg-blue-50">Ouvrir la file</button>
          </div>
        </Card>
      </div>

      {kpi.alerts.length > 0 && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5" aria-label="Alertes KPI">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2.5 text-base font-semibold text-slate-900"><span className="text-blue-600"><BarChart3 className="h-[18px] w-[18px]" /></span>Alertes KPI</h2>
            <span className="text-xs text-slate-500">Évaluées sur les {kpi.windowDays} derniers jours · règles de Paramètres → Objectifs et alertes</span>
          </div>
          <ul className="mt-3 space-y-2">
            {kpi.alerts.map((a) => (
              <li key={a.id} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', a.level === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span className="flex-1"><span className="block font-medium">{a.level === 'critical' ? 'Critique · ' : ''}{a.title}</span><span className="block text-xs opacity-80">{a.detail}</span></span>
                <Link to="/rapports" className="flex-shrink-0 rounded-lg bg-white/70 px-3 py-1 text-xs font-semibold hover:bg-white">Voir le rapport</Link>
              </li>
            ))}
          </ul>
          {kpi.spendUnavailable && <p className="mt-2 text-xs text-slate-500">Avec un filtre d’équipe ou de zone, les dépenses ne sont pas attribuables : les règles de coût ne sont pas évaluées.</p>}
        </section>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Pipeline" icon={<BarChart3 className="h-[18px] w-[18px]" />}>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {pipeline.map((s, i) => (
              <li key={s.key}>
                <button type="button" onClick={() => setPanel({ kind: 'stage', key: s.key })} className="w-full rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50" title="Ancienneté moyenne depuis la réception du lead. Le taux de passage est un plancher déduit du statut actuel.">
                  <span className="block text-xs text-slate-500">{i + 1}. {s.label}</span>
                  <span className="block text-2xl font-bold tabular-nums text-slate-900">{s.count}</span>
                  <span className="block text-[11px] text-slate-500">{s.avgAgeMs === null ? 'Aucun lead' : `âge moyen ${sinceLabel(data.nowMs - s.avgAgeMs, data.nowMs)}`}</span>
                  <span className="mt-1 flex items-center justify-between text-[11px]">
                    <span className={cn(s.blocked > 0 ? 'font-medium text-red-600' : 'text-slate-300')}>{s.blocked > 0 ? `${s.blocked} bloqué${s.blocked > 1 ? 's' : ''}` : '0 bloqué'}</span>
                    <span className="text-slate-400">{s.passage === null ? '' : `→ ${s.passage.toLocaleString('fr-FR')} %`}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Cockpit documentaire" icon={<FileText className="h-[18px] w-[18px]" />}>
          <ul className="divide-y divide-slate-100">
            {DOC_VIEWS.map((v) => (
              <li key={v}>
                <button type="button" onClick={() => setPanel({ kind: 'doc', view: v })} className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-slate-50" title={DOC_VIEW_DEFINITIONS[v]}>
                  <span className="text-sm text-slate-800">{DOC_VIEW_LABELS[v]}</span>
                  <span className={cn('rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums', docViews[v].length === 0 ? 'bg-slate-100 text-slate-400' : docViews[v].some((i) => i.severity === 'high') ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700')}>{docViews[v].length}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <ManagerNotifications nowMs={data.nowMs} onOpenLead={openLead} />

      {panel?.kind === 'list' && (
        <ListPanel title={lists[panel.kpi].title} issues={lists[panel.kpi].issues} nowMs={data.nowMs} names={data.names} bulk={bulk} onPick={panel.kpi === 'sales' ? (id) => navigate(`/dossiers/${id}`) : openLead} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'stage' && (() => {
        const step = pipeline.find((x) => x.key === panel.key);
        const issues: LeadIssue[] = (step?.leads ?? []).map((l) => ({ lead: l, sinceMs: l.receivedAtMs, severity: flagged.has(l.id) ? 'high' : 'info', reason: `${LEAD_STATUS_LABELS[l.status]}${flagged.has(l.id) ? ' · signalé au cockpit' : ''}` }));
        return <ListPanel title={`Pipeline — ${step?.label ?? ''}`} issues={issues} nowMs={data.nowMs} names={data.names} bulk={bulk} onPick={openLead} onClose={() => setPanel(null)} />;
      })()}
      {panel?.kind === 'doc' && <ListPanel title={DOC_VIEW_LABELS[panel.view]} issues={docViews[panel.view]} nowMs={data.nowMs} names={data.names} bulk={bulk} onPick={(id) => navigate(`${basePath}/${id}?onglet=documents`)} onClose={() => setPanel(null)} />}
      {panel?.kind === 'buffer' && (
        <ListPanel title="File tampon" issues={bufferIssues} nowMs={data.nowMs} names={data.names} bulk={bulk} onPick={openLead} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'lead' && panelLead && (
        <LeadPanel
          key={panelLead.id}
          lead={panelLead}
          issue={issueOf(panelLead.id)}
          team={cockpit.team}
          nowMs={data.nowMs}
          names={data.names}
          canReassign={role === 'admin' || role === 'manager'}
          basePath={basePath}
          onClose={() => setPanel(null)}
          onDone={(m) => {
            setPanel(null);
            setNotice(m);
          }}
        />
      )}
    </div>
  );
}
