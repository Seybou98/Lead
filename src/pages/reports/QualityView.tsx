import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Download, Info, ShieldAlert, UserX, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { downloadText, toCsv } from '../../domain/csv';
import type { LeadListItem } from '../../domain/leads/leadList';
import type { ReportFilters } from '../../domain/reports/direction';
import { buildQualityReport, motifPopulation, QUALITY_DIMS, QUALITY_DIM_LABELS, QUALITY_FLAG_DEFINITIONS, QUALITY_FLAG_LABELS, qualityPopulation, qualityRows, type QualityDim, type QualityFlag, type QualitySelector, type QualityTally } from '../../domain/reports/quality';
import type { ReportsData } from './useReportsData';
import { fmtInt, fmtPct, PopulationDrawer } from './ReportParts';

interface Open {
  title: string;
  definition: string;
  leads: readonly LeadListItem[];
}

const COLUMNS: QualityFlag[] = ['duplicate', 'fake', 'invalidContact', 'unreachable', 'ineligible', 'notInterested', 'docAbandon'];

/** Qualité des leads (§22.5) : par source, campagne, produit, zone ou télépro, en lecture brute ou corrigée. */
export function QualityView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const [dim, setDim] = useState<QualityDim>('source');
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);

  const nameOf = (d: QualityDim, key: string): string => {
    if (key === '—') return 'Non renseigné';
    if (d === 'source') return data.sources.find((s) => s.id === key)?.name ?? key;
    if (d === 'campaign') return data.names.campaigns.get(key) ?? key;
    if (d === 'owner') return data.names.users.get(key) ?? key;
    if (d === 'zone') return key === 'Inconnue' ? 'Zone inconnue' : `Département ${key}`;
    return key;
  };
  const report = useMemo(() => buildQualityReport({ leads: data.leads, campaigns: data.reportCampaigns, filters, dim, labelOf: nameOf }), [data.leads, data.reportCampaigns, filters, dim, data.sources, data.names]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = report.total;
  const exportCsv = () => downloadText(`rapport-qualite-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Qualité des leads'], qualityRows(report, (k) => nameOf(dim, k))));
  const show = (title: string, definition: string, key: string | null, what: QualitySelector) => setOpen({ title, definition, leads: qualityPopulation(data.leads, data.reportCampaigns, filters, dim, key, what) });
  const base = (x: QualityTally) => (raw ? x.received : x.valid);

  const card = (icon: React.ReactNode, tone: string, label: string, value: string, hint: string, onClick: () => void, sub?: string) => (
    <button type="button" onClick={onClick} title={hint} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left hover:bg-slate-50">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <span className="min-w-0"><span className="block text-xs text-slate-500">{label}</span><span className="block text-xl font-bold tabular-nums text-slate-900">{value}</span>{sub && <span className="block text-[11px] text-slate-400">{sub}</span>}</span>
    </button>
  );

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {card(<Users className="h-5 w-5 text-blue-600" />, 'bg-blue-50', 'Leads reçus (brut)', fmtInt(t.received), 'Tous les leads reçus sur la période, doublons et faux leads compris.', () => show('Leads reçus', 'Tous les leads reçus sur la période (donnée brute).', null, 'received'))}
        {card(<CheckCircle2 className="h-5 w-5 text-emerald-600" />, 'bg-emerald-50', 'Leads valides (corrigé)', fmtInt(t.valid), 'Reçus moins doublons, faux leads et leads exclus.', () => show('Leads valides', 'Leads reçus hors doublons, faux leads et exclus (donnée corrigée).', null, 'valid'))}
        {card(<ShieldAlert className="h-5 w-5 text-red-600" />, 'bg-red-50', 'Exclus', fmtInt(t.excluded), 'Leads retirés de la donnée corrigée. Ils ne sont jamais supprimés : la liste reste consultable.', () => show('Leads exclus', 'Doublons, faux leads et leads exclus : visibles dans la donnée brute, absents de la donnée corrigée.', null, 'excluded'), fmtPct(t.received ? Math.round((t.excluded / t.received) * 1000) / 10 : null))}
        {card(<Copy className="h-5 w-5 text-amber-600" />, 'bg-amber-50', 'Doublons', fmtInt(t.flags.duplicate), QUALITY_FLAG_DEFINITIONS.duplicate, () => show('Doublons', QUALITY_FLAG_DEFINITIONS.duplicate, null, 'duplicate'))}
        {card(<UserX className="h-5 w-5 text-rose-600" />, 'bg-rose-50', 'Mauvaise qualité', fmtPct(t.lowQualityRate), 'Doublons, faux leads, injoignables archivés et inéligibles, rapportés aux leads reçus.', () => show('Leads de mauvaise qualité', 'Doublons, faux leads, injoignables archivés et inéligibles.', null, 'lowQuality'), `${t.lowQuality} sur ${t.received}`)}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> Leads reçus pendant la période (la qualité se juge à l’arrivée) · l’exclusion ne supprime jamais un lead</span>
        <span role="radiogroup" aria-label="Lecture des données" className="ml-auto flex rounded-lg border border-slate-200 bg-white p-0.5">
          {([[false, 'Données corrigées'], [true, 'Données brutes']] as const).map(([v, label]) => (
            <button key={label} role="radio" aria-checked={raw === v} type="button" onClick={() => setRaw(v)} className={cn('rounded-md px-3 py-1 font-medium', raw === v ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'text-slate-500 hover:text-slate-800')}>{label}</button>
          ))}
        </span>
        <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>

      {report.alerts.length > 0 && (
        <ul className="mt-4 space-y-2">
          {report.alerts.map((a) => (
            <li key={a.id} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', a.level === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span className="flex-1"><span className="block font-medium">{a.title}</span><span className="block text-xs opacity-80">{a.detail}</span></span>
              <button type="button" onClick={() => show(`${nameOf(a.dim, a.key)} — leads exclus`, a.detail, a.key, 'excluded')} className="flex-shrink-0 rounded-lg bg-white/70 px-3 py-1 text-xs font-semibold hover:bg-white">Ouvrir</button>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-4 rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Qualité par {QUALITY_DIM_LABELS[dim].toLowerCase()}</h2>
          <div role="tablist" aria-label="Dimension d’analyse" className="flex flex-wrap rounded-lg border border-slate-200 p-0.5 text-xs">
            {QUALITY_DIMS.map((d) => (
              <button key={d} role="tab" aria-selected={dim === d} type="button" onClick={() => setDim(d)} className={cn('rounded-md px-3 py-1 font-medium', dim === d ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{QUALITY_DIM_LABELS[d]}</button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-3 py-2.5 font-medium">{QUALITY_DIM_LABELS[dim]}</th>
                <th className="px-3 py-2.5 text-right font-medium" title={raw ? 'Tous les leads reçus.' : 'Leads reçus hors doublons, faux leads et exclus.'}>{raw ? 'Reçus' : 'Valides'}</th>
                <th className="px-3 py-2.5 text-right font-medium">Exclus</th>
                {COLUMNS.map((f) => <th key={f} className="px-3 py-2.5 text-right font-medium" title={QUALITY_FLAG_DEFINITIONS[f]}>{QUALITY_FLAG_LABELS[f]}</th>)}
                <th className="px-3 py-2.5 text-right font-medium" title="Doublons, faux leads, injoignables archivés et inéligibles / leads reçus.">Mauvaise qualité</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && <tr><td colSpan={COLUMNS.length + 4} className="px-3 py-8 text-center text-slate-500">Aucun lead reçu sur cette période et ce périmètre.</td></tr>}
              {report.rows.map((r) => {
                const label = nameOf(dim, r.key);
                return (
                  <tr key={r.key} className="border-b border-slate-100">
                    <td className="px-3 py-2.5 font-medium text-slate-900">{label}{r.lowVolume && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700" title={`Moins de ${report.minVolume} leads : lecture peu fiable.`}>volume faible</span>}</td>
                    <Cell v={base(r.tally)} onOpen={() => show(`${label} — ${raw ? 'reçus' : 'valides'}`, raw ? 'Leads reçus (brut).' : 'Leads reçus hors doublons, faux leads et exclus (corrigé).', r.key, raw ? 'received' : 'valid')} />
                    <Cell v={r.tally.excluded} onOpen={() => show(`${label} — exclus`, 'Doublons, faux leads et leads exclus.', r.key, 'excluded')} />
                    {COLUMNS.map((f) => <Cell key={f} v={r.tally.flags[f]} onOpen={() => show(`${label} — ${QUALITY_FLAG_LABELS[f].toLowerCase()}`, QUALITY_FLAG_DEFINITIONS[f], r.key, f)} />)}
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums" title={`Sur ${r.tally.received} leads reçus`}>{fmtPct(r.tally.lowQualityRate)}</td>
                  </tr>
                );
              })}
              {report.rows.length > 0 && (
                <tr className="bg-slate-50 font-medium">
                  <td className="px-3 py-2.5 text-slate-900">Ensemble</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtInt(base(t))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtInt(t.excluded)}</td>
                  {COLUMNS.map((f) => <td key={f} className="px-3 py-2.5 text-right tabular-nums">{fmtInt(t.flags[f])}</td>)}
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtPct(t.lowQualityRate)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">Chaque nombre ouvre la liste des leads. « Non-propriétaire » et « mauvais produit » n’ont pas de code propre : ils n’apparaissent que dans les motifs de clôture saisis.</p>
      </section>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Motifs</h2>
        {report.motifs.length === 0 ? <p className="mt-3 text-sm text-slate-500">Aucun lead clôturé ou exclu sur la période.</p> : (
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 font-medium">Famille</th><th className="py-2 font-medium">Motif</th><th className="py-2 text-right font-medium">Leads</th><th className="py-2 text-right font-medium">Part</th></tr></thead>
            <tbody>
              {report.motifs.map((m) => (
                <tr key={m.key} className="border-b border-slate-100">
                  <td className="py-2 text-slate-600">{m.family}</td>
                  <td className="py-2 text-slate-900">{m.label}</td>
                  <td className="py-2 text-right tabular-nums"><button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => setOpen({ title: `${m.family} — ${m.label}`, definition: 'Leads reçus sur la période dont c’est le motif principal.', leads: motifPopulation(data.leads, data.reportCampaigns, filters, m.key) })}>{m.count}</button></td>
                  <td className="py-2 text-right tabular-nums text-slate-500">{fmtPct(m.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="mt-4 text-xs text-slate-400">Dernière actualisation : {new Date(now).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · données en temps réel, lecture seule.</p>
      {open && <PopulationDrawer title={open.title} definition={open.definition} leads={open.leads} onClose={() => setOpen(null)} />}
    </>
  );
}

function Cell({ v, onOpen }: { v: number; onOpen: () => void }) {
  return <td className="px-3 py-2.5 text-right tabular-nums">{v === 0 ? <span className="text-slate-300">0</span> : <button type="button" onClick={onOpen} className="font-medium text-blue-700 hover:underline" title="Voir les leads">{fmtInt(v)}</button>}</td>;
}
