import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskConical } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Modal } from '../../components/ui/Modal';
import { ruleText } from '../../domain/qualification/describe';
import { evaluate, type Answers, type QualificationForm } from '../../domain/qualification/form';
import { FormFields } from './FormFields';

const STATUS_TEXT = { complete: 'Complète', incomplete: 'Incomplète', blocked: 'Bloquée' } as const;
const ELIG_TEXT = { ok: 'Aucune restriction', to_confirm: 'À confirmer', refused: 'Refusée' } as const;

/**
 * Prévisualisation et test (§21.3) : le formulaire est rempli avec des données FICTIVES, rien n'est enregistré et
 * aucun lead n'est touché. Le mode « test » explique quelle condition a produit quel effet.
 */
export function TestModal({ form, mode, productCode, onClose }: { form: QualificationForm; mode: 'preview' | 'test'; productCode: string | null; onClose: () => void }) {
  const [answers, setAnswers] = useState<Answers>({});
  const ev = useMemo(() => evaluate(form, answers, productCode), [form, answers, productCode]);
  const set = (id: string, v: unknown) => setAnswers((a) => {
    const next = { ...a };
    if (v === undefined) delete next[id];
    else next[id] = v;
    return next;
  });
  const fired = ev.fired.map((id) => form.rules.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);

  return (
    <Modal
      title={mode === 'preview' ? 'Prévisualisation du formulaire' : 'Tester les conditions'}
      onClose={onClose}
      width="max-w-4xl"
      footer={
        <>
          <button type="button" onClick={() => setAnswers({})} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Effacer les réponses</button>
          <button type="button" onClick={onClose} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Fermer</button>
        </>
      }
    >
      <p className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900"><FlaskConical className="h-4 w-4 flex-shrink-0" /> Données fictives : rien n’est enregistré, aucun lead n’est modifié.</p>
      {form.fields.length === 0 ? (
        <p className="text-sm text-slate-500">Le formulaire est vide : ajoutez des champs pour le prévisualiser.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <FormFields evaluation={ev} onChange={set} />
          <aside className="space-y-4 text-sm">
            <div className={cn('rounded-lg border px-3 py-2.5', ev.status === 'complete' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : ev.status === 'blocked' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
              <p className="flex items-center gap-1.5 font-semibold">{ev.status === 'complete' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} Qualification : {STATUS_TEXT[ev.status]}</p>
              {ev.missing.length > 0 && <p className="mt-1 text-xs">Manquant : {ev.missing.map((id) => form.fields.find((f) => f.id === id)?.label ?? id).join(', ')}</p>}
              {ev.blocked.length > 0 && <p className="mt-1 text-xs">Bloquant : {ev.blocked.map((id) => form.fields.find((f) => f.id === id)?.label ?? id).join(', ')}</p>}
            </div>
            <p><span className="text-slate-500">Éligibilité :</span> <span className="font-medium text-slate-900">{ELIG_TEXT[ev.eligibility]}</span></p>
            {ev.alerts.length > 0 && (
              <ul className="space-y-1">{ev.alerts.map((a) => <li key={a} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {a}</li>)}</ul>
            )}
            {mode === 'test' && (
              <div>
                <p className="font-semibold text-slate-900">Conditions déclenchées ({fired.length})</p>
                {fired.length === 0 ? <p className="mt-1 text-xs text-slate-500">Aucune condition ne se déclenche avec ces réponses.</p> : <ul className="mt-1 space-y-1">{fired.map((r) => <li key={r.id} className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">{ruleText(r, form.fields)}</li>)}</ul>}
              </div>
            )}
          </aside>
        </div>
      )}
    </Modal>
  );
}
