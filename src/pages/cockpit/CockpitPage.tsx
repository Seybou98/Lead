import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Clock, Euro, FileText, Inbox, RefreshCw, Users, WifiOff, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import { buildCockpit, PERIOD_LABELS, sinceLabel, type Cockpit, type LeadIssue, type Period } from '../../domain/cockpit/cockpit';
import type { LeadListItem } from '../../domain/leads/leadList';
import { useCockpitData, type CockpitData } from './useCockpitData';
import { ManagerNotifications } from './ManagerNotifications';
import { LeadPanel, ListPanel, SEVERITY_STYLE, TONE_PILL } from './CockpitPanel';

type Kpi = 'danger' | 'callbacks' | 'docs';
type Panel = { kind: 'list'; kpi: Kpi } | { kind: 'buffer' } | { kind: 'lead'; leadId: string };

const BUFFER_REASONS: Record<string, string> = {
  no_candidate: 'aucun télépro éligible',
  duplicate_review: 'doublon à examiner',
  campaign_not_active: 'campagne non active',
  auto_distribution_off: 'distribution automatique désactivée',
};

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
  const [period, setPeriod] = useState<Period>('today');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cockpit: Cockpit = useMemo(() => buildCockpit({ items: data.items, rows: data.rows, nowMs: data.nowMs, period }), [data.items, data.rows, data.nowMs, period]);
  const byId = useMemo(() => new Map(data.items.map((l) => [l.id, l])), [data.items]);
  const issueOf = (id: string): LeadIssue | null => [...cockpit.danger, ...cockpit.lateCallbacks, ...cockpit.blockedDocs].find((i) => i.lead.id === id) ?? null;
  const basePath = '/leads';
  const openLead = (id: string) => byId.has(id) && setPanel({ kind: 'lead', leadId: id });

  const lists: Record<Kpi, { title: string; issues: LeadIssue[] }> = {
    danger: { title: 'Leads en danger', issues: cockpit.danger },
    callbacks: { title: 'Rappels en retard', issues: cockpit.lateCallbacks },
    docs: { title: 'Documents bloqués', issues: cockpit.blockedDocs },
  };
  // File tampon : chaque lead en attente est une ligne ; un clic ouvre le panneau d'attribution.
  const bufferIssues: LeadIssue[] = cockpit.buffer.leads.map((l) => ({
    lead: l,
    sinceMs: l.receivedAtMs,
    severity: data.nowMs - l.receivedAtMs > 15 * 60_000 ? 'critical' : 'high',
    reason: l.bufferReason ? `En attente d'attribution (${BUFFER_REASONS[l.bufferReason] ?? l.bufferReason})` : "En attente d'attribution",
  }));
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

      {data.offline && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <WifiOff className="h-4 w-4" /> Connexion perdue : les chiffres affichés datent de {data.syncedAtMs ? hm(data.syncedAtMs) : 'la dernière synchronisation'}.
        </p>
      )}
      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
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
        <KpiCard tone="green" icon={<Euro className="h-6 w-6" />} value="—" label="Ventes à sécuriser" sub="Disponible avec le lot Conversion" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Équipe en temps réel" icon={<Users className="h-[18px] w-[18px]" />}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  {['Télépro', 'État', 'Action actuelle', 'Charge', 'Attribués', 'Alerte'].map((h) => (
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
                      onClick={() => (d.action.kind === 'buffer' ? setPanel({ kind: 'buffer' }) : d.action.kind === 'docs' && d.leadId ? navigate(`${basePath}/${d.leadId}?onglet=documents`) : d.leadId && openLead(d.leadId))}
                      className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-blue-700"
                    >
                      {d.action.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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

      <ManagerNotifications nowMs={data.nowMs} onOpenLead={openLead} />

      {panel?.kind === 'list' && (
        <ListPanel title={lists[panel.kpi].title} issues={lists[panel.kpi].issues} nowMs={data.nowMs} names={data.names} onPick={openLead} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'buffer' && (
        <ListPanel title="File tampon" issues={bufferIssues} nowMs={data.nowMs} names={data.names} onPick={openLead} onClose={() => setPanel(null)} />
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
