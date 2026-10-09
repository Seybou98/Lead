import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, ExternalLink, Eye, FileText, Folder, History, RefreshCw, Send, Share2, ShieldCheck, UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { evaluateControls } from '../../domain/conversion/controls';
import { formatEuros } from '../../domain/conversion/finance';
import { buildLeadRows, type LeadRow } from '../../domain/leads/leadList';
import { buildTxBoard, monthRange, NO_TX_FILTERS, TX_STATUS_LABELS, txStatusOf, txSteps, type TxFilters, type TxStatus } from '../../domain/transmission/board';
import { sendConversionAction } from '../../lib/conversionApi';
import { Modal } from '../../components/ui/Modal';
import { Feedback, inputCls } from '../settings/settingsUi';
import { LEAD_LIST_LIMIT, useLeadsList, useNow, type LeadsListData } from '../leads/useLeadsData';
import { LevelIcon, whenLabel } from '../sale/saleUi';
import { useSaleData } from '../sale/useSaleData';
import { useSettings } from '../settings/useSettings';

const MAIN_CRM_URL = (import.meta.env.VITE_MAIN_CRM_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
const dateInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fromDateInput = (v: string, end: boolean): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  return end ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime();
};

const STATUS_PILL: Record<TxStatus, { dot: string; text: string }> = {
  ready: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  blocked: { dot: 'bg-red-500', text: 'text-red-700' },
  pending: { dot: 'bg-amber-500', text: 'text-amber-700' },
  done: { dot: 'bg-blue-500', text: 'text-blue-700' },
};

