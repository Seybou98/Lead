import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MAIN_STAGE_LABELS, MAIN_STAGE_RANK, type MainStage } from '../../domain/mainSync/mainStatus';
import { SaleCard, whenLabel } from './saleUi';

/** Parcours du dossier dans le CRM principal (fig. 3 « Prochaines étapes du dossier »). */
const STEPS: { stage: MainStage; label: string }[] = [
  { stage: 'dossier_validated', label: 'Contrôle administratif' },
  { stage: 'client_created', label: 'Client à programmer' },
  { stage: 'scheduled', label: 'Planification chantier' },
  { stage: 'installed', label: 'Installation' },
  { stage: 'invoiced', label: 'Facturation' },
];

/** Étape lue dans le CRM principal par le planificateur (lecture seule) ; rien n'est modifiable depuis ici. */
export function MainStepsCard({ main }: { main: { stage: string; label: string; changedAtMs: number | null } | null }) {
  const stage = (main?.stage ?? null) as MainStage | null;
  const known = stage && stage in MAIN_STAGE_LABELS ? stage : null;
  const rank = known ? MAIN_STAGE_RANK[known] : -1;
  const cancelled = known === 'cancelled';
  const nextIndex = cancelled ? -1 : STEPS.findIndex((s) => MAIN_STAGE_RANK[s.stage] > rank);

  return (
    <SaleCard title="Prochaines étapes du dossier">
      {!known && <p className="text-sm text-slate-500">Le statut du dossier dans le CRM principal n&apos;a pas encore été lu (relecture toutes les 5 minutes).</p>}
      {known && (
        <>
          <p className={cn('mb-3 text-sm font-medium', cancelled ? 'text-red-700' : 'text-slate-800')}>
            CRM principal : {MAIN_STAGE_LABELS[known]}
            {main?.changedAtMs ? <span className="block text-xs font-normal text-slate-400">depuis le {whenLabel(main.changedAtMs)}</span> : null}
          </p>
          <ol className="space-y-3">
            {STEPS.map((s, i) => {
              const done = !cancelled && rank >= MAIN_STAGE_RANK[s.stage];
              const current = i === nextIndex;
              return (
                <li key={s.stage} className="flex items-center gap-3 text-sm">
                  <span className={cn('flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-emerald-500 text-white' : current ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400')}>
                    {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn(done || current ? 'font-medium text-slate-800' : 'text-slate-400')}>{s.label}</span>
                  <span className="ml-auto text-xs text-slate-400">{done ? 'Terminé' : current ? 'En cours' : 'En attente'}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </SaleCard>
  );
}
