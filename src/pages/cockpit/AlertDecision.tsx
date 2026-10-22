import { useState } from 'react';
import { BellOff, CheckCircle2, Clock } from 'lucide-react';
import { ALERT_LABELS, POSTPONABLE, POSTPONE_CHOICES, type AlertKey, type PostponeKey } from '../../domain/cockpit/alertStates';
import { sendAlertAction } from '../../lib/cockpitAlertApi';
import { useSettings } from '../settings/useSettings';

const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

/**
 * Décision d'un manager sur une alerte (§12.6, §12.8) : la CLÔTURER avec un motif obligatoire (la situation n'est pas
 * corrigée) ou la REPORTER quand la règle l'autorise. Une alerte ne disparaît jamais par simple consultation.
 */
export function AlertDecision({ leadId, alertKey, sinceMs, onDone }: { leadId: string; alertKey: AlertKey; sinceMs: number; onDone: (message: string) => void }) {
  const { reasonCatalog } = useSettings();
  const reasons = reasonCatalog.active.alert_close;
  const [mode, setMode] = useState<'close' | 'postpone'>('close');
  const [code, setCode] = useState('');
  const [comment, setComment] = useState('');
  const [choice, setChoice] = useState<PostponeKey>('2h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPostpone = POSTPONABLE[alertKey];
  const needsComment = reasonCatalog.commentRequired.alert_close.includes(code);

  const submit = async () => {
    setError(null);
    if (mode === 'close') {
      if (!reasons[code]) return setError('Le motif de clôture est obligatoire.');
      if (needsComment && comment.trim().length < 3) return setError(`Motif « ${reasons[code]} » : précisez-le en commentaire.`);
    }
    setBusy(true);
    const r = await sendAlertAction(mode === 'close' ? { leadId, alertKey, sinceMs, action: 'close', reasonCode: code, comment: comment.trim() } : { leadId, alertKey, sinceMs, action: 'postpone', choice, comment: comment.trim() });
    setBusy(false);
    if (r.ok) onDone(r.message);
    else setError(r.message);
  };

  return (
    <section className="rounded-xl border border-slate-200 p-4" aria-label="Décision sur l’alerte">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BellOff className="h-4 w-4 text-blue-600" /> {ALERT_LABELS[alertKey]} : clôturer ou reporter</h3>
      <div role="radiogroup" aria-label="Décision" className="mt-3 flex gap-2 text-sm">
        <button type="button" role="radio" aria-checked={mode === 'close'} onClick={() => setMode('close')} className={`rounded-lg border px-3 py-1.5 ${mode === 'close' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>Clôturer avec un motif</button>
        <button type="button" role="radio" aria-checked={mode === 'postpone'} disabled={!canPostpone} title={canPostpone ? undefined : 'Un lead neuf hors SLA ne se reporte pas : traitez-le, réattribuez-le ou clôturez l’alerte avec un motif.'} onClick={() => setMode('postpone')} className={`rounded-lg border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'postpone' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>Reporter</button>
      </div>
      {mode === 'close' ? (
        <label className="mt-3 block text-sm">
          <span className="font-medium text-slate-700">Motif (obligatoire)</span>
          <select aria-label="Motif de clôture" value={code} onChange={(e) => setCode(e.target.value)} className={`${inputCls} mt-1`}>
            <option value="">Choisir un motif</option>
            {Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      ) : (
        <label className="mt-3 block text-sm">
          <span className="font-medium text-slate-700">Reporter de</span>
          <select aria-label="Durée du report" value={choice} onChange={(e) => setChoice(e.target.value as PostponeKey)} className={`${inputCls} mt-1`}>
            {POSTPONE_CHOICES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <span className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Clock className="h-3.5 w-3.5" /> L’alerte revient seule à l’échéance si la situation n’est pas corrigée.</span>
        </label>
      )}
      <input aria-label="Commentaire de la décision" value={comment} maxLength={400} onChange={(e) => setComment(e.target.value)} placeholder={mode === 'close' && needsComment ? 'Précisez (obligatoire)' : 'Commentaire (facultatif)'} className={`${inputCls} mt-2`} />
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void submit()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50">
        <CheckCircle2 className="h-4 w-4" /> {busy ? 'Enregistrement…' : mode === 'close' ? 'Clôturer l’alerte' : 'Reporter l’alerte'}
      </button>
    </section>
  );
}
