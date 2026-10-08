import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, CornerUpLeft, Hourglass, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DEFAULT_CONVERSION_RULES, evaluateControls } from '../../domain/conversion/controls';
import { formatEuros } from '../../domain/conversion/finance';
import { sendConversionAction } from '../../lib/conversionApi';
import { Feedback } from '../settings/settingsUi';
import { inputCls, LevelIcon, ownerLabel, SaleCard, SEVERITY_LABEL, whenLabel } from './saleUi';
import type { SaleData, SaleLead } from './useSaleData';

const MAX_COMMENT = 500;

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * Fig. 2 : le manager voit la demande, les exceptions, les valeurs du dossier, et décide. Le demandeur voit la même
 * page en lecture seule, sans bloc de décision.
 */
export function ValidationView({ leadId, lead, data, names, userId, canDecide, campaignName }: { leadId: string; lead: SaleLead; data: SaleData; names: ReadonlyMap<string, string>; userId: string; canDecide: boolean; campaignName: string | null }) {
  const v = data.validation;
  const draft = data.draft;
  const [comment, setComment] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const report = useMemo(() => (draft ? evaluateControls({ lead: { consent: lead.consent, productCode: lead.productCode }, draft, docs: lead.docs, qualificationMissing: [], rules: DEFAULT_CONVERSION_RULES }) : null), [draft, lead]);
  if (!draft || !report) return <p className="text-sm text-slate-500">Dossier introuvable.</p>;
  const recap = report.recap;
  const isRequester = v.requestedBy === userId;
  const mayDecide = canDecide && !isRequester;

  const decide = async (decision: 'approve' | 'refuse' | 'correction') => {
    setBusy(decision);
    setNotice(null);
    const r = await sendConversionAction(leadId, { kind: 'decide', decision, comment, acknowledged });
    setBusy(null);
    setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
  };
  const needComment = comment.trim().length < 5;

  return (
    <div className="space-y-5">
      {!mayDecide && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          <Hourglass className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p>
            {isRequester ? 'Votre demande est en attente de la décision du manager.' : 'Cette vente attend la décision du manager du dossier.'}
            {canDecide && isRequester ? ' Vous ne pouvez pas décider de votre propre demande.' : ''}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Prix TTC" value={formatEuros(recap.totalTtcCents)} hint={recap.discountCents > 0 ? `Dont remise commerciale : − ${formatEuros(recap.discountCents)}` : undefined} />
        <Kpi label="Aides estimées" value={formatEuros(recap.mprCents + recap.ceeCents)} hint="MaPrimeRénov' + CEE" />
        <Kpi label="Reste à charge" value={formatEuros(recap.remainderCents)} hint="À la charge du client" />
        <Kpi label="Contrôles" value={`${report.validated}/${report.total}`} hint={`${report.toConfirm.length} exception${report.toConfirm.length > 1 ? 's' : ''} à décider`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_320px]">
        <SaleCard title="Demande de validation">
          <p className="text-sm text-slate-600">
            Ce dossier nécessite une validation en raison de {v.exceptions.length} exception{v.exceptions.length > 1 ? 's' : ''} détectée{v.exceptions.length > 1 ? 's' : ''} par les contrôles automatiques.
          </p>
          <ul className="mt-4 space-y-3">
            {v.exceptions.map((e, i) => (
              <li key={e.key} className={cn('rounded-lg border p-3', e.severity === 'high' ? 'border-red-200 bg-red-50/50' : 'border-amber-200 bg-amber-50/50')}>
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    {e.severity === 'high' ? <XCircle className="h-4 w-4 text-red-600" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                    {i + 1}. {e.label}
                  </p>
                  <span className={cn('whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium', e.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800')}>{SEVERITY_LABEL[e.severity]}</span>
                </div>
                <p className="mt-1 text-sm text-slate-600">{e.detail}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-lg bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-600">Motif transmis par {ownerLabel(names, v.requestedBy)}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{v.message || '—'}</p>
          </div>
        </SaleCard>

        <SaleCard title="Règles internes et valeurs du dossier">
          <ul className="divide-y divide-slate-100">
            {report.controls.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>
                  <span className="block font-medium text-slate-800">{c.label}</span>
                  <span className="block text-xs text-slate-500">{c.detail}</span>
                </span>
                <LevelIcon level={c.level} />
              </li>
            ))}
          </ul>
        </SaleCard>

        <div className="space-y-5">
          <SaleCard title="Synthèse client">
            <dl className="space-y-2 text-sm">
              {[
                ['Client', draft.identity.fullName],
                ['Solution', draft.offer.lines.map((l) => l.label).join(' + ') || '—'],
                ['Campagne', campaignName ?? '—'],
                ['Documents', `${lead.docs.mandatoryConform} / ${lead.docs.mandatory} validés`],
                ['Propriétaire', ownerLabel(names, lead.ownerId)],
              ].map(([k, val]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{val}</dd></div>
              ))}
            </dl>
          </SaleCard>
          <SaleCard title="Historique de validation">
            <ol className="space-y-3 text-sm">
              <li className="flex gap-2.5"><Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" /><div><p className="font-medium text-slate-800">Dossier soumis par {ownerLabel(names, v.requestedBy)}</p><p className="text-xs text-slate-500">{whenLabel(v.requestedAtMs)}</p></div></li>
              {v.decidedAtMs !== null && <li className="flex gap-2.5"><CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" /><div><p className="font-medium text-slate-800">Décision de {ownerLabel(names, v.decidedBy)}</p><p className="text-xs text-slate-500">{whenLabel(v.decidedAtMs)}</p></div></li>}
            </ol>
          </SaleCard>
        </div>
      </div>

      {mayDecide && (
        <SaleCard title="Décision du manager">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Commentaire du manager (obligatoire en cas de demande de correction ou de refus)</span>
            <textarea className={cn(inputCls, 'min-h-24 w-full')} maxLength={MAX_COMMENT} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ajoutez un commentaire…" disabled={busy !== null} />
            <span className="mt-1 block text-xs text-slate-400">{comment.length} / {MAX_COMMENT}</span>
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={busy !== null} />
            <span>J'ai vérifié les éléments signalés<span className="block text-xs text-slate-400">Cette action confirme que vous avez examiné les exceptions et les valeurs du dossier.</span></span>
          </label>
          <Feedback errors={[]} notice={notice} />
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => void decide('correction')} disabled={busy !== null || needComment} className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"><CornerUpLeft className="h-4 w-4" /> Demander une correction</button>
            <button type="button" onClick={() => void decide('refuse')} disabled={busy !== null || needComment} className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"><XCircle className="h-4 w-4" /> Refuser</button>
            <button type="button" onClick={() => void decide('approve')} disabled={busy !== null || !acknowledged} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" /> Approuver la vente</button>
          </div>
        </SaleCard>
      )}
    </div>
  );
}
