import { useMemo, useState } from 'react';
import { Download, Info, Percent, TrendingUp, Wallet, ShoppingCart, Euro } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatEuros } from '../../domain/admin/campaignStats';
import { downloadText, toCsv } from '../../domain/csv';
import type { LeadListItem } from '../../domain/leads/leadList';
import type { ReportFilters } from '../../domain/reports/direction';
import { buildProfitReport, PROFIT_DEFINITIONS, PROFIT_DIMS, PROFIT_DIM_LABELS, profitabilityRows, profitPopulation, type ProfitDim, type ProfitRow, type ProfitSelector } from '../../domain/reports/profitability';
import type { ReportsData } from './useReportsData';
import { fmtInt, fmtPct, PopulationDrawer } from './ReportParts';

interface Open {
  title: string;
  definition: string;
  leads: readonly LeadListItem[];
}

const eur = (c: number | null) => formatEuros(c, 0);
const ratio = (n: number | null) => (n === null ? '—' : `× ${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`);

/**
 * Rentabilité (§22) : retour sur dépenses publicitaires. Le cahier ne définit pas de marge et le CRM n'a ni coût d'achat ni prix
 * du CRM principal : le chiffre d'affaires est le montant TTC du montage des ventes nettes, la marge est « d'acquisition ».
 */
