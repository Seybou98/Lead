import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatEuros } from '../../domain/conversion/finance';
import { FINANCIAL_STATES, SIGNATURE_STATES, type Tone } from '../../domain/sales/board';
import { availableSaleActions, isSecured, SALE_ACTION_LABELS, type SaleAction } from '../../domain/sales/track';
import { Feedback } from '../settings/settingsUi';
import { SaleActionModal } from './SaleActionModal';
import { SaleCard, whenLabel } from './saleUi';
import type { SaleLead } from './useSaleData';

const PILL: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  grey: 'bg-slate-100 text-slate-600',
};

/** Actions de l'état courant, dans l'ordre où on les rencontre ; la relance a sa propre place sur la carte de la vente. */
const ORDER: SaleAction['kind'][] = ['offer_sent', 'signed', 'deposit_expected', 'deposit_received', 'payment_confirmed', 'financing_started', 'financing_accepted', 'financing_refused'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 text-sm"><dt className="text-slate-500">{label}</dt><dd className="text-right font-medium text-slate-900">{children}</dd></div>;
}

/**
 * Suivi de la vente (§23.9) : les trois axes restent distincts et visibles ensemble. Le CRM n'envoie ni ne signe rien
 * lui-même : on enregistre ici ce qui s'est passé, le serveur contrôle l'enchaînement et la sécurisation.
 */
export function SaleTrackingCard({ leadId, lead, remainderCents, canTrack, canCancel }: { leadId: string; lead: SaleLead; remainderCents: number; canTrack: boolean; canCancel: boolean }) {
  const [modal, setModal] = useState<SaleAction['kind'] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const commercial = lead.commercialState;
  const financial = lead.financialState;
  const sig = SIGNATURE_STATES[commercial] ?? SIGNATURE_STATES.none;
  const fin = FINANCIAL_STATES[financial] ?? FINANCIAL_STATES.none;
  const secured = isSecured(commercial, financial);
  const t = lead.saleTrack;
  const closed = commercial === 'cancelled' || commercial === 'retracted';
  const offered = availableSaleActions(commercial, financial);
  const actions = ORDER.filter((k) => offered.includes(k));
  const destructive = (['cancel', 'retract'] as const).filter((k) => offered.includes(k));
  const docs = lead.docs.mandatory > 0 ? `${lead.docs.mandatoryConform}/${lead.docs.mandatory} conformes` : '—';

  return (
    <SaleCard title="Suivi de la vente">
      {secured && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-800"><CircleCheck className="h-4 w-4" /> Vente sécurisée : signée et réglée{lead.securedAtMs ? ` le ${whenLabel(lead.securedAtMs)}` : ''}.</p>
      )}
      {closed && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">Vente {commercial === 'cancelled' ? 'annulée' : 'rétractée'} : plus aucune action n'est possible.</p>}
      <dl className="space-y-2.5">
        <Row label="Signature"><span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', PILL[sig.tone])}>{sig.label}</span></Row>
        <Row label="Paiement / financement"><span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', PILL[fin.tone])}>{fin.label}</span></Row>
        <Row label="Documents"><span className="text-xs">{docs}</span></Row>
        {t?.offerSentAtMs ? <Row label="Offre envoyée">{whenLabel(t.offerSentAtMs)}</Row> : null}
        {t?.signedAtMs ? <Row label="Signée le">{whenLabel(t.signedAtMs)}</Row> : null}
        {t?.depositCents ? <Row label="Acompte attendu">{formatEuros(t.depositCents)}</Row> : null}
        {t?.financingOrganism ? <Row label="Organisme">{t.financingOrganism}</Row> : null}
        {t && t.reminderCount > 0 ? <Row label="Relances">{t.reminderCount}{t.lastReminderAtMs ? ` · dernière le ${whenLabel(t.lastReminderAtMs)}` : ''}</Row> : null}
      </dl>
      <Feedback errors={[]} notice={notice ? { kind: 'ok', text: notice } : null} />
      {canTrack && !closed && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {actions.map((k) => (
                <button key={k} type="button" onClick={() => setModal(k)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{SALE_ACTION_LABELS[k]}</button>
              ))}
            </div>
          )}
          {canCancel && destructive.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {destructive.map((k) => (
                <button key={k} type="button" onClick={() => setModal(k)} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">{SALE_ACTION_LABELS[k]}</button>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-400">La signature électronique, le règlement et le financement se font hors du CRM : enregistrez ici chaque étape. La vente n&apos;est sécurisée qu&apos;après signature et paiement confirmé ou financement accepté.</p>
        </div>
      )}
      {modal && (
        <SaleActionModal
          leadId={leadId}
          kind={modal}
          remainderCents={remainderCents}
          onClose={() => setModal(null)}
          onDone={(m) => {
            setModal(null);
            setNotice(m);
          }}
        />
      )}
    </SaleCard>
  );
}
