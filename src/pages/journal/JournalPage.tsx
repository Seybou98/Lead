import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Info, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { buildJournalRows, explainDecision, filterJournalRows, journalToCsv, type JournalFilters, type JournalRow } from '../../domain/admin/journal';
import { PERIOD_LABELS, periodRange, type PeriodKey } from '../../domain/admin/period';
import { downloadText } from '../../domain/csv';
import { DISTRIBUTION_EVENT_LABELS } from '../../domain/labels';
import { JOURNAL_READ_LIMIT, useJournalData, type JournalData } from './useJournalData';

const PAGE_SIZES = [10, 25, 50];
const selectClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
const time = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

export function JournalPage() {
  const [period, setPeriod] = useState<PeriodKey>('today');
  const nowMs = useMemo(() => Date.now(), []);
  const range = useMemo(() => periodRange(period, nowMs), [period, nowMs]);
  return <JournalView data={useJournalData(range.fromMs)} period={period} onPeriodChange={setPeriod} nowMs={nowMs} />;
}

export function JournalView({ data, period, onPeriodChange, nowMs }: { data: JournalData; period: PeriodKey; onPeriodChange: (p: PeriodKey) => void; nowMs: number }) {
  const [params] = useSearchParams();
  const [campaignId, setCampaignId] = useState<string>(params.get('campagne') ?? 'all');
  const [ownerId, setOwnerId] = useState<string>('all');
  const [event, setEvent] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const range = useMemo(() => periodRange(period, nowMs), [period, nowMs]);
  const allRows = useMemo(() => buildJournalRows(data.entries, data.names), [data.entries, data.names]);
  const filters: JournalFilters = { fromMs: range.fromMs, toMs: range.toMs, campaignId, ownerId, event, search };
  const rows = useMemo(() => filterJournalRows(allRows, filters), [allRows, range.fromMs, range.toMs, campaignId, ownerId, event, search]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);

  const open = openId ? (data.entries.find((e) => e.id === openId) ?? null) : null;
  const explanation = useMemo(() => (open ? explainDecision(open, data.names) : null), [open, data.names]);
  const openRow = open ? allRows.find((r) => r.id === open.id) : null;

  // Listes déroulantes : uniquement ce qui apparaît dans le journal chargé.
  const campaigns = [...new Set(data.entries.map((e) => e.campaignId).filter((c): c is string => !!c))];
  const owners = [...new Set(data.entries.map((e) => e.chosenOwnerId).filter((c): c is string => !!c))];
  const events = [...new Set(data.entries.map((e) => e.event))];
  const reset = (fn: () => void) => { fn(); setPage(1); };
  const isToday = period === 'today';

  const exportCsv = () => downloadText(`journal-distribution-${new Date().toISOString().slice(0, 10)}.csv`, journalToCsv(rows));

  const statusBadge = (r: JournalRow) =>
    r.status === 'success' ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Réussie</span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />En attente</span>
    );

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold text-slate-900">Journal de distribution</h1>
      <p className="mt-1 text-slate-500">Comprenez chaque attribution et réattribution effectuée par le moteur.</p>

      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}
      {data.truncated && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4" /> Plus de {JOURNAL_READ_LIMIT} décisions sur cette période : seules les plus récentes sont affichées. Choisissez une période plus courte.
        </p>
      )}

      <section className="mt-5 rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <select aria-label="Période" className={selectClass} value={period} onChange={(e) => reset(() => onPeriodChange(e.target.value as PeriodKey))}>
            {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
              <option key={k} value={k}>{PERIOD_LABELS[k]}</option>
            ))}
          </select>
          <select aria-label="Campagne" className={selectClass} value={campaignId} onChange={(e) => reset(() => setCampaignId(e.target.value))}>
            <option value="all">Toutes les campagnes</option>
            {campaigns.map((c) => (
              <option key={c} value={c}>{data.names.campaigns.get(c) ?? c}</option>
            ))}
          </select>
          <select aria-label="Télépro" className={selectClass} value={ownerId} onChange={(e) => reset(() => setOwnerId(e.target.value))}>
            <option value="all">Tous les télépros</option>
            {owners.map((o) => (
              <option key={o} value={o}>{data.names.users.get(o) ?? o}</option>
            ))}
          </select>
          <select aria-label="Événement" className={selectClass} value={event} onChange={(e) => reset(() => setEvent(e.target.value))}>
            <option value="all">Tous les événements</option>
            {events.map((e) => (
              <option key={e} value={e}>{DISTRIBUTION_EVENT_LABELS[e] ?? e}</option>
            ))}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input type="search" value={search} onChange={(e) => reset(() => setSearch(e.target.value))} placeholder="Lead, client ou identifiant" aria-label="Rechercher un lead" className="w-60 rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <button type="button" onClick={exportCsv} disabled={rows.length === 0} className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            <Download className="h-4 w-4" /> Exporter le journal
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {['Heure', 'Lead', 'Campagne', 'Événement', 'Télépro', 'Motif', 'Statut'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.loading && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">Chargement…</td></tr>}
              {!data.loading && pageRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    {allRows.length === 0 ? 'Aucune décision de distribution sur cette période.' : 'Aucun résultat pour ces filtres.'}
                  </td>
                </tr>
              )}
              {pageRows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className={cn('cursor-pointer hover:bg-slate-50', openId === r.id && 'bg-blue-50/60')}>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-700">{isToday ? time(r.atMs) : `${day(r.atMs)} ${time(r.atMs)}`}</td>
                  <td className="px-3 py-3 font-medium text-slate-900">{r.leadLabel}</td>
                  <td className="px-3 py-3 text-slate-700">{r.campaignName}</td>
                  <td className="px-3 py-3 text-slate-700">{r.eventLabel}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-700">{r.ownerName}</td>
                  <td className="px-3 py-3 text-slate-700">{r.motif}</td>
                  <td className="px-3 py-3">{statusBadge(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
          <span>{rows.length === 0 ? 'Aucun événement' : `Affichage de ${(current - 1) * pageSize + 1} à ${Math.min(current * pageSize, rows.length)} sur ${rows.length} événement${rows.length > 1 ? 's' : ''}`}</span>
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

      {open && explanation && openRow && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpenId(null)} aria-hidden="true" />
          <aside role="dialog" aria-label={`Décision ${openRow.leadLabel}`} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Décision — {openRow.leadLabel.split(' — ')[0]}</h2>
              <button type="button" onClick={() => setOpenId(null)} aria-label="Fermer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <section>
                <h3 className="text-sm font-semibold text-slate-900">Chronologie de la décision</h3>
                <p className="mt-0.5 text-xs text-slate-500">{new Date(open.atMs).toLocaleString('fr-FR')}</p>
                <ol className="mt-3 space-y-4 border-l-2 border-blue-100 pl-4">
                  {explanation.timeline.map((t) => (
                    <li key={t.title} className="relative">
                      <span className="absolute -left-[22px] top-1 h-2.5 w-2.5 rounded-full bg-blue-500" />
                      <p className="text-sm font-medium text-slate-900">{t.title}</p>
                      <p className="text-sm text-slate-600">{t.detail}</p>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-900">Télépros évalués</h3>
                {explanation.evaluated.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">Aucun télépro n'a été évalué pour cette décision.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {explanation.evaluated.map((c) => (
                      <li key={c.uid} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">{initials(c.name)}</span>
                        <div className="flex-1">
                          <p className="font-medium text-slate-800">{c.name}</p>
                          <p className={cn('text-xs', c.tag === 'excluded' ? 'text-red-600' : 'text-emerald-600')}>{c.detail}</p>
                        </div>
                        <span className="text-slate-600">{c.load}</span>
                        <span className={cn('w-16 rounded-md px-2 py-1 text-center text-xs font-medium', c.tag === 'retained' ? 'bg-emerald-50 text-emerald-700' : c.tag === 'excluded' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500')}>
                          {c.tag === 'retained' ? 'Retenue' : c.tag === 'excluded' ? 'Exclue' : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {explanation.whyTitle && (
                <section className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-blue-900"><Info className="h-4 w-4" />{explanation.whyTitle}</h3>
                  <ul className="mt-2 space-y-1.5">
                    {explanation.why.map((w) => (
                      <li key={w} className="flex items-start gap-2 text-sm text-blue-900"><CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />{w}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-5 py-4">
              <Link to={`/leads/${open.leadId}`} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                Ouvrir le lead <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              {open.campaignId && (
                <Link to="/campagnes" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                  Voir la campagne <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              )}
              <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <Download className="h-3.5 w-3.5" /> Exporter le journal
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
