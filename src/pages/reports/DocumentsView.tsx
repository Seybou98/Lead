import { useMemo, useState } from 'react';
import { AlertTriangle, Clock, Download, FileText, Info, Inbox, RefreshCw, XCircle, FolderCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { downloadText, toCsv } from '../../domain/csv';
import type { LeadListItem } from '../../domain/leads/leadList';
import { DATE_MODE_LABELS, type ReportFilters } from '../../domain/reports/direction';
import { BLOCK_DAYS_CHOICES, buildDocumentsReport, DELAY_LIMITS_DAYS, DOC_STAGE_DEFINITIONS, DOC_STAGE_LABELS, documentStagePopulation, documentsRows, MOUNT_WAIT_MS, type DocBar, type DocStage } from '../../domain/reports/documents';
import { inputCls } from '../settings/settingsUi';
import type { ReportsData } from './useReportsData';
import { fmtInt, fmtPct, PopulationDrawer } from './ReportParts';

interface Open {
  title: string;
  definition: string;
  leads: readonly LeadListItem[];
}

/** Performance documentaire et délais (§22.7, fig. 33) : pipeline, délais par étape, goulots, non-conformités. */
export function DocumentsView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const [blockDays, setBlockDays] = useState<number>(7);
  const [open, setOpen] = useState<Open | null>(null);
  const report = useMemo(() => buildDocumentsReport({ leads: data.leads, campaigns: data.reportCampaigns, filters, nowMs: now, blockDays }), [data.leads, data.reportCampaigns, filters, now, blockDays]);
  const exportCsv = () => downloadText(`rapport-documents-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Performance documentaire'], documentsRows(report, DATE_MODE_LABELS[filters.mode])));
  const openStage = (stage: DocStage) => setOpen({ title: DOC_STAGE_LABELS[stage], definition: DOC_STAGE_DEFINITIONS[stage], leads: documentStagePopulation(data.leads, data.reportCampaigns, filters, stage) });
  const maxStage = Math.max(1, ...report.stages.map((s) => s.count));
  const complete = report.delays.find((d) => d.key === 'requestToComplete');
  const bn = report.bottlenecks;

  const card = (icon: React.ReactNode, tone: string, label: string, value: string, hint: string, onClick?: () => void) => (
    <button type="button" onClick={onClick} disabled={!onClick} title={hint} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left enabled:hover:bg-slate-50">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <span className="min-w-0"><span className="block text-xs text-slate-500">{label}</span><span className="block text-xl font-bold tabular-nums text-slate-900">{value}</span></span>
    </button>
  );

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {card(<FileText className="h-5 w-5 text-blue-600" />, 'bg-blue-50', 'Dossiers demandés', fmtInt(report.counts.requested), DOC_STAGE_DEFINITIONS.requested, () => openStage('requested'))}
        {card(<Inbox className="h-5 w-5 text-emerald-600" />, 'bg-emerald-50', 'Pièce reçue', fmtInt(report.counts.received), DOC_STAGE_DEFINITIONS.received, () => openStage('received'))}
        {card(<FolderCheck className="h-5 w-5 text-green-600" />, 'bg-green-50', 'Dossiers complets', fmtInt(report.counts.complete), DOC_STAGE_DEFINITIONS.complete, () => openStage('complete'))}
        {card(<Clock className="h-5 w-5 text-violet-600" />, 'bg-violet-50', 'Délai médian de complétude', complete?.medianDays == null ? '—' : `${complete.medianDays.toLocaleString('fr-FR')} j`, `${complete?.definition ?? ''} ${complete?.n ?? 0} dossier(s) mesuré(s).`)}
        {card(<RefreshCw className="h-5 w-5 text-sky-600" />, 'bg-sky-50', 'Relances moyennes', report.avgReminders === null ? '—' : report.avgReminders.toLocaleString('fr-FR'), 'Nombre moyen de relances par dossier demandé.')}
        {card(<XCircle className="h-5 w-5 text-red-600" />, 'bg-red-50', 'Abandon documentaire', fmtPct(report.abandonRate), `Dossiers demandés puis clôturés sans vente (non intéressé, injoignable archivé, inéligible) : ${report.abandoned} sur ${report.counts.requested}.`)}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> {DATE_MODE_LABELS[filters.mode]} · un dossier = un lead · {report.toCheck} à contrôler, {report.partial} partiel{report.partial > 1 ? 's' : ''}</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>

      <div className="mt-4 grid gap-5 xl:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Pipeline documentaire</h2>
          <ul className="mt-4 space-y-2.5">
            {report.stages.map((s) => (
              <li key={s.stage}>
                <button type="button" onClick={() => openStage(s.stage)} title={`${DOC_STAGE_DEFINITIONS[s.stage]} Cliquez pour voir les ${s.count} dossiers.`} className="flex w-full items-center gap-2 text-left text-xs hover:opacity-80">
                  <span className="w-28 flex-shrink-0 text-slate-600">{s.label}</span>
                  <span className="h-6 flex-1 rounded bg-slate-100"><span className="flex h-6 items-center rounded bg-blue-600 px-2 text-[11px] font-semibold text-white" style={{ width: `${Math.max(8, (s.count / maxStage) * 100)}%` }}>{s.count}</span></span>
                  <span className="w-12 text-right tabular-nums text-slate-500">{s.passage === null ? '' : fmtPct(s.passage)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-400">Le pourcentage est le taux de passage depuis l’étape précédente.</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Délais par étape</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {report.delays.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-3 py-2.5 text-sm" title={`${d.definition} Limite : ${DELAY_LIMITS_DAYS[d.key]} j.`}>
                <span className="text-slate-700">{d.label}<span className="block text-[11px] text-slate-400">{d.n} dossier{d.n > 1 ? 's' : ''} mesuré{d.n > 1 ? 's' : ''}</span></span>
                <span className={cn('rounded-lg px-3 py-1 text-sm font-semibold tabular-nums', d.medianDays === null ? 'bg-slate-100 text-slate-400' : d.late ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700')}>{d.medianDays === null ? '—' : `${d.medianDays.toLocaleString('fr-FR')} j`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">Médiane. « Demande → première pièce » n’est pas calculée : la date de la première pièce n’est pas conservée.</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Goulots d’étranglement</h2>
            <select aria-label="Seuil de blocage" value={blockDays} onChange={(e) => setBlockDays(Number(e.target.value))} className={cn(inputCls, 'py-1 text-xs')}>{BLOCK_DAYS_CHOICES.map((d) => <option key={d} value={d}>Blocage &gt; {d} jours</option>)}</select>
          </div>
          <ul className="mt-3 space-y-2">
            <Bottleneck level="critical" count={bn.waiting.length} text={`dossier${bn.waiting.length > 1 ? 's' : ''} en attente de pièces depuis plus de ${blockDays} jours`} onOpen={() => setOpen({ title: `En attente depuis plus de ${blockDays} jours`, definition: `Dossiers en attente de documents ou d’informations dont la dernière demande date de plus de ${blockDays} jours. Photographie actuelle, hors période.`, leads: bn.waiting })} />
            <Bottleneck level="warning" count={bn.mountWait.length} text={`dossier${bn.mountWait.length > 1 ? 's' : ''} complet${bn.mountWait.length > 1 ? 's' : ''} attend${bn.mountWait.length > 1 ? 'ent' : ''} un montage depuis plus de ${MOUNT_WAIT_MS / 3_600_000} h`} onOpen={() => setOpen({ title: 'Complets en attente de montage', definition: 'Dossiers complets, prêts à monter, dont le dernier document conforme date de plus de 24 heures. Photographie actuelle, hors période.', leads: bn.mountWait })} />
          </ul>
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Documents les plus souvent non conformes</h2>
          <Bars bars={report.nonConformDocs.slice(0, 8)} empty="Aucune pièce non conforme en cours." />
          <p className="mt-2 text-xs text-slate-400">Pièces actuellement non conformes sur les dossiers demandés de la période ({report.nonConformTotal}).</p>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Principaux motifs</h2>
          {report.nonConformReasons.length === 0 ? <p className="mt-3 text-sm text-slate-500">Aucun motif à afficher.</p> : (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 font-medium">Motif</th><th className="py-2 text-right font-medium">Nombre</th></tr></thead>
              <tbody>{report.nonConformReasons.slice(0, 8).map((b) => <tr key={b.key} className="border-b border-slate-100"><td className="py-2 text-slate-700">{b.label}</td><td className="py-2 text-right tabular-nums text-slate-900">{b.count}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </div>

      <p className="mt-4 text-xs text-slate-400">Dernière actualisation : {new Date(now).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · données en temps réel, lecture seule.</p>
      {open && <PopulationDrawer title={open.title} definition={open.definition} leads={open.leads} onClose={() => setOpen(null)} />}
    </>
  );
}

function Bottleneck({ level, count, text, onOpen }: { level: 'critical' | 'warning'; count: number; text: string; onOpen: () => void }) {
  const tone = count === 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : level === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800';
  return (
    <li className={cn('flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm', tone)}>
      <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /><span><strong>{count}</strong> {text}</span></span>
      {count > 0 && <button type="button" onClick={onOpen} className="flex-shrink-0 rounded-lg bg-white/70 px-3 py-1 text-xs font-semibold hover:bg-white">Ouvrir</button>}
    </li>
  );
}

function Bars({ bars, empty }: { bars: DocBar[]; empty: string }) {
  if (bars.length === 0) return <p className="mt-3 text-sm text-slate-500">{empty}</p>;
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <ul className="mt-3 space-y-2">
      {bars.map((b) => (
        <li key={b.key} className="flex items-center gap-2 text-xs">
          <span className="w-36 flex-shrink-0 truncate text-slate-600" title={b.label}>{b.label}</span>
          <span className="h-4 flex-1 rounded bg-slate-100"><span className="block h-4 rounded bg-blue-600" style={{ width: `${(b.count / max) * 100}%` }} /></span>
          <span className="w-20 text-right tabular-nums text-slate-700">{b.count} · {fmtPct(b.share)}</span>
        </li>
      ))}
    </ul>
  );
}
