import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Download, RotateCw, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { downloadText, toCsv } from '../../domain/csv';
import { CONNECTOR_LABEL, CONNECTORS, diagnosticRows, ENTRY_STATUS_LABELS, filterEntries, NO_FILTERS, PERIOD_FILTER_LABELS, statsOf, type ConnectorId, type EntryStatus, type JournalEntry, type JournalFilters, type PeriodFilter } from '../../domain/integrations/hub';
import { useNow } from '../leads/useLeadsData';
import { inputCls } from '../settings/settingsUi';
import { IntegrationsHeader } from './IntegrationsNav';
import { fmtDateTime, fmtShort, useJournal } from './useJournal';
import { replayRawLead } from '../../lib/hubApi';

const PAGE = 25;
export const STATUS_PILL: Record<EntryStatus, string> = { success: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700', error: 'bg-red-50 text-red-700' };

/** Journal des synchronisations (§24.10, fig. 41) : toutes les traces réelles, filtrables, avec le détail et la charge utile masquée. */
export function JournalPage() {
  const journal = useJournal();
  const now = useNow(60_000);
  const [params] = useSearchParams();
  const initialConnector = (params.get('connecteur') ?? '') as ConnectorId | '';
  const [filters, setFilters] = useState<JournalFilters>({ ...NO_FILTERS, period: initialConnector ? '30d' : 'today', connector: CONNECTORS.some((c) => c.id === initialConnector) ? initialConnector : '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<JournalEntry | null>(null);

  const set = (patch: Partial<JournalFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const filtered = useMemo(() => filterEntries(journal.entries, filters, now), [journal.entries, filters, now]);
  const stats = useMemo(() => statsOf(filtered), [filtered]);
  const operations = useMemo(() => [...new Set(journal.entries.map((e) => e.operation))].sort(), [journal.entries]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const rows = filtered.slice((page - 1) * PAGE, page * PAGE);
  const exportCsv = () => downloadText(`diagnostic-integrations-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Diagnostic des intégrations (sans charge utile)'], diagnosticRows(filtered)));

  return (
    <div className="w-full">
      <IntegrationsHeader title="Journal des synchronisations" subtitle="Historique des échanges entre le CRM Leads et vos outils : réception des leads, import, saisie manuelle, transmission au CRM principal." onRefresh={() => void journal.refresh()} refreshing={journal.loading} updatedAt={journal.fetchedAtMs ? fmtShort(journal.fetchedAtMs) : null} />
      {journal.error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {journal.error}</p>}
      {journal.truncated && <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Lecture bornée : seules les traces les plus récentes sont chargées. Les plus anciennes ne figurent pas dans ce journal.</p>}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card icon={<Clock className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" value={String(stats.total)} label={`opérations (${PERIOD_FILTER_LABELS[filters.period].toLowerCase()})`} />
        <Card icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" value={stats.successRate === null ? '—' : `${stats.successRate.toLocaleString('fr-FR')} %`} label="réussies" />
        <Card icon={<Clock className="h-5 w-5 text-amber-600" />} tone="bg-amber-50" value={String(stats.pending)} label="en attente" />
        <Card icon={<AlertTriangle className="h-5 w-5 text-red-600" />} tone="bg-red-50" value={String(stats.error)} label="en erreur" />
      </div>

      <div className={cn('mt-5 grid gap-5', selected && 'xl:grid-cols-[minmax(0,1fr)_380px]')}>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="block"><span className="text-xs text-slate-500">Période</span>
              <select aria-label="Période" value={filters.period} onChange={(e) => set({ period: e.target.value as PeriodFilter })} className={cn(inputCls, 'mt-1 block')}>{(Object.keys(PERIOD_FILTER_LABELS) as PeriodFilter[]).map((p) => <option key={p} value={p}>{PERIOD_FILTER_LABELS[p]}</option>)}</select>
            </label>
            <label className="block"><span className="text-xs text-slate-500">Connecteur</span>
              <select aria-label="Connecteur" value={filters.connector} onChange={(e) => set({ connector: e.target.value as ConnectorId | '' })} className={cn(inputCls, 'mt-1 block')}><option value="">Tous les connecteurs</option>{CONNECTORS.filter((c) => c.live).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            </label>
            <label className="block"><span className="text-xs text-slate-500">Type d’opération</span>
              <select aria-label="Type d’opération" value={filters.operation} onChange={(e) => set({ operation: e.target.value })} className={cn(inputCls, 'mt-1 block')}><option value="">Tous</option>{operations.map((o) => <option key={o}>{o}</option>)}</select>
            </label>
            <label className="block"><span className="text-xs text-slate-500">Statut</span>
              <select aria-label="Statut" value={filters.status} onChange={(e) => set({ status: e.target.value as EntryStatus | '' })} className={cn(inputCls, 'mt-1 block')}><option value="">Tous les statuts</option>{(Object.keys(ENTRY_STATUS_LABELS) as EntryStatus[]).map((s) => <option key={s} value={s}>{ENTRY_STATUS_LABELS[s]}</option>)}</select>
            </label>
            <label className="block min-w-[200px] flex-1"><span className="text-xs text-slate-500">Rechercher (lead, identifiant externe, trace)</span>
              <span className="relative mt-1 block"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input aria-label="Rechercher" value={filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Rechercher…" className={cn(inputCls, 'w-full pl-8')} /></span>
            </label>
            <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> Exporter</button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3 font-medium">Date & heure</th><th className="py-2 pr-3 font-medium">Connecteur</th><th className="py-2 pr-3 font-medium">Opération</th><th className="py-2 pr-3 font-medium">Référence</th><th className="py-2 pr-3 font-medium">Statut</th><th className="py-2 text-right font-medium">Tentatives</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-slate-500">{journal.loading ? 'Chargement…' : 'Aucune opération pour ces filtres.'}</td></tr>}
                {rows.map((e) => (
                  <tr key={e.id} onClick={() => setSelected(e)} className={cn('cursor-pointer border-b border-slate-100 hover:bg-slate-50', selected?.id === e.id && 'bg-blue-50/60')}>
                    <td className="py-2.5 pr-3 tabular-nums text-slate-700">{fmtDateTime(e.atMs)}</td>
                    <td className="py-2.5 pr-3 text-slate-900">{CONNECTOR_LABEL[e.connector]}{e.sourceLabel && <span className="block text-xs text-slate-500">{e.sourceLabel}</span>}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{e.operation}</td>
                    <td className="max-w-[160px] truncate py-2.5 pr-3 font-mono text-xs text-slate-600" title={e.reference}>{e.reference}</td>
                    <td className="py-2.5 pr-3"><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_PILL[e.status])}>{ENTRY_STATUS_LABELS[e.status]}</span>{e.resolvedAtMs !== null && <span className="ml-1.5 text-[11px] text-emerald-600">reprise</span>}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-600">{e.attempts ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>{filtered.length === 0 ? '0 opération' : `${(page - 1) * PAGE + 1} à ${Math.min(page * PAGE, filtered.length)} sur ${filtered.length}`}</span>
            <span className="inline-flex items-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Précédent</button>
              <span>{page} / {pages}</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Suivant</button>
            </span>
          </div>
        </section>

        {selected && <Detail entry={selected} onClose={() => setSelected(null)} onReplayed={() => void journal.refresh()} />}
      </div>
    </div>
  );
}

function Card({ icon, tone, value, label }: { icon: React.ReactNode; tone: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div><p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p><p className="text-xs text-slate-500">{label}</p></div>
    </div>
  );
}

/** Détail d'une opération (fig. 41) : identité, erreur, charge utile masquée, actions. */
export function Detail({ entry, onClose, onReplayed }: { entry: JournalEntry; onClose: () => void; onReplayed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const contactFix = entry.error?.code === 'no_contact';

  const replay = async () => {
    setBusy(true);
    setNotice(null);
    const r = await replayRawLead(entry.sourceId, contactFix ? { phone: phone.trim() || undefined, email: email.trim() || undefined } : {});
    setBusy(false);
    setNotice({ kind: r.ok ? 'ok' : 'error', text: r.message });
    if (r.ok) onReplayed();
  };

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5 text-sm"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-all text-right text-slate-900">{value}</dd></div>
  );
  return (
    <aside className="h-fit rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Détail de l’opération</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </div>
      <span className={cn('mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_PILL[entry.status])}>{ENTRY_STATUS_LABELS[entry.status]}</span>
      <dl className="mt-3">
        {row('Identifiant de corrélation', <span className="font-mono text-xs">{entry.id}</span>)}
        {row('Date', fmtDateTime(entry.atMs))}
        {row('Connecteur', CONNECTOR_LABEL[entry.connector] + (entry.sourceLabel ? ` · ${entry.sourceLabel}` : ''))}
        {row('Opération', entry.operation)}
        {row('Référence', <span className="font-mono text-xs">{entry.reference}</span>)}
        {entry.attempts !== null && row('Tentatives', entry.attempts)}
        {entry.actorId && row('Acteur', entry.actorId)}
        {entry.resolvedAtMs !== null && row('Reprise le', fmtDateTime(entry.resolvedAtMs))}
      </dl>
      {entry.error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"><span className="font-semibold">{entry.error.code}</span> — {entry.error.message}</p>}
      {entry.payload && (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-500">Aperçu de la charge utile (secrets masqués)</p>
          <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{entry.payload}</pre>
        </div>
      )}

      {entry.replayable && (
        <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3">
          {contactFix && (
            <>
              <p className="text-xs text-slate-600">Complétez le contact manquant : la donnée d’origine reste intacte, seule la reprise utilise la correction.</p>
              <input aria-label="Téléphone corrigé" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Téléphone" className={cn(inputCls, 'w-full')} />
              <input aria-label="Email corrigé" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className={cn(inputCls, 'w-full')} />
            </>
          )}
          <button type="button" onClick={() => void replay()} disabled={busy || (contactFix && !phone.trim() && !email.trim())} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><RotateCw className={cn('h-4 w-4', busy && 'animate-spin')} /> {busy ? 'Reprise…' : 'Relancer maintenant'}</button>
        </div>
      )}
      {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-3 rounded-lg border px-3 py-2 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>{notice.text}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {entry.leadId && <Link to={`/leads/${entry.leadId}`} className="rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50">Ouvrir le lead</Link>}
        {entry.connector === 'crm_main' && <Link to="/integrations/transmission" className="rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50">Ouvrir la transmission</Link>}
      </div>
    </aside>
  );
}
