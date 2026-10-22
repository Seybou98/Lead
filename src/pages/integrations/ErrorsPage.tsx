import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCw, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';
import { CONNECTOR_LABEL, CONNECTORS, errorCategory, errorList, errorSummary, priorityOf, PRIORITY_LABELS, type ConnectorId, type JournalEntry } from '../../domain/integrations/hub';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { replayRawLead } from '../../lib/hubApi';
import { useNow } from '../leads/useLeadsData';
import { inputCls } from '../settings/settingsUi';
import { IntegrationsHeader } from './IntegrationsNav';
import { Detail } from './JournalPage';
import { fmtShort, useJournal } from './useJournal';

/**
 * Erreurs et reprises (§24.9, fig. 42) : ce qui est bloqué, pourquoi, et la reprise. Seules les erreurs de réception sont
 * rejouables ici (donnée d'origine intacte, correction du contact possible) ; une transmission au CRM principal se reprend
 * sur l'écran Transmission, qui connaît le dossier. Une erreur n'efface jamais le lead : la donnée brute reste conservée.
 */
export function ErrorsPage() {
  const journal = useJournal();
  const now = useNow(60_000);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [connector, setConnector] = useState<ConnectorId | ''>('');
  const [selected, setSelected] = useState<JournalEntry | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });

  const summary = useMemo(() => errorSummary(journal.entries, now), [journal.entries, now]);
  const list = useMemo(() => errorList(journal.entries, tab).filter((e) => !connector || e.connector === connector), [journal.entries, tab, connector]);
  const replayable = list.filter((e) => e.replayable);
  const picked = replayable.filter((e) => checked.has(e.id));

  const toggle = (id: string) => setChecked((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const replaySelection = async () => {
    setBulk({ busy: true, text: null });
    let ok = 0;
    const failures: string[] = [];
    for (const e of picked) {
      // Une reprise après l'autre : chacune est tracée et peut échouer sans empêcher les suivantes.
      const r = await replayRawLead(e.sourceId);
      if (r.ok) ok += 1;
      else failures.push(`${e.reference} : ${r.message}`);
    }
    setBulk({ busy: false, text: `${ok} reprise${ok > 1 ? 's' : ''} réussie${ok > 1 ? 's' : ''}${failures.length ? `, ${failures.length} refusée${failures.length > 1 ? 's' : ''} (${failures.slice(0, 2).join(' ; ')}${failures.length > 2 ? '…' : ''})` : ''}.` });
    setChecked(new Set());
    await journal.refresh();
  };

  return (
    <div className="w-full">
      <IntegrationsHeader title="Erreurs & reprises" subtitle="Corrigez les échanges bloqués sans perdre aucune donnée." onRefresh={() => void journal.refresh()} refreshing={journal.loading} updatedAt={journal.fetchedAtMs ? fmtShort(journal.fetchedAtMs) : null} />
      {journal.error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {journal.error}</p>}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<AlertTriangle className="h-5 w-5 text-red-600" />} tone="bg-red-50" value={summary.open} label="erreurs actives" sub="En cours de traitement" />
        <Stat icon={<RotateCw className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" value={summary.replayable} label="reprises possibles ici" sub="Données de réception refusées" />
        <Stat icon={<Wrench className="h-5 w-5 text-amber-600" />} tone="bg-amber-50" value={summary.critical} label="critiques" sub="Tentatives épuisées, plus d’un jour, ou CRM principal" />
        <Stat icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" value={summary.resolvedThisMonth} label="résolues ce mois" sub="Reprises depuis ce hub" />
      </div>

      <div className={cn('mt-5 grid gap-5', selected && 'xl:grid-cols-[minmax(0,1fr)_380px]')}>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Erreurs" className="flex rounded-lg border border-slate-200 p-0.5 text-sm">
              {([['open', 'À traiter'], ['resolved', 'Résolues']] as const).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => { setTab(k); setChecked(new Set()); setSelected(null); }} className={cn('rounded-md px-4 py-1.5 font-medium', tab === k ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{label}</button>
              ))}
            </div>
            <select aria-label="Connecteur" value={connector} onChange={(e) => setConnector(e.target.value as ConnectorId | '')} className={inputCls}>
              <option value="">Tous les connecteurs</option>
              {CONNECTORS.filter((c) => c.live).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {tab === 'open' && (
              <button type="button" disabled={picked.length === 0 || bulk.busy} onClick={() => void replaySelection()} className="inline-flex items-center gap-2 rounded-lg border border-blue-300 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"><RotateCw className={cn('h-4 w-4', bulk.busy && 'animate-spin')} /> Relancer la sélection ({picked.length})</button>
            )}
          </div>
          {bulk.text && <p role="status" className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{bulk.text}</p>}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="w-8 py-2" /><th className="py-2 pr-3 font-medium">Priorité</th><th className="py-2 pr-3 font-medium">Depuis</th><th className="py-2 pr-3 font-medium">Connecteur</th><th className="py-2 pr-3 font-medium">Référence</th><th className="py-2 pr-3 font-medium">Erreur</th><th className="py-2 text-right font-medium">Tentatives</th></tr></thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-slate-500">{journal.loading ? 'Chargement…' : tab === 'open' ? 'Aucune erreur à traiter.' : 'Aucune erreur résolue.'}</td></tr>}
                {list.map((e) => {
                  const p = priorityOf(e, now);
                  return (
                    <tr key={e.id} onClick={() => setSelected(e)} className={cn('cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50', selected?.id === e.id && 'bg-blue-50/60')}>
                      <td className="py-2.5" onClick={(ev) => ev.stopPropagation()}>{e.replayable && tab === 'open' && <input type="checkbox" aria-label={`Sélectionner ${e.reference}`} checked={checked.has(e.id)} onChange={() => toggle(e.id)} />}</td>
                      <td className="py-2.5 pr-3"><span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', p === 'critical' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700')}>{PRIORITY_LABELS[p]}</span></td>
                      <td className="py-2.5 pr-3 text-slate-600" title={fmtShort(e.atMs)}>il y a {sinceLabel(e.atMs, now)}</td>
                      <td className="py-2.5 pr-3 text-slate-900">{CONNECTOR_LABEL[e.connector]}</td>
                      <td className="max-w-[140px] truncate py-2.5 pr-3 font-mono text-xs text-blue-700" title={e.reference}>{e.reference}</td>
                      <td className="py-2.5 pr-3"><span className="block font-medium text-slate-900">{e.error?.message}</span><span className="block text-xs text-slate-500">{errorCategory(e)}</span></td>
                      <td className="py-2.5 text-right tabular-nums text-slate-600">{e.attempts ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        {selected && <Detail entry={selected} onClose={() => setSelected(null)} onReplayed={() => { setSelected(null); void journal.refresh(); }} />}
      </div>
    </div>
  );
}

function Stat({ icon, tone, value, label, sub }: { icon: React.ReactNode; tone: string; value: number; label: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div className="min-w-0"><p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p><p className="text-xs font-medium text-slate-700">{label}</p><p className="text-[11px] text-slate-400">{sub}</p></div>
    </div>
  );
}