function Kpi({ icon, tone, value, label, sub }: { icon: React.ReactNode; tone: string; value: string; label: string; sub: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5">
      <span className={cn('flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl', tone)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-3xl font-bold leading-none text-slate-900">{value}</p>
        <p className="mt-1 text-sm font-medium text-slate-800">{label}</p>
        <p className="text-xs text-slate-500">{sub}</p>
      </div>
    </div>
  );
}

export function TransmissionPage() {
  const { user } = useAuth();
  const role = user?.role ?? 'admin';
  return <TransmissionView data={useLeadsList(role, user?.uid ?? '')} canRetry={role === 'admin' || role === 'manager'} />;
}

export function TransmissionView({ data, canRetry, nowOverride }: { data: LeadsListData; canRetry: boolean; nowOverride?: number }) {
  const navigate = useNavigate();
  const liveNow = useNow(30_000);
  const now = nowOverride ?? liveNow;
  const month = useMemo(() => monthRange(now), [now]);
  const [filters, setFilters] = useState<TxFilters>({ ...NO_TX_FILTERS, ...month });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => buildLeadRows(data.items, data.names), [data.items, data.names]);
  const board = useMemo(() => buildTxBoard(rows, filters, month), [rows, filters, month]);
  const owners = useMemo(() => [...new Map(board.rows.filter((r) => r.ownerId).map((r) => [r.ownerId as string, r.ownerName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr')), [board.rows]);
  const pages = Math.max(1, Math.ceil(board.filtered.length / pageSize));
  const current = Math.min(page, pages);
  const visible = board.filtered.slice((current - 1) * pageSize, current * pageSize);
  const selected = board.rows.find((r) => r.id === selectedId) ?? board.filtered[0] ?? null;

  const set = (patch: Partial<TxFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const retry = async (leadId: string) => {
    setBusy(leadId);
    setNotice(null);
    const r = await sendConversionAction(leadId, { kind: 'transmit' });
    setBusy(null);
    setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
    if (!r.ok && /existe déjà/.test(r.message)) setSelectedId(leadId);
  };

  const actionOf = (r: LeadRow): { label: string; primary: boolean; run: () => void } => {
    const s = txStatusOf(r) as TxStatus;
    if (s === 'ready') return { label: 'Créer la vente', primary: true, run: () => navigate(`/dossiers/${r.id}`) };
    if (s === 'blocked' && r.status === 'transmission_error' && canRetry) return { label: busy === r.id ? 'Reprise…' : 'Réessayer', primary: true, run: () => void retry(r.id) };
    if (s === 'blocked') return { label: 'Voir les blocages', primary: false, run: () => setSelectedId(r.id) };
    return { label: 'Ouvrir', primary: false, run: () => navigate(`/dossiers/${r.id}`) };
  };

  const last = board.lastDone;
  const lastUrl = last?.conversion?.dossierId && MAIN_CRM_URL ? `${MAIN_CRM_URL}/dossier/${last.conversion.dossierId}` : null;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Transmission au CRM principal</h1>
          <p className="mt-1 text-slate-500">Transmettez vos dossiers validés et suivez leur synchronisation avec le CRM principal.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600" role="status">
          <RefreshCw className="h-4 w-4" /> Dernière mise à jour : {new Date(now).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
      {data.truncated && <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Seuls les {LEAD_LIST_LIMIT} leads les plus récents sont chargés : les chiffres peuvent être incomplets.</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Send className="h-7 w-7 text-emerald-600" />} tone="bg-emerald-50" value={String(board.kpis.done)} label="transmis ce mois" sub={`Du ${new Date(month.fromMs).toLocaleDateString('fr-FR')} au ${new Date(month.toMs).toLocaleDateString('fr-FR')}`} />
        <Kpi icon={<CheckCircle2 className="h-7 w-7 text-emerald-600" />} tone="bg-emerald-50" value={board.kpis.successRate === null ? '—' : `${board.kpis.successRate}%`.replace('.', ',')} label="taux de réussite" sub="Transmis sur transmis + en erreur" />
        <Kpi icon={<Clock className="h-7 w-7 text-orange-500" />} tone="bg-orange-50" value={String(board.kpis.pending)} label="en attente" sub="Validation ou traitement en cours" />
        <Kpi icon={<AlertTriangle className="h-7 w-7 text-red-500" />} tone="bg-red-50" value={String(board.kpis.blocked)} label="bloqué" sub="Action requise" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {selected && <StepsStrip row={selected} />}

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-900">Dossiers à transmettre</h2>
            <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
              <label className="block"><span className="mb-1 block text-xs text-slate-500">Statut</span>
                <select aria-label="Statut" className={cn(inputCls, 'w-36')} value={filters.status} onChange={(e) => set({ status: e.target.value as TxStatus | '' })}>
                  <option value="">Tous</option>
                  {(Object.keys(TX_STATUS_LABELS) as TxStatus[]).map((s) => <option key={s} value={s}>{TX_STATUS_LABELS[s]}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-xs text-slate-500">Produit</span>
                <select aria-label="Produit" className={cn(inputCls, 'w-36')} value={filters.product} onChange={(e) => set({ product: e.target.value })}>
                  <option value="">Tous</option>
                  {board.products.map((p) => <option key={p}>{p}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-xs text-slate-500">Télépro</span>
                <select aria-label="Télépro" className={cn(inputCls, 'w-44')} value={filters.owner} onChange={(e) => set({ owner: e.target.value })}>
                  <option value="">Tous</option>
                  {owners.map(([uid, name]) => <option key={uid} value={uid}>{name}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-xs text-slate-500">Du</span>
                <input aria-label="Du" type="date" className={inputCls} value={filters.fromMs === null ? '' : dateInput(filters.fromMs)} onChange={(e) => set({ fromMs: fromDateInput(e.target.value, false) })} /></label>
              <label className="block"><span className="mb-1 block text-xs text-slate-500">Au</span>
                <input aria-label="Au" type="date" className={inputCls} value={filters.toMs === null ? '' : dateInput(filters.toMs)} onChange={(e) => set({ toMs: fromDateInput(e.target.value, true) })} /></label>
              <button type="button" onClick={() => set({ ...NO_TX_FILTERS, ...month })} className="inline-flex items-center gap-1.5 pb-2 text-sm font-medium text-blue-700 hover:underline"><RefreshCw className="h-4 w-4" /> Réinitialiser</button>
            </div>

            <Feedback errors={[]} notice={notice} />

            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-medium text-slate-500">
                  <tr><th className="px-3 py-2.5">Client</th><th className="px-3 py-2.5">Lead ID</th><th className="px-3 py-2.5">Produit</th><th className="px-3 py-2.5">Télépro</th><th className="px-3 py-2.5">Contrôles</th><th className="px-3 py-2.5">Statut</th><th className="px-3 py-2.5 text-right">Action</th></tr>
                </thead>
                <tbody>
                  {visible.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">{data.loading ? 'Chargement…' : 'Aucun dossier pour ces filtres.'}</td></tr>}
                  {visible.map((r) => {
                    const s = txStatusOf(r) as TxStatus;
                    const a = actionOf(r);
                    const m = r.montage;
                    const ok = m && typeof m.validated === 'number' && typeof m.total === 'number';
                    return (
                      <tr key={r.id} onClick={() => setSelectedId(r.id)} className={cn('cursor-pointer border-t border-slate-100 hover:bg-slate-50', selected?.id === r.id && 'bg-blue-50/50')}>
                        <td className="px-3 py-3"><span className="flex items-center gap-2.5"><span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">{initials(r.fullName)}</span><span className="font-medium text-slate-900">{r.fullName || 'Sans nom'}</span></span></td>
                        <td className="px-3 py-3 tabular-nums text-slate-600" title={r.id}>{r.id.slice(0, 10)}</td>
                        <td className="px-3 py-3 text-slate-700">{r.productCode ?? '—'}</td>
                        <td className="px-3 py-3 text-slate-700">{r.ownerName}</td>
                        <td className={cn('px-3 py-3 font-semibold tabular-nums', ok ? (m.validated === m.total ? 'text-emerald-600' : 'text-orange-600') : 'text-slate-400')}>{ok ? `${m.validated}/${m.total}` : '—'}</td>
                        <td className="px-3 py-3"><span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', STATUS_PILL[s].text)}><span className={cn('h-2 w-2 rounded-full', STATUS_PILL[s].dot)} />{TX_STATUS_LABELS[s]}</span></td>
                        <td className="px-3 py-3 text-right">
                          <button type="button" disabled={busy === r.id} onClick={(e) => { e.stopPropagation(); a.run(); }} className={cn('rounded-lg px-4 py-1.5 text-sm font-semibold disabled:opacity-60', a.primary ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-blue-300 bg-white text-blue-700 hover:bg-blue-50')}>{a.label}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <span>{board.filtered.length === 0 ? 'Aucun dossier' : `Affichage ${(current - 1) * pageSize + 1} à ${Math.min(current * pageSize, board.filtered.length)} sur ${board.filtered.length} dossier${board.filtered.length > 1 ? 's' : ''}`}</span>
              <span className="flex items-center gap-2">
                <button type="button" aria-label="Page précédente" disabled={current <= 1} onClick={() => setPage(current - 1)} className="rounded border border-slate-200 p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                <span className="rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white">{current}</span>
                <span className="text-xs text-slate-400">/ {pages}</span>
                <button type="button" aria-label="Page suivante" disabled={current >= pages} onClick={() => setPage(current + 1)} className="rounded border border-slate-200 p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
              </span>
              <label className="flex items-center gap-2">Lignes par page
                <select aria-label="Lignes par page" className={cn(inputCls, 'py-1')} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>{[10, 25, 50].map((n) => <option key={n}>{n}</option>)}</select>
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Dernière transmission réussie</h2>
            {!last ? <p className="mt-3 text-sm text-slate-500">Aucune transmission réussie pour le moment.</p> : (
              <div className="mt-3 flex flex-wrap items-center gap-6">
                <span className="flex items-center gap-3"><CheckCircle2 className="h-8 w-8 text-emerald-500" /><span><span className="block font-semibold text-slate-900">Dossier créé avec succès</span><span className="block text-xs text-slate-500">{last.fullName || 'Sans nom'}</span></span></span>
                <span><span className="block text-xs text-slate-500">N° de dossier</span><span className="font-semibold tabular-nums">{last.conversion?.clientId ?? '—'}</span></span>
                <span><span className="block text-xs text-slate-500">Dossier ID</span><span className="font-semibold tabular-nums">{last.conversion?.dossierId ?? '—'}</span></span>
                <span><span className="block text-xs text-slate-500">Transmis le</span><span className="font-semibold">{whenLabel(last.conversion?.convertedAtMs ?? null)}</span></span>
                {lastUrl && <a href={lastUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-2 rounded-lg border border-blue-300 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">Voir dans le CRM principal <ExternalLink className="h-4 w-4" /></a>}
              </div>
            )}
          </section>
        </div>

        {selected ? <DetailPanel key={selected.id} row={selected} canRetry={canRetry} now={now} onOpen={() => navigate(`/dossiers/${selected.id}`)} /> : <aside className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">Sélectionnez un dossier pour voir sa checklist et les données transmises.</aside>}
      </div>
    </div>
  );
}

function StepsStrip({ row }: { row: LeadRow }) {
  const steps = txSteps(row);
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-5 py-6" aria-label="Parcours du dossier">
      <ol className="flex items-start">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex flex-1 flex-col items-center text-center">
            {i > 0 && <span className={cn('absolute right-1/2 top-5 h-0.5 w-full', steps[i - 1].state === 'done' ? 'bg-emerald-500' : 'bg-slate-200')} aria-hidden />}
            <span className={cn('relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 bg-white', s.state === 'done' ? 'border-emerald-500 text-emerald-600' : s.state === 'current' ? 'border-blue-500 text-blue-600' : 'border-slate-300 text-slate-400')}>
              {s.key === 'lead' ? <UserRound className="h-5 w-5" /> : s.key === 'documents' ? <FileText className="h-5 w-5" /> : s.key === 'validated' ? <ShieldCheck className="h-5 w-5" /> : <Share2 className="h-5 w-5" />}
            </span>
            <span className="mt-2 text-sm font-semibold text-slate-800">{s.label}</span>
            <span className={cn('text-xs', s.state === 'done' ? 'text-emerald-600' : s.state === 'current' ? 'text-blue-600' : 'text-slate-400')}>{s.caption}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Panneau du dossier sélectionné : checklist de validation, données transmises, aperçu et reprise. */
function DetailPanel({ row, canRetry, now, onOpen }: { row: LeadRow; canRetry: boolean; now: number; onOpen: () => void }) {
  const sale = useSaleData(row.id);
  const { conversion: rules } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const s = txStatusOf(row) as TxStatus;
  const conv = sale.conversion;
  const lead = sale.lead;
  const draft = sale.draft;
  const report = useMemo(() => (draft && lead ? evaluateControls({ lead: { consent: lead.consent, productCode: lead.productCode }, draft, docs: lead.docs, qualificationMissing: [], rules: rules }) : null), [draft, lead, rules]);
  const duplicate = conv?.state === 'failed' && conv.lastError?.code === 'duplicate_dossier';
  const failed = row.status === 'transmission_error' || conv?.state === 'failed';

  const transmit = async (key: string, decision?: 'link' | 'create') => {
    setBusy(key);
    setNotice(null);
    const r = await sendConversionAction(row.id, { kind: 'transmit', decision });
    setBusy(null);
    setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
  };

  const tiles: { icon: React.ReactNode; label: string; value: string | null }[] = [
    { icon: <UserRound className="h-5 w-5" />, label: 'Client', value: conv?.clientId ? `n° ${conv.clientId}` : null },
    { icon: <Folder className="h-5 w-5" />, label: 'Dossier', value: conv?.dossierId ?? null },
    { icon: <FileText className="h-5 w-5" />, label: 'Documents', value: conv?.documentsTransferred ? String(conv.documentsCount) : null },
    { icon: <Share2 className="h-5 w-5" />, label: 'Attribution marketing', value: conv?.dossierId ? 'Oui' : null },
    { icon: <History className="h-5 w-5" />, label: 'Historique', value: conv?.dossierId ? String(conv.historyCount) : null },
  ];

  return (
    <aside className="space-y-5 xl:sticky xl:top-4 xl:self-start">
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 font-semibold text-blue-700">{initials(row.fullName)}</span><h2 className="text-lg font-bold text-slate-900">{row.fullName || 'Sans nom'}</h2></div>
          <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', s === 'ready' ? 'bg-emerald-50 text-emerald-700' : s === 'blocked' ? 'bg-red-50 text-red-700' : s === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700')}>{s === 'ready' ? 'Prêt à transmettre' : s === 'done' ? 'Transmis' : TX_STATUS_LABELS[s]}</span>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          {[['Produit', row.productCode ?? '—'], ['Télépro assignée', row.ownerName], ['Campagne', row.campaignName], ['Dernière mise à jour', row.montage?.updatedAtMs ? `il y a ${sinceLabel(row.montage.updatedAtMs, now)}` : '—']].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{v}</dd></div>
          ))}
        </dl>

        {failed && conv?.lastError && (
          <div role="alert" className={cn('mt-4 rounded-lg border p-3 text-sm', duplicate ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}>
            <p className="font-semibold">{duplicate ? 'Un dossier existe déjà pour ce contact' : 'Transmission échouée'}</p>
            <p className="mt-1">{conv.lastError.message}</p>
            <p className="mt-1 text-xs opacity-80">Tentative {conv.attempts}{conv.lastAttemptAtMs ? ` · ${whenLabel(conv.lastAttemptAtMs)}` : ''}</p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between"><h3 className="font-semibold text-slate-900">Checklist de validation</h3>{report && <span className={cn('text-sm font-semibold', report.clean && report.toConfirm.length === 0 ? 'text-emerald-600' : 'text-orange-600')}>{report.validated}/{report.total} validés</span>}</div>
        {sale.loading ? <p className="mt-3 text-sm text-slate-500">Chargement…</p> : !report ? <p className="mt-3 text-sm text-slate-500">Aucun brouillon de dossier enregistré.</p> : (
          <ul className="mt-3 grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {report.controls.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-sm" title={c.detail}><LevelIcon level={c.level} className="mt-0.5 h-[18px] w-[18px]" /><span className="text-slate-700">{c.label}</span></li>
            ))}
          </ul>
        )}
        {report && report.blocking.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg bg-red-50 p-3 text-xs text-red-800">{report.blocking.map((c) => <li key={c.key}><strong>{c.label} :</strong> {c.detail}</li>)}</ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">Données transmises</h3>
        <div className="mt-3 grid grid-cols-5 gap-2 text-center">
          {tiles.map((t) => (
            <div key={t.label} className={cn('rounded-lg border p-2', t.value ? 'border-slate-200' : 'border-dashed border-slate-200 opacity-60')} title={t.value ?? 'Pas encore transmis'}>
              <span className="mx-auto flex justify-center text-slate-500">{t.icon}</span>
              <span className="mt-1 block text-[11px] leading-tight text-slate-600">{t.label}</span>
              <span className="block truncate text-sm font-semibold text-slate-900">{t.value ?? '—'}</span>
            </div>
          ))}
        </div>
        <button type="button" disabled={!draft} onClick={() => setPreview(true)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Eye className="h-4 w-4" /> Prévisualiser les données</button>
        <Feedback errors={[]} notice={notice} />
        <div className="mt-3 space-y-2">
          {s === 'ready' && <button type="button" onClick={onOpen} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"><Send className="h-4 w-4" /> Créer la vente et transmettre</button>}
          {failed && !duplicate && canRetry && <button type="button" disabled={busy !== null} onClick={() => void transmit('retry')} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', busy === 'retry' && 'animate-spin')} /> {busy === 'retry' ? 'Reprise…' : 'Relancer la transmission'}</button>}
          {duplicate && canRetry && (
            <>
              {conv?.lastError?.duplicates[0] && <button type="button" disabled={busy !== null} onClick={() => void transmit('link', 'link')} className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy === 'link' ? 'Rattachement…' : `Rattacher au dossier n° ${conv.lastError.duplicates[0].clientNumber || conv.lastError.duplicates[0].id}`}</button>}
              <button type="button" disabled={busy !== null} onClick={() => void transmit('create', 'create')} className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{busy === 'create' ? 'Création…' : 'Créer un nouveau dossier quand même'}</button>
            </>
          )}
          {failed && !canRetry && <p className="text-xs text-slate-500">Un manager ou un administrateur doit relancer la transmission.</p>}
          {(s === 'pending' || s === 'done' || (s === 'blocked' && !failed)) && <button type="button" onClick={onOpen} className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-300 px-4 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-50">Ouvrir le dossier</button>}
        </div>
      </section>

      {preview && draft && report && <PreviewModal row={row} draft={draft} report={report} onClose={() => setPreview(false)} />}
    </aside>
  );
}

function PreviewModal({ row, draft, report, onClose }: { row: LeadRow; draft: NonNullable<ReturnType<typeof useSaleData>['draft']>; report: NonNullable<ReturnType<typeof evaluateControls>>; onClose: () => void }) {
  const r = report.recap;
  const section = (title: string, items: [string, string][]) => (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <dl className="mt-1.5 space-y-1 text-sm">{items.map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{v || '—'}</dd></div>)}</dl>
    </div>
  );
  return (
    <Modal title="Données qui seront transmises" onClose={onClose} width="max-w-xl" footer={<button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Fermer</button>}>
      <div className="space-y-5">
        {section('Identité et adresse', [['Nom', draft.identity.fullName], ['Téléphone', draft.identity.phone], ['E-mail', draft.identity.email], ['Adresse', [draft.identity.addressLine, draft.identity.postalCode, draft.identity.city].filter(Boolean).join(', ')]])}
        {section('Projet et logement', [['Logement', draft.project.housingType], ['Occupation', draft.project.occupancy], ['Surface', draft.project.livingAreaM2 ? `${draft.project.livingAreaM2} m²` : ''], ['Chauffage actuel', draft.project.currentHeating], ['Parcelle cadastrale', draft.project.cadastralRef || 'Recherchée automatiquement à la transmission']])}
        {section('Offre et aides', [['Produits', draft.offer.lines.map((l) => l.label).join(' + ')], ['Prix TTC', formatEuros(r.totalTtcCents)], ['MaPrimeRénov’', formatEuros(r.mprCents)], ['CEE', formatEuros(r.ceeCents)], ['Reste à charge', formatEuros(r.remainderCents)], ['Règlement', draft.offer.financing.mode === 'credit' ? `Crédit${draft.offer.financing.organism ? ` · ${draft.offer.financing.organism}` : ''}` : 'Comptant']])}
        {section('Suivi', [['Campagne', row.campaignName], ['Télépro', row.ownerName], ['Notes commerciales', draft.notes ? 'Oui' : 'Aucune'], ['Pièces conformes', row.docs ? `${row.docs.mandatoryConform}/${row.docs.mandatory}` : '—']])}
        <p className="text-xs text-slate-400">Aperçu établi à partir du brouillon enregistré. L&apos;historique utile du lead et la source marketing sont ajoutés à la transmission.</p>
      </div>
    </Modal>
  );
}