export function ProfitabilityView({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const [dim, setDim] = useState<ProfitDim>('campaign');
  const [open, setOpen] = useState<Open | null>(null);

  const nameOf = (d: ProfitDim, key: string): string => {
    if (key === '—') return 'Non renseigné';
    if (d === 'source') return data.sources.find((s) => s.id === key)?.name ?? key;
    if (d === 'campaign') return data.names.campaigns.get(key) ?? key;
    if (d === 'owner') return data.names.users.get(key) ?? key;
    return key;
  };
  const report = useMemo(() => buildProfitReport({ leads: data.leads, spends: data.spends, campaigns: data.reportCampaigns, filters, dim }), [data.leads, data.spends, data.reportCampaigns, filters, dim]);
  const t = report.total;
  const exportCsv = () => downloadText(`rapport-rentabilite-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(['Rentabilité'], profitabilityRows(report, (k) => nameOf(dim, k))));
  const show = (title: string, definition: string, key: string | null, what: ProfitSelector) => setOpen({ title, definition, leads: profitPopulation(data.leads, data.reportCampaigns, filters, dim, key, what) });
  const marginTone = (c: number | null) => (c === null ? 'text-slate-400' : c < 0 ? 'text-red-600' : 'text-emerald-700');

  const card = (icon: React.ReactNode, tone: string, label: string, value: string, hint: string, sub?: string) => (
    <div title={hint} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <span className="min-w-0"><span className="block text-xs text-slate-500">{label}</span><span className="block text-xl font-bold tabular-nums text-slate-900">{value}</span>{sub && <span className="block text-[11px] text-slate-400">{sub}</span>}</span>
    </div>
  );
  const share = t.tally.revenueCents > 0 ? Math.round((t.tally.securedRevenueCents / t.tally.revenueCents) * 1000) / 10 : null;

  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {card(<Euro className="h-5 w-5 text-blue-600" />, 'bg-blue-50', 'Chiffre d’affaires TTC', eur(t.tally.revenueCents), PROFIT_DEFINITIONS.revenue, `${t.tally.sales} vente${t.tally.sales > 1 ? 's' : ''} nette${t.tally.sales > 1 ? 's' : ''}`)}
        {card(<Wallet className="h-5 w-5 text-amber-600" />, 'bg-amber-50', 'Dépenses publicitaires', t.tally.spendCents === null ? '—' : eur(t.tally.spendCents), PROFIT_DEFINITIONS.spend, t.tally.spendCents === null ? 'Aucune dépense attribuable' : undefined)}
        {card(<TrendingUp className="h-5 w-5 text-emerald-600" />, 'bg-emerald-50', 'Marge d’acquisition', t.marginCents === null ? '—' : eur(t.marginCents), PROFIT_DEFINITIONS.margin, 'CA − dépenses')}
        {card(<ShoppingCart className="h-5 w-5 text-violet-600" />, 'bg-violet-50', 'Retour sur dépenses', ratio(t.roas), PROFIT_DEFINITIONS.roas, t.basketCents === null ? undefined : `Panier moyen ${eur(t.basketCents)}`)}
        {card(<Percent className="h-5 w-5 text-rose-600" />, 'bg-rose-50', 'Coût d’acquisition', fmtPct(t.acquisitionRate), PROFIT_DEFINITIONS.acquisition, 'dépenses / CA')}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Info className="h-3.5 w-3.5" /> Retour sur dépenses publicitaires, pas une marge brute : le coût d’achat et la pose ne sont pas connus. Montant = TTC du montage du dossier.</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Exporter</button>
      </p>
      {t.tally.withoutAmount > 0 && (
        <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t.tally.withoutAmount} vente{t.tally.withoutAmount > 1 ? 's' : ''} nette{t.tally.withoutAmount > 1 ? 's' : ''} sans montant de montage : comptée{t.tally.withoutAmount > 1 ? 's' : ''} comme vente, absente{t.tally.withoutAmount > 1 ? 's' : ''} du chiffre d’affaires.{' '}
          <button type="button" className="font-semibold underline" onClick={() => show('Ventes sans montant', 'Ventes nettes dont le montage n’a pas de montant TTC.', null, 'noAmount')}>Voir la liste</button>
        </p>
      )}

      <section className="mt-4 rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Rentabilité par {PROFIT_DIM_LABELS[dim].toLowerCase()}</h2>
          <div role="tablist" aria-label="Dimension d’analyse" className="flex flex-wrap rounded-lg border border-slate-200 p-0.5 text-xs">
            {PROFIT_DIMS.map((d) => (
              <button key={d} role="tab" aria-selected={dim === d} type="button" onClick={() => setDim(d)} className={cn('rounded-md px-3 py-1 font-medium', dim === d ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{PROFIT_DIM_LABELS[d]}</button>
            ))}
          </div>
        </div>
        {report.spendUnavailable && <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-600">Une dépense se rattache à une campagne, pas à un télépro : par télépro, seuls les ventes et le chiffre d’affaires sont disponibles. Le total garde les dépenses.</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-3 py-2.5 font-medium">{PROFIT_DIM_LABELS[dim]}</th>
                <th className="px-3 py-2.5 text-right font-medium" title="Leads valides reçus pendant la période.">Leads</th>
                <th className="px-3 py-2.5 text-right font-medium">Ventes</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.revenue}>CA TTC</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.secured}>dont sécurisé</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.spend}>Dépenses</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.margin}>Marge d’acquisition</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.roas}>Retour</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.acquisition}>Coût / CA</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.basket}>Panier moyen</th>
                <th className="px-3 py-2.5 text-right font-medium" title={PROFIT_DEFINITIONS.cancelled}>Annulées</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-500">Aucune vente ni dépense sur cette période et ce périmètre.</td></tr>}
              {report.rows.map((r) => <Line key={r.key} r={r} label={nameOf(dim, r.key)} minVolume={report.minVolume} marginTone={marginTone} onOpen={(what, title, def) => show(`${nameOf(dim, r.key)} — ${title}`, def, r.key, what)} />)}
              {report.rows.length > 0 && <Line r={t} label="Ensemble" minVolume={report.minVolume} marginTone={marginTone} total onOpen={(what, title, def) => show(`Ensemble — ${title}`, def, null, what)} />}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">Part du CA sécurisé : {fmtPct(share)}. Chaque nombre de ventes ouvre la liste des leads. Les chiffres suivent le mode de date choisi (événement ou cohorte).</p>
      </section>

      <p className="mt-4 text-xs text-slate-400">Dernière actualisation : {new Date(now).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · données en temps réel, lecture seule.</p>
      {open && <PopulationDrawer title={open.title} definition={open.definition} leads={open.leads} onClose={() => setOpen(null)} />}
    </>
  );
}

function Line({ r, label, minVolume, marginTone, onOpen, total = false }: { r: ProfitRow; label: string; minVolume: number; marginTone: (c: number | null) => string; onOpen: (what: ProfitSelector, title: string, definition: string) => void; total?: boolean }) {
  const t = r.tally;
  const link = (n: number, what: ProfitSelector, title: string, def: string) => (n === 0 ? <span className="text-slate-300">0</span> : <button type="button" onClick={() => onOpen(what, title, def)} className="font-medium text-blue-700 hover:underline" title="Voir les leads">{fmtInt(n)}</button>);
  return (
    <tr className={cn('border-b border-slate-100', total && 'bg-slate-50 font-medium')}>
      <td className="px-3 py-2.5 font-medium text-slate-900">{label}{!total && r.lowVolume && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700" title={`Moins de ${minVolume} leads et ventes : lecture peu fiable.`}>volume faible</span>}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmtInt(t.leads)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{link(t.sales, 'sales', 'ventes', 'Ventes nettes de la période.')}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{eur(t.revenueCents)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{eur(t.securedRevenueCents)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{t.spendCents === null ? '—' : eur(t.spendCents)}</td>
      <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', marginTone(r.marginCents))}>{r.marginCents === null ? '—' : eur(r.marginCents)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{ratio(r.roas)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmtPct(r.acquisitionRate)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{r.basketCents === null ? '—' : eur(r.basketCents)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{link(t.cancelled, 'cancelled', 'ventes annulées', 'Ventes annulées ou rétractées sur la période : retirées du chiffre d’affaires.')}{t.cancelled > 0 && <span className="ml-1 text-[11px] text-red-500">−{eur(t.cancelledRevenueCents)}</span>}</td>
    </tr>
  );
}
