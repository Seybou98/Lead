import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Info, Lock, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { downloadText, toCsv } from '../../domain/csv';
import { getSlaMs, slaElapsedMs } from '../../domain/leads/leadList';
import { DATE_MODE_LABELS, type ReportFilters } from '../../domain/reports/direction';
import { buildExport, canExportIdentifying, DEFAULT_LEAD_COLUMNS, detailLeads, EXPORT_FORMATS, EXPORT_FORMAT_LABELS, EXPORT_KINDS, EXPORT_KIND_LABELS, filterSummary, LEAD_COLUMNS, printableHtml, resolveColumns, type ExportFormat, type ExportKind } from '../../domain/reports/exports';
import { errorMessage, logReportExport } from '../../lib/adminApi';
import { Switch } from '../settings/settingsUi';
import { addExportHistory, readExportHistory, type ExportLogEntry } from './exportHistory';
import { printHtml } from './fileActions';
import type { ReportsData } from './useReportsData';

/**
 * Exports à la demande (§22.10, fig. 34). Un export restitue les filtres, les colonnes et le mode de date visibles à sa
 * création. Le détail des leads est anonymisé par défaut ; les données directement identifiantes demandent une
 * permission distincte (administrateur) et sont tracées. La planification et l'envoi par lien sont dans ScheduledView.
 */
