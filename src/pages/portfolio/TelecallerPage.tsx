import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { AlertTriangle, ArrowRightLeft, CalendarOff, FileText, FolderOpen, Gauge, MapPin, Package, PauseCircle, PhoneCall, PlayCircle, ShieldCheck, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { DISTRIBUTION_LABELS, ROLE_LABELS } from '../../domain/labels';
import { getSlaMs, formatPhoneDisplay, type LeadListItem } from '../../domain/leads/leadList';
import { buildDayQueue } from '../../domain/leads/myDay';
import { recentActivity } from '../../domain/leads/activity';
import { formatWeeklySchedule } from '../../domain/admin/scheduleFormat';
import { useSettings } from '../settings/useSettings';
import { FAMILIES, FAMILY_LABELS, loadRatio, portfolioTotal, type Family } from '../../domain/portfolio/portfolio';
import { ABSENCE_TYPES, isActiveAbsence } from '../../domain/portfolio/absence';
import { sinceLabel, type Tone } from '../../domain/cockpit/cockpit';
import { errorMessage, saveProfile } from '../../lib/adminApi';
import { sendEndAbsence } from '../../lib/portfolioApi';
import { ms } from '../../lib/firestoreViews';
import { TONE_PILL } from '../cockpit/CockpitPanel';
import { usePortfolioData, type PortfolioData } from './usePortfolioData';

type Tab = 'overview' | 'portfolio' | 'performance' | 'absences' | 'rights' | 'journal';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: "Vue d'ensemble" },
  { key: 'portfolio', label: 'Portefeuille' },
  { key: 'performance', label: 'Performance' },
  { key: 'absences', label: 'Horaires & absences' },
  { key: 'rights', label: 'Droits' },
  { key: 'journal', label: 'Journal' },
];

