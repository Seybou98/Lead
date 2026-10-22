import { Link } from 'react-router-dom';
import { Target } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OBJECTIVE_DIRECTION, OBJECTIVE_METRIC_LABELS, OBJECTIVE_SCOPE_LABELS, OBJECTIVE_STATUS_LABELS, OBJECTIVE_UNITS, type ObjectiveProgress, type ObjectiveStatus } from '../../domain/reports/targets';

export const STATUS_TONE: Record<ObjectiveStatus, { bar: string; text: string; dot: string }> = {
  achieved: { bar: 'bg-emerald-500', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  on_track: { bar: 'bg-emerald-400', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  at_risk: { bar: 'bg-amber-400', text: 'text-amber-700', dot: 'bg-amber-500' },
  behind: { bar: 'bg-red-500', text: 'text-red-700', dot: 'bg-red-500' },
  missed: { bar: 'bg-red-500', text: 'text-red-700', dot: 'bg-red-500' },
  upcoming: { bar: 'bg-slate-300', text: 'text-slate-500', dot: 'bg-slate-300' },
  na: { bar: 'bg-slate-300', text: 'text-slate-500', dot: 'bg-slate-300' },
};

const fmt = (n: number | null, unit: string) => (n === null ? '—' : `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);

/** Réalisé / cible d'un objectif, avec un point de couleur : pour une colonne de tableau. */
export function ObjectiveCell({ p }: { p: ObjectiveProgress | null }) {
  if (!p) return <span className="text-slate-300">—</span>;
  const unit = OBJECTIVE_UNITS[p.objective.metric];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums" title={`${OBJECTIVE_STATUS_LABELS[p.status]}${p.projected !== null ? ` · estimation de fin de mois : ${p.projected}` : ''}`}>
      <span className={cn('h-2 w-2 rounded-full', STATUS_TONE[p.status].dot)} />
      {fmt(p.actual, unit)} / {fmt(p.objective.target, unit)}
      {p.pct !== null && <span className={cn('text-xs', STATUS_TONE[p.status].text)}>{Math.round(p.pct)} %</span>}
    </span>
  );
}

/** Jauges des objectifs du mois : réalisé, cible, avancement du mois et estimation de fin de mois. */
export function ObjectiveGauges({ items, month, scopeName }: { items: ObjectiveProgress[]; month: string | null; scopeName: (scope: string, id: string) => string }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Target className="h-4 w-4 text-rose-600" /> Objectifs du mois</h2>
        <Link to="/parametres/objectifs" className="text-xs font-medium text-blue-700 hover:underline">Régler</Link>
      </div>
      {month === null ? (
        <p className="mt-3 text-sm text-slate-500">Les objectifs se lisent sur un mois civil : choisissez « Ce mois » ou « Mois précédent ».</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Aucun objectif actif pour {month} sur ce périmètre.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {items.map((p) => {
            const o = p.objective;
            const unit = OBJECTIVE_UNITS[o.metric];
            const width = Math.min(100, Math.max(0, p.pct ?? 0));
            return (
              <li key={o.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">{OBJECTIVE_METRIC_LABELS[o.metric]}{o.scope !== 'global' && <span className="ml-1.5 text-xs font-normal text-slate-500">{OBJECTIVE_SCOPE_LABELS[o.scope]} : {scopeName(o.scope, o.scopeId)}</span>}</span>
                  <span className={cn('text-xs font-medium', STATUS_TONE[p.status].text)}>{OBJECTIVE_STATUS_LABELS[p.status]}</span>
                </div>
                <div className="relative mt-1.5 h-3 rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(p.pct ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-label={`${OBJECTIVE_METRIC_LABELS[o.metric]} : ${Math.round(p.pct ?? 0)} % de l’objectif`}>
                  <div className={cn('h-3 rounded-full', STATUS_TONE[p.status].bar)} style={{ width: `${width}%` }} />
                  {OBJECTIVE_DIRECTION[o.metric] === 'min' && p.status !== 'upcoming' && p.elapsedPct < 100 && <span className="absolute top-[-3px] h-[18px] w-px bg-slate-500" style={{ left: `${p.elapsedPct}%` }} title={`${Math.round(p.elapsedPct)} % du mois écoulé`} />}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {OBJECTIVE_DIRECTION[o.metric] === 'max' ? 'Coût actuel ' : 'Réalisé '}<strong className="text-slate-700">{fmt(p.actual, unit)}</strong> pour {OBJECTIVE_DIRECTION[o.metric] === 'max' ? 'un plafond de' : 'une cible de'} {fmt(o.target, unit)}
                  {p.projected !== null && <> · <span title="Estimation au rythme observé, recalculée à chaque mise à jour">estimation de fin de mois : {p.projected}</span></>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
