import { AlertTriangle, ArrowRight, CheckCircle2, MinusCircle, Scale, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FAMILY_LABELS, loadRatio, type Family, type Portfolio, type TransferPlan } from '../../domain/portfolio/portfolio';
import type { UserRow } from '../../domain/admin/userRows';

export const FAMILY_ICON_TONE: Record<Family, string> = {
  newLeads: 'bg-blue-100 text-blue-600',
  callbacks: 'bg-orange-100 text-orange-600',
  interested: 'bg-emerald-100 text-emerald-600',
  documents: 'bg-violet-100 text-violet-600',
  filesToBuild: 'bg-red-100 text-red-600',
  recycling: 'bg-slate-100 text-slate-600',
};

function Bar({ used, cap, tone }: { used: number; cap: number; tone: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={loadRatio(used, cap)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${loadRatio(used, cap)}%` }} />
    </div>
  );
}

/** « Avant / après » (fig. 24) : la charge du télépro qui part, et celle de chaque destinataire une fois le transfert fait. */
export function BeforeAfter({ plan, from, portfolio, families }: { plan: TransferPlan; from: UserRow; portfolio: Portfolio; families: readonly Family[] }) {
  return (
    <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1fr]">
      <div className="rounded-xl border border-slate-200 p-4">
        <p className="text-sm font-semibold text-slate-900">Avant le transfert</p>
        <p className="text-xs text-slate-500">{from.name}</p>
        <div className="mt-3">
          <div className="flex justify-between text-xs"><span className="text-slate-500">Charge actuelle</span><span className="font-semibold text-blue-600">{from.newLeads ?? 0}/{from.cap ?? 0}</span></div>
          <div className="mt-1"><Bar used={from.newLeads ?? 0} cap={from.cap ?? 0} tone="bg-blue-500" /></div>
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          {families.map((f) => (
            <li key={f} className="flex items-center justify-between"><span className="flex items-center gap-2"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold', FAMILY_ICON_TONE[f])}>{FAMILY_LABELS[f][0]}</span>{FAMILY_LABELS[f]}</span><span className="font-semibold">{portfolio[f].length}</span></li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col items-center gap-2 text-xs text-slate-600">
        <ArrowRight className="h-6 w-6 text-blue-600" />
        <Scale className="h-5 w-5 text-slate-500" />
        <p className="font-medium">Règles d&apos;affectation</p>
        <ul className="space-y-1 text-left">
          {['Répartition par capacité disponible', 'Plafond de nouveaux leads respecté', 'Équilibrage selon la charge', 'Historique conservé'].map((r) => (
            <li key={r} className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> {r}</li>
          ))}
        </ul>
        <ArrowRight className="h-6 w-6 text-blue-600" />
      </div>

      <div className="rounded-xl border border-slate-200 p-4">
        <p className="text-sm font-semibold text-slate-900">Après le transfert</p>
        {plan.projections.length === 0 && <p className="mt-3 text-sm text-slate-500">Aucun destinataire ne reçoit d&apos;élément.</p>}
        <ul className="mt-3 space-y-3">
          {plan.projections.map((p) => (
            <li key={p.uid} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between text-sm"><span className="font-semibold text-slate-900">{p.name}</span><span className="text-xs text-slate-500">{p.received} élément{p.received > 1 ? 's' : ''}</span></div>
              <div className="mt-1 flex justify-between text-xs"><span className="text-slate-500">Charge projetée</span><span className={cn('font-semibold', p.saturated ? 'text-orange-600' : 'text-emerald-600')}>{p.newBefore}/{p.cap} → {p.newAfter}/{p.cap}</span></div>
              <div className="mt-1"><Bar used={p.newAfter} cap={p.cap} tone={p.saturated ? 'bg-orange-500' : 'bg-emerald-500'} /></div>
              {p.saturated && <p className="mt-1.5 flex items-center gap-1.5 text-xs text-orange-700"><AlertTriangle className="h-3.5 w-3.5" /> {p.name} atteindra sa capacité maximale</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** « Détail de la répartition » (fig. 24) : par catégorie, le volume, les destinataires et la règle appliquée. */
export function DetailTable({ plan, names }: { plan: TransferPlan; names: ReadonlyMap<string, string> }) {
  const RULE: Record<Family, string> = {
    newLeads: 'Priorité au télépro avec le plus de capacité',
    callbacks: 'Équilibrage selon la charge actuelle',
    interested: 'Équilibrage selon la charge actuelle',
    documents: 'Équilibrage selon la charge actuelle',
    filesToBuild: 'Équilibrage selon la charge actuelle',
    recycling: 'Équilibrage selon la charge actuelle',
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>{['Catégorie', 'Volume', 'Destination', 'Non attribués', 'Règle'].map((h) => <th key={h} scope="col" className="px-3 py-2.5 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {plan.rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Aucun élément sélectionné.</td></tr>}
          {plan.rows.map((r) => (
            <tr key={r.family}>
              <td className="px-3 py-2.5"><span className="flex items-center gap-2"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold', FAMILY_ICON_TONE[r.family])}>{FAMILY_LABELS[r.family][0]}</span>{FAMILY_LABELS[r.family]}</span></td>
              <td className="px-3 py-2.5 font-medium">{r.volume}</td>
              <td className="px-3 py-2.5 text-slate-700">{r.targets.length ? r.targets.map((t) => `${names.get(t.uid) ?? t.uid} (${t.count})`).join(', ') : '—'}</td>
              <td className={cn('px-3 py-2.5 font-medium', r.unassigned > 0 ? 'text-red-600' : 'text-slate-400')}>{r.unassigned}</td>
              <td className="px-3 py-2.5 text-xs text-slate-600">{RULE[r.family]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Contrôle avant transfert » : éléments sélectionnés = affectés + non attribués, toujours réconciliés. */
export function ReconcileBox({ plan }: { plan: TransferPlan }) {
  const { selected, assigned, unassigned } = plan.reconcile;
  const cell = (icon: React.ReactNode, value: number, label: string, tone: string) => (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-3"><span className={cn('flex h-10 w-10 items-center justify-center rounded-full', tone)}>{icon}</span><div><p className="text-xl font-bold text-slate-900">{value}</p><p className="text-xs text-slate-500">{label}</p></div></div>
  );
  return (
    <div className="space-y-2.5" aria-label="Contrôle avant transfert">
      {cell(<Users className="h-5 w-5" />, selected, 'éléments sélectionnés', 'bg-blue-50 text-blue-600')}
      {cell(<CheckCircle2 className="h-5 w-5" />, assigned, 'éléments affectés', 'bg-emerald-50 text-emerald-600')}
      {cell(<MinusCircle className="h-5 w-5" />, unassigned, 'éléments non attribués', unassigned > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500')}
      {plan.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          {plan.warnings.map((w) => <li key={w} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {w}</li>)}
        </ul>
      )}
    </div>
  );
}
