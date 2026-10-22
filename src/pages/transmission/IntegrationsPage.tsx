import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Plug, PauseCircle, Bell } from 'lucide-react';
import { cn } from '../../lib/utils';
import { connectorCards, CONNECTOR_STATE_LABELS, watchItems, type ConnectorCard, type ConnectorId, type ConnectorState, type StatusReturnTrace } from '../../domain/integrations/hub';
import { useAuth } from '../../auth/AuthProvider';
import { testMainCrmConnection } from '../../lib/hubApi';
import { ManagerErrorsView } from '../integrations/ManagerErrorsView';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { IntegrationsHeader } from '../integrations/IntegrationsNav';
import { fmtDuration, fmtShort, useJournal, useSchedulerStatus } from '../integrations/useJournal';
import { useNow } from '../leads/useLeadsData';

const STATE_TONE: Record<ConnectorState, string> = {
  operational: 'bg-emerald-50 text-emerald-700',
  attention: 'bg-amber-50 text-amber-700',
  inactive: 'bg-slate-100 text-slate-600',
  not_connected: 'bg-slate-100 text-slate-500',
};

/** Où mène « Voir les détails » : l'écran qui montre ce connecteur. */
const DETAIL_LINK: Partial<Record<ConnectorId, string>> = { webhook: '/integrations/journal?connecteur=webhook', api: '/integrations/journal?connecteur=api', import: '/integrations/journal?connecteur=import', manual: '/integrations/journal?connecteur=manual', crm_main: '/integrations/transmission', scheduler: '/parametres' };

/**
 * Hub d'intégrations (§24, fig. 40) : état réel de chaque connecteur, d'après les traces de réception, de transmission et
 * du planificateur. Un connecteur qui n'existe pas en V1 (Meta, Google, SMS, WhatsApp…) est montré « non connecté » : jamais
 * un faux « opérationnel ».
 */
export function IntegrationsPage() {
  const { user } = useAuth();
  // Un manager ne voit que les erreurs de transmission de son équipe (§24.11) ; le reste du hub est réservé à l'administrateur.
  return user?.role === 'manager' ? <ManagerErrorsView /> : <AdminIntegrations />;
}

function AdminIntegrations() {
  const journal = useJournal();
  const { lastRunAtMs: schedulerAt, statusReturn } = useSchedulerStatus();
  const now = useNow(30_000);
  const cards = useMemo(() => connectorCards(journal.entries, now, schedulerAt), [journal.entries, now, schedulerAt]);
  const watch = useMemo(() => watchItems(journal.entries, now, schedulerAt, statusReturn), [journal.entries, now, schedulerAt, statusReturn]);
  const live = cards.filter((c) => c.def.live);
  const count = (s: ConnectorState) => cards.filter((c) => c.state === s).length;

  return (
    <div className="w-full">
      <IntegrationsHeader title="Intégrations & synchronisations" subtitle="Gérez les connecteurs et suivez l'état des échanges avec vos outils." onRefresh={() => void journal.refresh()} refreshing={journal.loading} updatedAt={journal.fetchedAtMs ? fmtShort(journal.fetchedAtMs) : null} />

      {journal.error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {journal.error}</p>}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Summary icon={<Plug className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" value={live.length} label="connecteurs actifs" sub={`${cards.length - live.length} prévus, non connectés en V1`} />
            <Summary icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" value={count('operational')} label="opérationnels" sub="Fonctionnent correctement" />
            <Summary icon={<AlertTriangle className="h-5 w-5 text-amber-600" />} tone="bg-amber-50" value={count('attention')} label="attention" sub="Nécessitent une vérification" />
            <Summary icon={<PauseCircle className="h-5 w-5 text-slate-500" />} tone="bg-slate-100" value={count('inactive') + count('not_connected')} label="sans activité" sub="Aucune trace, ou non connectés" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => <Card key={c.def.id} c={c} now={now} statusReturn={c.def.id === 'crm_main' ? statusReturn : null} />)}
          </div>
        </div>

        <aside className="h-fit rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center justify-between text-base font-semibold text-slate-900">À surveiller <Bell className="h-4 w-4 text-slate-400" /></h2>
          <p className="text-xs text-slate-500">{watch.length === 0 ? 'Rien à signaler.' : `${watch.length} élément${watch.length > 1 ? 's' : ''} nécessite${watch.length > 1 ? 'nt' : ''} votre attention`}</p>
          <ul className="mt-4 space-y-3">
            {watch.map((w) => (
              <li key={w.id} className="rounded-lg border border-slate-200 p-3">
                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', w.level === 'critical' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700')}>{w.level === 'critical' ? 'Critique' : 'À vérifier'}</span>
                <p className="mt-1.5 text-sm font-medium text-slate-900">{w.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{w.detail}</p>
                <p className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Clock className="h-3 w-3" /> depuis il y a {sinceLabel(w.sinceMs, now)}</p>
                <Link to={w.connector === 'crm_main' ? '/integrations/transmission' : '/integrations/erreurs'} className="mt-2 block rounded-lg border border-blue-300 px-3 py-1.5 text-center text-xs font-medium text-blue-700 hover:bg-blue-50">Voir les détails</Link>
              </li>
            ))}
          </ul>
          <Link to="/integrations/journal" className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm font-medium text-blue-700 hover:underline">Voir tout le journal d’intégration <ChevronRight className="h-4 w-4" /></Link>
          {journal.truncated && <p className="mt-2 text-[11px] text-slate-400">Les traces les plus anciennes ne sont pas lues (lecture bornée).</p>}
        </aside>
      </div>
    </div>
  );
}

