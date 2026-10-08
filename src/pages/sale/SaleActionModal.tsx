import { useState } from 'react';
import { cn } from '../../lib/utils';
import { Modal } from '../../components/ui/Modal';
import { sendConversionAction } from '../../lib/conversionApi';
import { OFFER_CHANNELS, OFFER_CHANNEL_LABELS, SALE_ACTION_LABELS, type OfferChannel, type SaleAction } from '../../domain/sales/track';
import { formatEuros } from '../../domain/conversion/finance';
import { Feedback } from '../settings/settingsUi';
import { EuroField, Field, inputCls } from './saleUi';

const TITLES: Record<SaleAction['kind'], string> = {
  offer_sent: "Marquer l'offre envoyée",
  signed: 'Enregistrer la signature',
  deposit_expected: "Acompte attendu",
  deposit_received: "Acompte reçu",
  payment_confirmed: 'Confirmer le paiement',
  financing_started: 'Demande de financement',
  financing_accepted: 'Financement accepté',
  financing_refused: 'Financement refusé',
  cancel: 'Annuler la vente',
  retract: 'Rétractation du client',
  reminder: 'Relance du client',
};

const HELP: Partial<Record<SaleAction['kind'], string>> = {
  signed: "Le CRM ne signe pas à votre place : enregistrez ici la signature obtenue (contrat signé).",
  payment_confirmed: 'À confirmer seulement quand le règlement est réellement encaissé.',
  financing_accepted: "Seule la décision de l'organisme fait foi : confirmez uniquement une acceptation reçue.",
  cancel: "Une annulation est définitive : plus aucune action ne sera possible sur cette vente.",
  retract: "La rétractation est définitive : plus aucune action ne sera possible sur cette vente.",
};

/** Actions qui demandent une saisie ; les autres se confirment d'un clic. */
export const NEEDS_INPUT: SaleAction['kind'][] = ['offer_sent', 'signed', 'deposit_expected', 'financing_started', 'financing_refused', 'cancel', 'retract'];

/**
 * Enregistre une étape de la vente (§23.7 à §23.9). Le serveur contrôle l'enchaînement : l'écran ne propose que ce qui est
 * possible, et affiche tel quel un refus éventuel.
 */
export function SaleActionModal({ leadId, kind, remainderCents, onClose, onDone }: { leadId: string; kind: SaleAction['kind']; remainderCents?: number; onClose: () => void; onDone: (message: string) => void }) {
  const [channel, setChannel] = useState<OfferChannel>('email');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = (): SaleAction => {
    switch (kind) {
      case 'offer_sent': return { kind, channel };
      case 'signed': return { kind, note: text };
      case 'deposit_expected': return { kind, amountCents: amount };
      case 'financing_started': return { kind, organism: text };
      case 'financing_refused': return { kind, reason: text };
      case 'cancel': return { kind, reason: text };
      case 'retract': return { kind, reason: text };
      case 'reminder': return { kind, note: text };
      default: return { kind } as SaleAction;
    }
  };
  const valid =
    kind === 'deposit_expected' ? amount > 0 && (!remainderCents || amount <= remainderCents)
    : kind === 'financing_started' ? text.trim().length >= 2
    : kind === 'financing_refused' || kind === 'cancel' || kind === 'retract' ? text.trim().length >= 5
    : true;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await sendConversionAction(leadId, { kind: 'sale_action', action: build() });
    setBusy(false);
    if (r.ok) return onDone(r.message);
    setError(r.message);
  };
  const danger = kind === 'cancel' || kind === 'retract' || kind === 'financing_refused';

  return (
    <Modal
      title={TITLES[kind]}
      onClose={onClose}
      busy={busy}
      width="max-w-md"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Annuler</button>
          <button type="button" onClick={() => void submit()} disabled={busy || !valid} className={cn('rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50', danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700')}>
            {busy ? 'Enregistrement…' : kind === 'reminder' ? "J'ai relancé" : SALE_ACTION_LABELS[kind]}
          </button>
        </>
      }
    >
      {HELP[kind] && <p className="mb-4 text-sm text-slate-600">{HELP[kind]}</p>}
      {kind === 'offer_sent' && (
        <Field label="Canal d'envoi">
          <select className={cn(inputCls, 'w-full')} value={channel} onChange={(e) => setChannel(e.target.value as OfferChannel)}>
            {OFFER_CHANNELS.map((c) => <option key={c} value={c}>{OFFER_CHANNEL_LABELS[c]}</option>)}
          </select>
        </Field>
      )}
      {kind === 'deposit_expected' && (
        <Field label="Montant de l'acompte attendu" hint={remainderCents ? `Au plus le reste à charge : ${formatEuros(remainderCents)}` : undefined}>
          <EuroField cents={amount} ariaLabel="Montant de l'acompte" onChange={setAmount} />
        </Field>
      )}
      {kind === 'financing_started' && (
        <Field label="Organisme de financement">
          <input autoFocus className={cn(inputCls, 'w-full')} value={text} maxLength={80} placeholder="Floa, Domofinance, Sofinco…" onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {(kind === 'financing_refused' || kind === 'cancel' || kind === 'retract') && (
        <Field label="Motif (obligatoire)">
          <textarea autoFocus className={cn(inputCls, 'min-h-24 w-full')} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {(kind === 'signed' || kind === 'reminder') && (
        <Field label="Note (facultative)">
          <textarea className={cn(inputCls, 'min-h-20 w-full')} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {!NEEDS_INPUT.includes(kind) && kind !== 'reminder' && <p className="text-sm text-slate-700">Confirmer : {SALE_ACTION_LABELS[kind].toLowerCase()} ?</p>}
      <Feedback errors={[]} notice={error ? { kind: 'error', text: error } : null} />
    </Modal>
  );
}