const FAMILY_BAR: Record<Family, string> = { newLeads: 'bg-blue-500', callbacks: 'bg-emerald-500', interested: 'bg-violet-500', documents: 'bg-amber-500', filesToBuild: 'bg-red-500', recycling: 'bg-slate-400' };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
const date = (ms: number) => new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** « 10:42 » aujourd'hui, « hier 10:42 », sinon « 12/09 10:42 ». */
function activityTime(atMs: number, nowMs: number): string {
  const hm = new Date(atMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const diff = Math.round((day(nowMs) - day(atMs)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `hier ${hm}`;
  return `${new Date(atMs).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
const startOfMonth = (ms: number) => new Date(new Date(ms).getFullYear(), new Date(ms).getMonth(), 1).getTime();

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-5', className)}>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-xl font-bold text-slate-900">{value}{sub && <span className="ml-0.5 text-sm font-medium text-slate-400">{sub}</span>}</p>
      </div>
    </div>
  );
}

/** Performance du mois : entonnoir leads → contacts → documents demandés → dossiers complets → ventes, avec les taux. */
export function monthlyFunnel(items: readonly LeadListItem[], uid: string, nowMs: number) {
  const start = startOfMonth(nowMs);
  const mine = items.filter((l) => l.ownerId === uid && !l.excluded && l.receivedAtMs >= start);
  const contacted = mine.filter((l) => l.slaStoppedAtMs !== null);
  const docs = mine.filter((l) => l.documentsState !== 'none');
  const complete = mine.filter((l) => l.documentsState === 'complete');
  const sold = mine.filter((l) => l.status === 'converted');
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    leads: mine.length,
    contacts: contacted.length,
    documents: docs.length,
    complete: complete.length,
    sales: sold.length,
    rates: [rate(contacted.length, mine.length), rate(docs.length, contacted.length), rate(complete.length, docs.length), rate(sold.length, complete.length)],
    /** Part des leads pris en charge dans le délai du SLA, sur ceux qui l'ont été. */
    slaRespected: (() => {
      const handled = mine.filter((l) => l.slaStartedAtMs !== null && l.slaStoppedAtMs !== null);
      return handled.length ? Math.round((handled.filter((l) => (l.slaStoppedAtMs as number) - (l.slaStartedAtMs as number) <= getSlaMs()).length / handled.length) * 100) : null;
    })(),
  };
}

export function TelecallerPage() {
  const { uid = '' } = useParams();
  return <TelecallerView data={usePortfolioData(uid)} uid={uid} />;
}

export function TelecallerView({ data, uid }: { data: PortfolioData; uid: string }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  // Message laissé par la déclaration d'absence ou le transfert avant la redirection.
  const fromState = (useLocation().state as { notice?: string } | null)?.notice;
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(fromState ? { kind: 'ok', text: fromState } : null);
  const { row, portfolio, nowMs, role } = data;
  const canAct = role === 'admin' || role === 'manager';

  const queue = useMemo(() => buildDayQueue(data.items, uid, nowMs), [data.items, uid, nowMs]);
  // Dernières actions utiles : sur les leads dont il est propriétaire ou propriétaire d'origine (portefeuille transféré).
  const activity = useMemo(() => recentActivity(data.items.filter((l) => l.ownerId === uid), 5), [data.items, uid]);
  const funnel = useMemo(() => monthlyFunnel(data.items, uid, nowMs), [data.items, uid, nowMs]);

  if (!row) {
    return (
      <div className="w-full">
        <Link to="/equipe" className="text-sm text-blue-600 hover:underline">← Retour à l&apos;équipe</Link>
        <p className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-600">{data.loading ? 'Chargement…' : "Ce télépro n'existe pas ou n'est pas dans votre périmètre."}</p>
      </div>
    );
  }

  const total = portfolioTotal(portfolio);
  const cap = row.cap ?? 0;
  const used = row.newLeads ?? 0;
  const pct = loadRatio(used, cap);
  const stateTone: Tone = !row.connected ? 'grey' : row.operationalStatus === 'available' ? 'green' : row.operationalStatus === 'absent' || row.operationalStatus === 'paused' ? 'grey' : 'blue';
  const stateLabel = !row.connected ? 'Déconnecté' : row.operationalStatus === 'available' ? 'Disponible' : row.operationalStatus === 'absent' ? 'Absent' : row.operationalStatus === 'paused' ? 'En pause' : 'En activité';
  const callbacksToday = portfolio.callbacks.filter((l) => l.nextAction !== null && l.nextAction.dueAtMs <= new Date(nowMs).setHours(23, 59, 59, 999)).length;
  const suspended = row.distribution === 'suspended';

  const toggleDistribution = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveProfile({ uid, distributionSuspended: !suspended, reason: suspended ? 'Réactivation depuis la fiche télépro' : 'Suspension depuis la fiche télépro' });
      setNotice({ kind: 'ok', text: `Distribution ${suspended ? 'réactivée' : 'suspendue'}.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to={role === 'admin' ? '/utilisateurs' : '/equipe'} className="text-blue-600 hover:underline">{role === 'admin' ? 'Utilisateurs' : 'Équipe'}</Link>
        <span className="mx-2">/</span>
        <span>{row.name}</span>
      </nav>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 text-lg font-semibold text-blue-700">{initials(row.name)}</span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{row.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">{ROLE_LABELS[row.role]}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_PILL[stateTone])}>● {stateLabel}</span>
              {row.email && <span className="text-xs text-slate-500">{row.email}</span>}
            </p>
          </div>
        </div>
        {canAct && (
          <div className="flex flex-wrap items-center gap-2.5">
            <Link to={`/utilisateurs/${uid}/absence`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"><CalendarOff className="h-4 w-4" /> Déclarer une absence</Link>
            <Link to={`/utilisateurs/${uid}/transfert`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"><ArrowRightLeft className="h-4 w-4" /> Transférer le portefeuille</Link>
            {role === 'admin' && (
              <button type="button" disabled={busy} onClick={toggleDistribution} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                {suspended ? <><PlayCircle className="h-4 w-4" /> Réactiver la distribution</> : <><PauseCircle className="h-4 w-4" /> Suspendre la distribution</>}
              </button>
            )}
          </div>
        )}
      </div>

      {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>{notice.text}</p>}
      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}

      <div className="mt-6 border-b border-slate-200" role="tablist" aria-label="Sections de la fiche">
        <div className="flex flex-wrap gap-x-7">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)} className={cn('-mb-px border-b-2 px-1 pb-3 text-sm font-semibold', tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent font-medium text-slate-600 hover:text-slate-900')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="mt-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <Kpi icon={<Users className="h-5 w-5" />} label="Nouveaux leads" value={String(used)} sub={`/${cap}`} tone="bg-blue-50 text-blue-600" />
            <Kpi icon={<PhoneCall className="h-5 w-5" />} label="Rappels aujourd'hui" value={String(callbacksToday)} tone="bg-emerald-50 text-emerald-600" />
            <Kpi icon={<FileText className="h-5 w-5" />} label="Documents en attente" value={String(portfolio.documents.length)} tone="bg-amber-50 text-amber-600" />
            <Kpi icon={<FolderOpen className="h-5 w-5" />} label="Dossiers à monter" value={String(portfolio.filesToBuild.length)} tone="bg-violet-50 text-violet-600" />
            <Kpi icon={<Gauge className="h-5 w-5" />} label="Ventes ce mois" value={funnel.sales ? String(funnel.sales) : '—'} tone="bg-emerald-50 text-emerald-600" />
            <Kpi icon={<ShieldCheck className="h-5 w-5" />} label="SLA respecté" value={funnel.slaRespected === null ? '—' : `${funnel.slaRespected} %`} tone="bg-blue-50 text-blue-600" />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Activité en temps réel">
              <p className="flex items-center gap-2 text-sm text-slate-700"><span className={cn('h-2 w-2 rounded-full', row.connected ? 'bg-emerald-500' : 'bg-slate-400')} /> {stateLabel}{row.connected ? '' : ' — hors ligne'}</p>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Dernières actions</p>
              {activity.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">Aucune action enregistrée pour le moment.</p>
              ) : (
                <ol className="mt-3 space-y-3 border-l border-slate-200 pl-4" aria-label="Dernières actions utiles">
                  {activity.map((a, i) => (
                    <li key={`${a.lead.id}-${a.kind}-${i}`} className="relative text-sm">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-blue-500 bg-white" aria-hidden="true" />
                      <span className="flex items-baseline justify-between gap-3"><span className="font-medium text-slate-800">{a.label}</span><time className="flex-shrink-0 text-xs text-slate-400" dateTime={new Date(a.atMs).toISOString()}>{activityTime(a.atMs, nowMs)}</time></span>
                      <span className="block truncate text-xs text-slate-500">{a.lead.fullName || 'Contact sans nom'}{a.lead.productCode ? ` · ${a.lead.productCode}` : ''}</span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">À traiter ensuite</p>
              {queue.current === null ? (
                <p className="mt-2 text-sm text-slate-500">Aucune action en attente.</p>
              ) : (
                <ul className="mt-2 space-y-2.5 text-sm">
                  {[queue.current, ...queue.upcoming].slice(0, 4).map((a) => (
                    <li key={a.lead.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0"><span className="block truncate font-medium text-slate-800">{a.title}</span><span className="block truncate text-xs text-slate-500">{a.lead.fullName}{a.lead.productCode ? ` · ${a.lead.productCode}` : ''}</span></span>
                      {a.late && <span className="flex-shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">En retard</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Portefeuille actif">
              <ul className="space-y-3">
                {FAMILIES.map((f) => (
                  <li key={f}>
                    <div className="flex items-center justify-between text-sm"><span className="text-slate-600">{FAMILY_LABELS[f]}</span><span className="font-semibold text-slate-900">{portfolio[f].length}</span></div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cn('h-full rounded-full', FAMILY_BAR[f])} style={{ width: `${total ? Math.round((portfolio[f].length / total) * 100) : 0}%` }} /></div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm font-semibold text-slate-900"><span>Total</span><span>{total}</span></p>
            </Card>

            <Card title="Périmètre & capacité">
              <div className="grid grid-cols-[1fr_auto] gap-4">
                <dl className="space-y-3 text-sm">
                  <div className="flex items-start gap-2.5"><Users className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Équipe</dt><dd className="font-medium text-slate-800">{row.teamNames.length ? row.teamNames.join(', ') : '—'}</dd></div></div>
                  <div className="flex items-start gap-2.5"><Package className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Produits</dt><dd className="font-medium text-slate-800">{row.products.length ? row.products.join(' + ') : 'Aucun'}</dd></div></div>
                  <div className="flex items-start gap-2.5"><MapPin className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Zone géographique</dt><dd className="font-medium text-slate-800">{row.zones.length ? row.zones.join(' + ') : 'Aucune'}</dd></div></div>
                  <div className="flex items-start gap-2.5"><ShieldCheck className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Distribution</dt><dd className={cn('font-medium', suspended || row.distribution === 'full' ? 'text-red-600' : 'text-emerald-700')}>{DISTRIBUTION_LABELS[row.distribution]}</dd></div></div>
                </dl>
                <div className="flex flex-col items-center justify-center border-l border-slate-100 pl-4 text-center">
                  <p className="text-xs text-slate-500">Capacité quotidienne</p>
                  <div className="relative mt-2 h-24 w-24">
                    <svg viewBox="0 0 36 36" className="h-24 w-24 -rotate-90" role="img" aria-label={`${pct} % de la capacité utilisée`}>
                      <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
                      <circle cx="18" cy="18" r="15.9" fill="none" stroke={pct >= 100 ? '#ef4444' : '#2563eb'} strokeWidth="3.5" strokeDasharray={`${pct} 100`} strokeLinecap="round" />
                    </svg>
                    <span className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-bold text-slate-900">{used}<span className="text-sm text-slate-400">/{cap}</span></span><span className="text-[10px] text-slate-500">leads</span></span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{pct} % utilisé</p>
                </div>
              </div>
            </Card>
          </div>

          <FunnelCard funnel={funnel} />
        </div>
      )}

      {tab === 'portfolio' && (
        <div className="mt-6 space-y-5">
          {total === 0 && <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Aucun élément ouvert dans ce portefeuille.</p>}
          {FAMILIES.filter((f) => portfolio[f].length > 0).map((f) => (
            <Card key={f} title={`${FAMILY_LABELS[f]} (${portfolio[f].length})`}>
              <ul className="divide-y divide-slate-100">
                {portfolio[f].map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0"><Link to={`/leads/${l.id}`} className="block truncate font-medium text-slate-900 hover:underline">{l.fullName || 'Contact sans nom'}</Link><span className="block truncate text-xs text-slate-500">{l.productCode ?? '—'} · {formatPhoneDisplay(l.phone)}</span></span>
                    <span className="flex-shrink-0 text-xs text-slate-500">{l.nextAction ? l.nextAction.reason : 'Aucune action'}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {canAct && total > 0 && <Link to={`/utilisateurs/${uid}/transfert`} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"><ArrowRightLeft className="h-4 w-4" /> Transférer le portefeuille</Link>}
        </div>
      )}

      {tab === 'performance' && (
        <div className="mt-6">
          <FunnelCard funnel={funnel} />
          <p className="mt-3 text-xs text-slate-500">Leads reçus ce mois-ci et attribués à ce télépro. Les ventes comptent les leads convertis ; l’historique des ventes jour par jour arrivera avec le lot Conversion.</p>
        </div>
      )}

      {tab === 'absences' && <AbsencesTab data={data} uid={uid} canAct={canAct} />}

      {tab === 'rights' && (
        <div className="mt-6 max-w-2xl">
          <Card title="Accès et droits">
            <dl className="grid grid-cols-[180px_1fr] gap-y-3 text-sm">
              <dt className="text-slate-500">Rôle</dt><dd className="font-medium text-slate-900">{ROLE_LABELS[row.role]}</dd>
              <dt className="text-slate-500">Compte</dt><dd className="font-medium text-slate-900">{row.accountActive ? 'Actif' : 'Inactif'}</dd>
              <dt className="text-slate-500">Distribution</dt><dd className="font-medium text-slate-900">{DISTRIBUTION_LABELS[row.distribution]}</dd>
              <dt className="text-slate-500">Périmètre</dt><dd className="font-medium text-slate-900">{row.products.length ? row.products.join(', ') : 'Aucun produit'} · {row.zones.length ? row.zones.join(', ') : 'Aucune zone'}</dd>
            </dl>
            <p className="mt-4 text-xs text-slate-500">Le rôle vient du compte du CRM principal. Un changement de rôle prend effet sans nouvelle connexion.</p>
          </Card>
        </div>
      )}

      {tab === 'journal' && <JournalTab uid={uid} role={role} nowMs={nowMs} />}
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: ReturnType<typeof monthlyFunnel> }) {
  const steps: { label: string; value: number }[] = [
    { label: 'leads', value: funnel.leads },
    { label: 'contacts', value: funnel.contacts },
    { label: 'documents demandés', value: funnel.documents },
    { label: 'dossiers complets', value: funnel.complete },
    { label: 'ventes', value: funnel.sales },
  ];
  return (
    <Card title="Performance du mois">
      <div className="grid grid-cols-5 gap-2 text-center">
        {steps.map((s) => (
          <div key={s.label} className="rounded-xl border border-slate-200 px-2 py-3"><p className="text-2xl font-bold text-slate-900">{s.value}</p><p className="text-xs text-slate-500">{s.label}</p></div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-5 gap-2 text-center text-sm">
        <span className="self-center text-left text-xs text-slate-500">Taux de conversion</span>
        {funnel.rates.map((r, i) => (
          <span key={i} className="font-semibold text-emerald-600">{r === null ? '—' : `${r.toString().replace('.', ',')} %`}</span>
        ))}
      </div>
    </Card>
  );
}

function AbsencesTab({ data, uid, canAct }: { data: PortfolioData; uid: string; canAct: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = async (id: string) => {
    if (!window.confirm('Terminer cette absence maintenant ? Le télépro pourra de nouveau recevoir des leads.')) return;
    setBusy(id);
    setError(null);
    const r = await sendEndAbsence(id);
    setBusy(null);
    if (!r.ok) setError(r.message);
  };
  return (
    <div className="mt-6 max-w-3xl space-y-5">
      <WorkHoursCard data={data} />
      <Card title="Absences">
        {data.absences.length === 0 && <p className="text-sm text-slate-500">Aucune absence déclarée.</p>}
        <ul className="divide-y divide-slate-100">
          {data.absences.map((a) => {
            const active = isActiveAbsence(a, data.nowMs);
            const future = a.fromMs > data.nowMs;
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span>
                  <span className="font-medium text-slate-900">{ABSENCE_TYPES[a.type] ?? 'Absence'}</span>
                  <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium', active ? 'bg-amber-50 text-amber-700' : future ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500')}>{active ? 'En cours' : future ? 'Programmée' : 'Terminée'}</span>
                  <span className="block text-xs text-slate-500">{date(a.fromMs)} → {date(a.toMs)} · {a.reason}{a.restoreDistribution ? '' : ' · distribution non rétablie au retour'}</span>
                </span>
                {canAct && (active || future) && <button type="button" disabled={busy === a.id} onClick={() => end(a.id)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Terminer</button>}
              </li>
            );
          })}
        </ul>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        {canAct && <Link to={`/utilisateurs/${uid}/absence`} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"><CalendarOff className="h-4 w-4" /> Déclarer une absence</Link>}
      </Card>
    </div>
  );
}

function JournalTab({ uid, role, nowMs }: { uid: string; role: string; nowMs: number }) {
  const [entries, setEntries] = useState<{ id: string; atMs: number; action: string; reason: string | null }[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (role !== 'admin') return; // l'audit est réservé à l'administrateur (règles Firestore)
    return onSnapshot(
      query(collection(db, COL.audit), where('entityId', '==', uid), limit(100)),
      (s) => setEntries(s.docs.map((d) => ({ id: d.id, atMs: ms(d.get('at')) ?? 0, action: String(d.get('action') ?? ''), reason: (d.get('reason') as string | null) ?? null })).sort((a, b) => b.atMs - a.atMs)),
      () => setError(true)
    );
  }, [uid, role]);
  const LABELS: Record<string, string> = { 'profile.update': 'Profil modifié', 'absence.create': 'Absence déclarée', 'absence.end': 'Absence terminée', 'absence.return': 'Retour d’absence', operational_status_changed: 'Statut modifié', 'lead.reassign': 'Lead réattribué' };
  return (
    <div className="mt-6 max-w-3xl">
      <Card title="Journal">
        {role !== 'admin' ? (
          <p className="text-sm text-slate-500">Le journal des actions sensibles est réservé à l’administrateur.</p>
        ) : error ? (
          <p role="alert" className="text-sm text-red-700">Lecture du journal refusée ou indisponible.</p>
        ) : entries === null ? (
          <p className="text-sm text-slate-500">Chargement…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-slate-500">Aucune action enregistrée.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                <span><span className="font-medium text-slate-900">{LABELS[e.action] ?? e.action}</span>{e.reason && <span className="block text-xs text-slate-500">{e.reason}</span>}</span>
                <span className="flex-shrink-0 text-xs text-slate-400">il y a {sinceLabel(e.atMs, nowMs)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const DAY_ROWS: { day: number; label: string }[] = [
  { day: 1, label: 'Lundi' }, { day: 2, label: 'Mardi' }, { day: 3, label: 'Mercredi' }, { day: 4, label: 'Jeudi' }, { day: 5, label: 'Vendredi' }, { day: 6, label: 'Samedi' }, { day: 0, label: 'Dimanche' },
];

/**
 * Horaires de travail du télépro (profil CRM Leads). Sans horaires propres, ce sont ceux de l'entreprise (Paramètres)
 * qui s'appliquent : on le dit, au lieu d'afficher « aucun horaire » alors que le télépro reçoit bien des leads.
 */
function WorkHoursCard({ data }: { data: PortfolioData }) {
  const company = useSettings().sla.schedule;
  const own = data.schedule && data.schedule.weekly.length > 0 ? data.schedule : null;
  const weekly = own?.weekly ?? company.weekly;
  const breaks = own?.breaks ?? [];
  const tz = own?.timezone ?? company.timezone;
  return (
    <Card title="Horaires de travail">
      <p className="text-sm text-slate-600">
        {data.schedule === null ? 'Lecture des horaires…' : own ? <>Horaires propres à ce télépro · {formatWeeklySchedule(weekly)}</> : <>Aucun horaire propre : les <span className="font-medium">horaires de l&apos;entreprise</span> s&apos;appliquent · {formatWeeklySchedule(weekly)}</>}
      </p>
      <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Horaires par jour">
        {DAY_ROWS.map(({ day, label }) => {
          const ranges = weekly.filter((s) => s.day === day).sort((a, b) => a.start.localeCompare(b.start));
          const pauses = breaks.filter((b) => b.day === day);
          return (
            <li key={day} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="w-24 text-slate-800">{label}</span>
              <span className={cn('flex-1', ranges.length ? 'text-slate-900' : 'italic text-slate-400')}>
                {ranges.length ? ranges.map((r) => `${r.start} – ${r.end}`).join(' et ') : 'Fermé'}
                {pauses.length > 0 && <span className="ml-2 text-xs text-slate-500">(pause {pauses.map((p) => `${p.start}–${p.end}`).join(', ')})</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-slate-500">Fuseau horaire : {tz}. Hors de ces plages, le télépro ne reçoit pas de nouveau lead.</p>
    </Card>
  );
}
