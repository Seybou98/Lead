import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Save } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { LeadListItem } from '../../domain/leads/leadList';
import { answersToKeep, evaluate, type Answers } from '../../domain/qualification/form';
import { sendQualification } from '../../lib/qualificationApi';
import { FormFields } from './FormFields';
import { usePublishedQualification } from './useQualificationForm';

const STATUS_TEXT = { complete: 'Complète', incomplete: 'Incomplète', blocked: 'Bloquée' } as const;
const ELIG_TEXT = { ok: 'Aucune restriction', to_confirm: 'À confirmer', refused: 'Refusée' } as const;

/**
 * Formulaire de qualification d'un lead (§21.3) : le formulaire PUBLIÉ du produit, rempli par le télépro. Les conditions
 * s'appliquent en direct ; l'enregistrement est contrôlé par le serveur contre la même version du formulaire.
 */
export function LeadQualificationCard({ lead, canEdit }: { lead: LeadListItem; canEdit: boolean }) {
  const resolved = usePublishedQualification(lead.productCode);
  const saved = lead.qualificationForm;
  const [answers, setAnswers] = useState<Answers>(saved?.answers ?? {});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Une mise à jour venue du serveur remplace les réponses affichées, sauf saisie en cours.
  const savedKey = `${lead.id}:${saved?.savedAtMs ?? ''}`;
  useEffect(() => {
    if (dirty) return;
    setAnswers(saved?.answers ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const form = resolved.form;
  const ev = useMemo(() => (form ? evaluate(form, answers, lead.productCode) : null), [form, answers, lead.productCode]);
  const closed = ['converted', 'not_interested', 'ineligible', 'fake_lead', 'unreachable_archived'].includes(lead.status);

  if (resolved.loading) return <p className="text-sm text-slate-500">Chargement du formulaire…</p>;
  if (!form || !ev) {
    return <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">Aucun formulaire de qualification n’est publié pour {lead.productCode ? `le produit « ${lead.productCode} »` : 'ce lead'}. Il se configure dans Paramètres → Qualification.</p>;
  }

  const set = (id: string, v: unknown) => {
    setAnswers((a) => {
      const next = { ...a };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });
    setDirty(true);
    setNotice(null);
  };
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const r = await sendQualification({ leadId: lead.id, answers: answersToKeep(form, answers, lead.productCode) });
    setBusy(false);
    if (r.ok) {
      setDirty(false);
      setNotice({ kind: 'ok', text: r.message });
    } else setNotice({ kind: 'error', text: r.message });
  };
  const readOnly = !canEdit || closed;
  const outdated = saved && saved.version !== resolved.version;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div>
        {readOnly && <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{closed ? 'Ce lead est clôturé : la qualification est en lecture seule.' : 'Seul le propriétaire du lead, son manager ou un administrateur peut renseigner la qualification.'}</p>}
        <FormFields evaluation={ev} onChange={set} disabled={readOnly || busy} />
        {notice && (
          <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
            {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
          </p>
        )}
        {!readOnly && (
          <button type="button" onClick={save} disabled={busy || !dirty} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Save className="h-4 w-4" /> {busy ? 'Enregistrement…' : 'Enregistrer la qualification'}</button>
        )}
      </div>
      <aside className="space-y-3 text-sm">
        <div className={cn('rounded-lg border px-3 py-2.5', ev.status === 'complete' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : ev.status === 'blocked' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
          <p className="flex items-center gap-1.5 font-semibold">{ev.status === 'complete' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {STATUS_TEXT[ev.status]}</p>
          {ev.missing.length > 0 && <p className="mt-1 text-xs">Manquant : {ev.missing.map((id) => form.fields.find((f) => f.id === id)?.label ?? id).join(', ')}</p>}
          {ev.blocked.length > 0 && <p className="mt-1 text-xs">Bloquant : {ev.blocked.map((id) => form.fields.find((f) => f.id === id)?.label ?? id).join(', ')}</p>}
        </div>
        <p><span className="text-slate-500">Éligibilité :</span> <span className="font-medium text-slate-900">{ELIG_TEXT[ev.eligibility]}</span></p>
        {ev.alerts.map((a) => <p key={a} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {a}</p>)}
        <p className="text-xs text-slate-500">Formulaire v{resolved.version}{resolved.source === 'default' ? ' (par défaut)' : ''}{saved ? ` · dernier enregistrement avec la v${saved.version}` : ' · rien d’enregistré'}.</p>
        {outdated && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">Ces réponses ont été saisies avec la version v{saved?.version} ; la version en vigueur est la v{resolved.version}. Elles sont conservées : vérifiez les nouveaux champs, puis enregistrez.</p>}
      </aside>
    </div>
  );
}
