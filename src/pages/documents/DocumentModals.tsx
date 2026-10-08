import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Field, inputClass, Modal } from '../../components/ui/Modal';
import { DOCUMENT_CHANNELS } from '../../domain/call/outcomes';
import { buildReminderMessage, DECISION_CLOSE_REASONS, documentLabel, missingRows, type DecisionCloseReason, type DocRow } from '../../domain/documents/plan';
import { sendDocumentAction } from '../../lib/documentsApi';

type ChannelKey = keyof typeof DOCUMENT_CHANNELS;

/**
 * Relance documentaire (§10.4) : le CRM n'envoie rien (aucun canal de messagerie en V1) ; il fournit le message qui
 * cite exactement les pièces manquantes ou rejetées, puis enregistre la relance et planifie la suivante.
 */
export function FollowUpModal({ leadId, firstName, rows, onClose, onDone }: { leadId: string; firstName: string; rows: readonly DocRow[]; onClose: () => void; onDone: (message: string) => void }) {
  const [channel, setChannel] = useState<ChannelKey>('whatsapp');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const message = buildReminderMessage(firstName, rows);
  const pieces = missingRows(rows);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copie impossible : sélectionnez le texte et copiez-le à la main.');
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await sendDocumentAction(leadId, { kind: 'follow_up', channel, note: note.trim() || undefined });
    setBusy(false);
    if (r.ok) onDone(r.message);
    else setError(r.message);
  };

  return (
    <Modal
      title="Relancer le client"
      onClose={onClose}
      busy={busy}
      width="max-w-xl"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Annuler</button>
          <button type="button" onClick={submit} disabled={busy || pieces.length === 0} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Enregistrement…' : "J'ai relancé le client"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-slate-700">Pièces à réclamer</p>
          <ul className="mt-1.5 space-y-1 text-sm text-slate-700">
            {pieces.length === 0 && <li className="text-slate-500">Aucune pièce ne manque.</li>}
            {pieces.map((r) => (
              <li key={r.code}>• {documentLabel(r.code, r.label)}{r.status !== 'expected' ? ' — à redemander' : ''}</li>
            ))}
          </ul>
        </div>
        <Field label="Canal utilisé">
          <select className={inputClass} value={channel} onChange={(e) => setChannel(e.target.value as ChannelKey)}>
            {(Object.keys(DOCUMENT_CHANNELS) as ChannelKey[]).map((k) => (
              <option key={k} value={k}>{DOCUMENT_CHANNELS[k]}</option>
            ))}
          </select>
        </Field>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Message proposé</span>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline">
              {copied ? <><Check className="h-3.5 w-3.5" /> Copié</> : <><Copy className="h-3.5 w-3.5" /> Copier le message</>}
            </button>
          </div>
          <textarea readOnly rows={7} value={message} className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700" aria-label="Message de relance" />
        </div>
        <Field label="Note (facultatif)">
          <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Ex. a promis d'envoyer ce soir" />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

/** Décision obligatoire à J+14 : poursuivre, recycler ou clôturer avec motif (§10.4). */
export function DecisionModal({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: (message: string) => void }) {
  const [decision, setDecision] = useState<'continue' | 'recycle' | 'close'>('continue');
  const [reason, setReason] = useState<DecisionCloseReason>('not_interested');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (decision === 'close' && !comment.trim()) return setError('Clôture : le commentaire est obligatoire.');
    setBusy(true);
    const r = await sendDocumentAction(leadId, { kind: 'decide', decision, ...(decision === 'close' ? { closeReason: reason } : {}), comment: comment.trim() || undefined });
    setBusy(false);
    if (r.ok) onDone(r.message);
    else setError(r.message);
  };

  const choices: { key: typeof decision; title: string; hint: string }[] = [
    { key: 'continue', title: 'Poursuivre', hint: 'Le dossier reste ouvert, une nouvelle décision est planifiée dans une semaine.' },
    { key: 'recycle', title: 'Recycler', hint: 'Le lead quitte la file documentaire et reviendra plus tard (période creuse).' },
    { key: 'close', title: 'Clôturer', hint: 'Le lead est fermé, avec un motif obligatoire.' },
  ];

  return (
    <Modal
      title="Documents toujours incomplets : que décidez-vous ?"
      onClose={onClose}
      busy={busy}
      width="max-w-lg"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Annuler</button>
          <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Enregistrement…' : 'Valider la décision'}</button>
        </>
      }
    >
      <div className="space-y-3">
        {choices.map((c) => (
          <label key={c.key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${decision === c.key ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200'}`}>
            <input type="radio" name="decision" checked={decision === c.key} onChange={() => setDecision(c.key)} className="mt-1" />
            <span>
              <span className="block text-sm font-semibold text-slate-900">{c.title}</span>
              <span className="block text-xs text-slate-500">{c.hint}</span>
            </span>
          </label>
        ))}
        {decision === 'close' && (
          <Field label="Motif de clôture">
            <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as DecisionCloseReason)}>
              {(Object.keys(DECISION_CLOSE_REASONS) as DecisionCloseReason[]).map((k) => (
                <option key={k} value={k}>{DECISION_CLOSE_REASONS[k]}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={decision === 'close' ? 'Commentaire (obligatoire)' : 'Commentaire (facultatif)'}>
          <input className={inputClass} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