export function ExportsView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const { user } = useAuth();
  const role = user?.role ?? 'manager';
  const uid = user?.uid ?? '';
  const mayIdentify = canExportIdentifying(role);
  const [kind, setKind] = useState<ExportKind>('direction');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [corrected, setCorrected] = useState(true);
  const [detail, setDetail] = useState(false);
  const [anonymize, setAnonymize] = useState(true);
  const [columns, setColumns] = useState<string[]>([...DEFAULT_LEAD_COLUMNS]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [history, setHistory] = useState<ExportLogEntry[]>(() => readExportHistory(uid));

  const names = useMemo(() => ({ users: data.names.users, campaigns: data.names.campaigns, sources: new Map(data.sources.map((s) => [s.id, s.name])) }), [data.names, data.sources]);
  const asLeads = kind === 'leads';
  const withDetail = detail || asLeads;
  const effectiveAnonymize = anonymize || !mayIdentify;
  const choice = useMemo(() => resolveColumns(columns, { anonymize: effectiveAnonymize, role }), [columns, effectiveAnonymize, role]);
  const summary = useMemo(() => filterSummary(filters, { names, reportCampaigns: data.reportCampaigns }, !corrected), [filters, names, data.reportCampaigns, corrected]);
  const leadCount = useMemo(() => (withDetail ? detailLeads(data.leads, data.reportCampaigns, filters, !corrected).length : 0), [withDetail, data.leads, data.reportCampaigns, filters, corrected]);
  const rawApplies = kind === 'campaigns' || kind === 'leads' || detail;

  const toggleColumn = (key: string, on: boolean) => setColumns((cur) => (on ? [...cur, key] : cur.filter((k) => k !== key)));

  const generate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const built = buildExport(
        { leads: data.leads, reportCampaigns: data.reportCampaigns, campaigns: data.campaigns, spends: data.spends, filters, nowMs: now, slaMs: getSlaMs(), elapsed: slaElapsedMs, names },
        { kind, raw: !corrected, detail: withDetail, anonymize: effectiveAnonymize, columns, role }
      );
      // Données personnelles : l'export n'est livré que si sa trace est écrite.
      if (built.identifying) {
        await logReportExport({ kind, format, rows: built.rows.length, detailCount: built.detailCount, columns: choice.columns.map((c) => c.label), filters: built.summary });
      }
      if (format === 'csv') downloadText(`${built.filename}.csv`, toCsv(['Export CRM Leads — Label Énergie'], built.rows));
      else printHtml(printableHtml(`${built.title} — ${built.summary[0].value}`, built.rows));
      const entry: ExportLogEntry = { id: `${now}_${Math.random().toString(36).slice(2, 7)}`, atMs: Date.now(), kind, title: built.title, format, period: built.summary[0].value, mode: DATE_MODE_LABELS[filters.mode], rows: built.rows.length, detailCount: built.detailCount, identifying: built.identifying };
      setHistory(addExportHistory(uid, entry));
      setNotice({ kind: 'ok', text: `${format === 'csv' ? 'Fichier téléchargé' : 'Fenêtre d’impression ouverte : choisissez « Enregistrer au format PDF »'}${built.detailCount ? ` · ${built.detailCount} lead${built.detailCount > 1 ? 's' : ''} détaillé${built.detailCount > 1 ? 's' : ''}` : ''}${built.dropped.length ? ` · colonnes retirées : ${built.dropped.join(', ')}` : ''}.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Créer un export</h2>
        <div className="mt-4 space-y-4 text-sm">
          <label className="block"><span className="font-medium text-slate-700">Rapport</span>
            <select aria-label="Rapport" value={kind} onChange={(e) => setKind(e.target.value as ExportKind)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
              {EXPORT_KINDS.map((k) => <option key={k} value={k}>{EXPORT_KIND_LABELS[k]}</option>)}
            </select>
          </label>

          <div>
            <p className="font-medium text-slate-700">Format</p>
            <div role="radiogroup" aria-label="Format" className="mt-1 flex flex-wrap gap-2">
              {EXPORT_FORMATS.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={format === f} onClick={() => setFormat(f)} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5', format === f ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}><FileText className="h-4 w-4" /> {EXPORT_FORMAT_LABELS[f]}</button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <Row label="Données corrigées" hint={rawApplies ? 'Hors doublons, faux leads et leads exclus. Désactivé : données brutes.' : 'Ce rapport montre déjà les deux lectures : réglage sans effet.'}><Switch label="Données corrigées" checked={corrected} onChange={setCorrected} disabled={!rawApplies} /></Row>
            <Row label="Inclure le détail des leads" hint={asLeads ? 'La liste des leads est le contenu du rapport.' : 'Ajoute une ligne par lead reçu pendant la période.'}><Switch label="Inclure le détail des leads" checked={withDetail} onChange={setDetail} disabled={asLeads} /></Row>
            <Row label="Anonymiser les données personnelles" hint={mayIdentify ? 'Nom remplacé par un identifiant stable ; ni téléphone, ni email, ni adresse.' : 'Réservé à l’administrateur : votre export est toujours anonymisé.'}>
              <span className="inline-flex items-center gap-2">{!mayIdentify && <Lock className="h-4 w-4 text-slate-400" />}<Switch label="Anonymiser les données personnelles" checked={effectiveAnonymize} onChange={setAnonymize} disabled={!mayIdentify || !withDetail} /></span>
            </Row>
          </div>

          {withDetail && (
            <details className="rounded-lg border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700">{choice.columns.length} colonne{choice.columns.length > 1 ? 's' : ''} sélectionnée{choice.columns.length > 1 ? 's' : ''}</summary>
              <ul className="grid gap-x-4 gap-y-1.5 border-t border-slate-100 px-3 py-3 sm:grid-cols-2">
                {LEAD_COLUMNS.map((c) => {
                  const locked = c.identifying && (effectiveAnonymize || !mayIdentify);
                  return (
                    <li key={c.key}>
                      <label className={cn('flex items-center gap-2', locked && 'text-slate-400')} title={locked ? (mayIdentify ? 'Retirée : l’export est anonymisé.' : 'Donnée identifiante : réservée à l’administrateur (permission distincte).') : undefined}>
                        <input type="checkbox" checked={columns.includes(c.key) && !locked} disabled={locked} onChange={(e) => toggleColumn(c.key, e.target.checked)} />
                        {c.label}{c.identifying && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">personnelle</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            <p className="flex items-center gap-1.5 font-medium text-slate-700"><Info className="h-3.5 w-3.5" /> Cet export restituera :</p>
            <ul className="mt-1 space-y-0.5">{summary.map((s) => <li key={s.label}>{s.label} : <span className="text-slate-800">{s.value}</span></li>)}</ul>
            {withDetail && <p className="mt-1">Détail : {leadCount} lead{leadCount > 1 ? 's' : ''} reçu{leadCount > 1 ? 's' : ''} sur la période{effectiveAnonymize ? ', anonymisés' : ', avec leurs données personnelles (export tracé)'}.</p>}
          </div>

          {notice && (
            <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
              {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
            </p>
          )}
          <button type="button" onClick={() => void generate()} disabled={busy || (withDetail && choice.columns.length === 0)} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Download className="h-4 w-4" /> {busy ? 'Génération…' : 'Générer l’export'}</button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Exports récents (ce navigateur)</h2>
        {history.length === 0 ? <p className="mt-3 text-sm text-slate-500">Aucun export généré depuis ce navigateur.</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 font-medium">Rapport</th><th className="py-2 font-medium">Période</th><th className="py-2 font-medium">Format</th><th className="py-2 font-medium">Généré le</th><th className="py-2 text-right font-medium">Lignes</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b border-slate-100">
                    <td className="py-2 text-slate-900">{h.title}{h.detailCount > 0 && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">détail {h.detailCount}</span>}{h.identifying && <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">données personnelles</span>}</td>
                    <td className="py-2 text-slate-600" title={h.mode}>{h.period}</td>
                    <td className="py-2 uppercase text-slate-600">{h.format}</td>
                    <td className="py-2 text-slate-600">{new Date(h.atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-2 text-right tabular-nums text-slate-600">{h.rows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 space-y-2 rounded-lg bg-blue-50 px-3 py-2.5 text-xs text-blue-900">
          <p className="flex items-start gap-1.5"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> Les exports de données directement identifiantes demandent une permission distincte (administrateur) et sont tracés dans le journal d’audit.</p>
          <p>Un export à la demande n’est pas conservé côté serveur : cette liste n’existe que dans ce navigateur. Pour recevoir un rapport à intervalle régulier (lien par email, fichier conservé 30 jours), utilisez l’onglet « Rapports programmés ». Le CSV s’ouvre directement dans Excel ; l’export Excel natif et l’API ne sont pas disponibles en V1.</p>
        </div>
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0"><span className="block font-medium text-slate-700">{label}</span><span className="block text-xs text-slate-500">{hint}</span></span>
      <span className="flex-shrink-0 pt-0.5">{children}</span>
    </div>
  );
}
