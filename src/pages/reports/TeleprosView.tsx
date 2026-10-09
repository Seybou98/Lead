import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Info, Phone, ShieldCheck, ShoppingCart, FileText, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { downloadText, toCsv } from '../../domain/csv';
import { getSlaMs, slaElapsedMs } from '../../domain/leads/leadList';
import { DATE_MODE_LABELS, STAGE_DEFINITIONS, STAGE_LABELS, STAGES, type ReportFilters, type Stage } from '../../domain/reports/direction';
import { buildTeleproReport, RATIO_DEFINITIONS, SLA_DEFINITION, teleproPopulation, teleproRows, type TeleproRow } from '../../domain/reports/telepros';
import type { ReportsData } from './useReportsData';
import { fmtInt, fmtPct, PopulationDrawer } from './ReportParts';

/** Comparaison des télépros (§22.6, fig. 32) : tableau classé, nuage conversion / volume, fiche du télépro choisi. */
export function TeleprosView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<{ ownerId: string; stage: Stage } | null>(null);
  const report = useMemo(() => buildTeleproReport({ leads: data.leads, campaigns: data.reportCampaigns, filters, nowMs: now, slaMs: getSlaMs(), elapsed: slaElapsedMs }), [data.leads, data.reportCampaigns, filters, now]);
  const nameOf = (id: string) => data.names.users.get(id) ?? id;
  const t = report.total;
  const current = report.rows.find((r) => r.ownerId === selected) ?? null;
  const exportCsv = () => downloadText(`rapport-telepros-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Comparaison des télépros'], teleproRows(report, nameOf, DATE_MODE_LABELS[filters.mode])));
  const population = open ? teleproPopulation(data.leads, data.reportCampaigns, filters, open.ownerId, open.stage) : [];

  const card = (icon: React.ReactNode, tone: string, label: string, value: string, hint: string, sub?: string) => (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4" title={hint}>
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div className="min-w-0"><p className="text-xs text-slate-500">{label}</p><p className="text-xl font-bold tabular-nums text-slate-900">{value}</p>{sub && <p className="text-[11px] text-slate-400">{sub}</p>}</div>
    </div>
  );

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {card(<Users className="h-5 w-5 text-blue-600" />, 'bg-blue-50', 'Leads attribués', fmtInt(t.attributed), 'Leads valides attribués à un télépro (hors doublons, faux leads, exclus).')}
        {card(<ShieldCheck className="h-5 w-5 text-emerald-600" />, 'bg-emerald-50', 'SLA respecté', fmtPct(t.slaRate), SLA_DEFINITION, `${t.slaRespected} sur ${t.slaMeasured} mesurés`)}
        {card(<Phone className="h-5 w-5 text-violet-600" />, 'bg-violet-50', 'Contacts', fmtInt(t.counts.contacted), STAGE_DEFINITIONS.contacted)}
        {card(<FileText className="h-5 w-5 text-amber-600" />, 'bg-amber-50', 'Documents demandés', fmtInt(t.counts.docsRequested), STAGE_DEFINITIONS.docsRequested)}
        {card(<ShoppingCart className="h-5 w-5 text-rose-600" />, 'bg-rose-50', 'Ventes', fmtInt(t.counts.sales), STAGE_DEFINITIONS.sales)}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> {DATE_MODE_LABELS[filters.mode]} · mêmes règles de comptage que le rapport Direction</span>
        <span>Les jours travaillés, les absences individuelles et les objectifs ne sont pas encore pris en compte.</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>

      <div className={cn('mt-4 grid gap-5', current && 'xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]')}>
        <div className="space-y-5">
          <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-3 py-2.5 font-medium">Rang</th>
                  <th className="px-3 py-2.5 font-medium">Télépro</th>
                  <th className="px-3 py-2.5 text-right font-medium">Leads</th>
                  <th className="px-3 py-2.5 text-right font-medium" title={SLA_DEFINITION}>SLA</th>
                  <th className="px-3 py-2.5 text-right font-medium" title={RATIO_DEFINITIONS.contact.formula}>Contact</th>
                  <th className="px-3 py-2.5 text-right font-medium">Docs demandés</th>
                  <th className="px-3 py-2.5 text-right font-medium">Docs complets</th>
                  <th className="px-3 py-2.5 text-right font-medium">Ventes</th>
                  <th className="px-3 py-2.5 text-right font-medium" title={RATIO_DEFINITIONS.leadToSale.formula}>Lead → vente</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">Aucune activité de télépro sur cette période et ce périmètre.</td></tr>}
                {report.rows.map((r, i) => (
                  <tr key={r.ownerId} onClick={() => setSelected(r.ownerId === selected ? null : r.ownerId)} className={cn('cursor-pointer border-b border-slate-100 hover:bg-slate-50', selected === r.ownerId && 'bg-blue-50/60')}>
                    <td className="px-3 py-2.5 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{nameOf(r.ownerId)}{r.lowVolume && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700" title={`Moins de ${report.minVolume} leads valides : comparaison peu fiable.`}>volume faible</span>}</td>
                    <Count v={r.attributed} onOpen={() => setOpen({ ownerId: r.ownerId, stage: 'valid' })} />
                    <td className="px-3 py-2.5 text-right tabular-nums" title={`${r.slaRespected} sur ${r.slaMeasured} leads mesurés`}>{fmtPct(r.slaRate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" title={`${r.counts.contacted} sur ${r.counts.valid}`}>{fmtPct(r.ratios.contact)}</td>
                    <Count v={r.counts.docsRequested} onOpen={() => setOpen({ ownerId: r.ownerId, stage: 'docsRequested' })} />
                    <Count v={r.counts.docsComplete} onOpen={() => setOpen({ ownerId: r.ownerId, stage: 'docsComplete' })} />
                    <Count v={r.counts.sales} onOpen={() => setOpen({ ownerId: r.ownerId, stage: 'sales' })} />
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums" title={`${r.counts.sales} ventes sur ${r.counts.valid} leads valides`}>{fmtPct(r.ratios.leadToSale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Taux de conversion et volume</h2>
            <Scatter rows={report.rows} nameOf={nameOf} selected={selected} onSelect={setSelected} minVolume={report.minVolume} />
            <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><Info className="h-3.5 w-3.5 flex-shrink-0" /> Un taux se lit toujours avec son volume : en dessous de {report.minVolume} leads valides, la comparaison n’est pas fiable.</p>
          </section>
        </div>

        {current && <Detail row={current} name={nameOf(current.ownerId)} onOpen={(stage) => setOpen({ ownerId: current.ownerId, stage })} onClose={() => setSelected(null)} />}
      </div>

      {open && <PopulationDrawer title={`${nameOf(open.ownerId)} — ${STAGE_LABELS[open.stage]}`} definition={STAGE_DEFINITIONS[open.stage]} leads={population} onClose={() => setOpen(null)} />}
    </>
  );
}

function Count({ v, onOpen }: { v: number; onOpen: () => void }) {
  return <td className="px-3 py-2.5 text-right tabular-nums"><button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="font-medium text-blue-700 hover:underline" title="Voir les leads">{fmtInt(v)}</button></td>;
}

function Detail({ row, name, onOpen, onClose }: { row: TeleproRow; name: string; onOpen: (s: Stage) => void; onClose: () => void }) {
  const max = Math.max(1, ...STAGES.map((s) => row.counts[s]));
  return (
    <aside className="h-fit rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{name}</h2>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800">Fermer</button>
      </div>
      <ul className="mt-3 space-y-1.5">
        {STAGES.map((s) => (
          <li key={s}>
            <button type="button" onClick={() => onOpen(s)} className="flex w-full items-center gap-2 text-left text-xs hover:opacity-80" title={STAGE_DEFINITIONS[s]}>
              <span className="w-32 flex-shrink-0 text-slate-600">{STAGE_LABELS[s]}</span>
              <span className="h-3 flex-1 rounded bg-slate-100"><span className="block h-3 rounded bg-blue-500" style={{ width: `${(row.counts[s] / max) * 100}%` }} /></span>
              <span className="w-8 text-right font-medium tabular-nums text-slate-900">{row.counts[s]}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Taux de passage</h3>
      <dl className="mt-2 space-y-1.5 text-sm">
        {(Object.keys(RATIO_DEFINITIONS) as (keyof typeof RATIO_DEFINITIONS)[]).map((k) => (
          <div key={k} className="flex items-baseline justify-between gap-2" title={RATIO_DEFINITIONS[k].formula}>
            <dt className="text-slate-600">{RATIO_DEFINITIONS[k].label}</dt>
            <dd className="font-medium tabular-nums text-slate-900">{fmtPct(row.ratios[k])}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-2" title={SLA_DEFINITION}><dt className="text-slate-600">SLA respecté</dt><dd className="font-medium tabular-nums text-slate-900">{fmtPct(row.slaRate)} <span className="text-xs font-normal text-slate-400">({row.slaRespected}/{row.slaMeasured})</span></dd></div>
      </dl>
      {row.lowVolume && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Volume faible : {row.attributed} leads valides.</p>}
      <Link to={`/utilisateurs/${row.ownerId}`} className="mt-4 block rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700">Voir le portefeuille</Link>
    </aside>
  );
}

/** Nuage de bulles : volume de leads valides (x) contre taux lead → vente (y). SVG, sans bibliothèque. */
function Scatter({ rows, nameOf, selected, onSelect, minVolume }: { rows: TeleproRow[]; nameOf: (id: string) => string; selected: string | null; onSelect: (id: string) => void; minVolume: number }) {
  const pts = rows.filter((r) => r.ratios.leadToSale !== null);
  if (pts.length === 0) return <p className="mt-3 text-sm text-slate-500">Pas encore de taux à comparer.</p>;
  const W = 640;
  const H = 220;
  const pad = { l: 40, r: 20, t: 12, b: 28 };
  const maxX = Math.max(10, ...pts.map((r) => r.attributed)) * 1.1;
  const maxY = Math.max(5, ...pts.map((r) => r.ratios.leadToSale as number)) * 1.2;
  const x = (v: number) => pad.l + (v / maxX) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Taux de conversion lead vers vente selon le volume de leads" className="mt-3 w-full">
      <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="#cbd5e1" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="#cbd5e1" />
      <line x1={x(minVolume)} y1={pad.t} x2={x(minVolume)} y2={H - pad.b} stroke="#f59e0b" strokeDasharray="4 4" />
      <text x={x(minVolume) + 4} y={H - pad.b - 6} fontSize="10" fill="#b45309">volume minimal</text>
      <text x={pad.l} y={H - pad.b + 12} fontSize="10" fill="#94a3b8" textAnchor="middle">0</text>
      <text x={W - pad.r} y={H - pad.b + 12} fontSize="10" fill="#94a3b8" textAnchor="end">{Math.round(maxX)}</text>
      <text x={W / 2} y={H - 2} fontSize="10" fill="#64748b" textAnchor="middle">Leads valides attribués</text>
      <text x={12} y={H / 2} fontSize="10" fill="#64748b" transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">Lead → vente (%)</text>
      <text x={pad.l - 4} y={y(0) + 3} fontSize="10" fill="#94a3b8" textAnchor="end">0</text>
      <text x={pad.l - 4} y={y(maxY) + 10} fontSize="10" fill="#94a3b8" textAnchor="end">{Math.round(maxY)}</text>
      {pts.map((r) => (
        <g key={r.ownerId} onClick={() => onSelect(r.ownerId)} className="cursor-pointer">
          <circle cx={x(r.attributed)} cy={y(r.ratios.leadToSale as number)} r={6 + Math.min(10, r.counts.sales)} fill={r.lowVolume ? '#fbbf24' : '#2563eb'} fillOpacity={selected === r.ownerId ? 0.9 : 0.55} stroke={selected === r.ownerId ? '#1e3a8a' : 'none'} />
          <title>{`${nameOf(r.ownerId)} : ${fmtPct(r.ratios.leadToSale)} sur ${r.attributed} leads valides`}</title>
          <text x={x(r.attributed)} y={y(r.ratios.leadToSale as number) - 12} fontSize="10" fill="#334155" textAnchor="middle">{nameOf(r.ownerId)}</text>
        </g>
      ))}
    </svg>
  );
}