function Summary({ icon, tone, value, label, sub }: { icon: React.ReactNode; tone: string; value: number; label: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div className="min-w-0"><p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p><p className="text-xs font-medium text-slate-700">{label}</p><p className="text-[11px] text-slate-400">{sub}</p></div>
    </div>
  );
}

function Card({ c, now, statusReturn }: { c: ConnectorCard; now: number; statusReturn: StatusReturnTrace | null }) {
  const link = DETAIL_LINK[c.def.id];
  const [test, setTest] = useState<{ busy: boolean; text: string | null; ok: boolean }>({ busy: false, text: null, ok: true });
  const runTest = async () => {
    setTest({ busy: true, text: null, ok: true });
    const r = await testMainCrmConnection();
    setTest({ busy: false, ok: r.ok && r.reachable, text: r.ok ? `${r.message} (${fmtDuration(r.ms)})` : r.message });
  };
  return (
    <div className={cn('flex flex-col rounded-xl border bg-white p-4', c.def.live ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50/60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{c.def.label}</h3><p className="text-[11px] text-slate-400">{c.def.family}</p></div>
        <span className={cn('flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', STATE_TONE[c.state])}>{CONNECTOR_STATE_LABELS[c.state]}</span>
      </div>
      <p className="mt-2 text-xs text-slate-500">{c.def.description}</p>
      {c.def.live ? (
        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between gap-2"><dt className="text-slate-500">Dernière activité</dt><dd className="text-slate-800">{c.lastAtMs ? `${fmtShort(c.lastAtMs)} · il y a ${sinceLabel(c.lastAtMs, now)}` : '—'}</dd></div>
          {c.def.id !== 'scheduler' && <div className="flex justify-between gap-2"><dt className="text-slate-500">Volume sur 24 h</dt><dd className="tabular-nums text-slate-800">{c.daily}{c.errors24h > 0 && <span className="ml-1 text-red-600">({c.errors24h} en erreur)</span>}</dd></div>}
          {c.avgDurationMs != null && <div className="flex justify-between gap-2"><dt className="text-slate-500">Délai moyen</dt><dd className="tabular-nums text-slate-800">{fmtDuration(c.avgDurationMs)}</dd></div>}
          {c.lastFailureAtMs && <div className="flex justify-between gap-2"><dt className="text-slate-500">Dernier échec</dt><dd className="text-slate-800">{fmtShort(c.lastFailureAtMs)}</dd></div>}
        </dl>
      ) : <p className="mt-3 text-xs text-slate-400">Hors V1 : aucune trace, aucun envoi.</p>}
      {c.def.id === 'crm_main' && (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs" aria-label="Retour des statuts">
          <p className="font-medium text-slate-700">Retour des statuts</p>
          {statusReturn ? (
            <p className={cn('mt-0.5', statusReturn.errorCount > 0 ? 'text-red-700' : 'text-slate-600')}>Dernier passage {fmtShort(statusReturn.atMs)} · {statusReturn.read} dossier{statusReturn.read > 1 ? 's' : ''} lu{statusReturn.read > 1 ? 's' : ''}, {statusReturn.changed} étape{statusReturn.changed > 1 ? 's' : ''} changée{statusReturn.changed > 1 ? 's' : ''}{statusReturn.cancelled > 0 ? `, ${statusReturn.cancelled} annulée${statusReturn.cancelled > 1 ? 's' : ''}` : ''} · {fmtDuration(statusReturn.durationMs)}{statusReturn.errorCount > 0 ? ` · ${statusReturn.errorCount} erreur${statusReturn.errorCount > 1 ? 's' : ''}` : ''}</p>
          ) : <p className="mt-0.5 text-slate-500">Aucun passage enregistré pour le moment.</p>}
          <button type="button" onClick={() => void runTest()} disabled={test.busy} className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60">{test.busy ? 'Test en cours…' : 'Tester la connexion'}</button>
          {test.text && <p role="status" className={cn('mt-1', test.ok ? 'text-emerald-700' : 'text-red-700')}>{test.text}</p>}
        </div>
      )}
      {link && <Link to={link} className="mt-auto inline-flex items-center justify-between rounded-lg border border-blue-300 px-3 py-1.5 pt-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50" style={{ marginTop: 12 }}>Voir les détails <ChevronRight className="h-4 w-4" /></Link>}
    </div>
  );
}
