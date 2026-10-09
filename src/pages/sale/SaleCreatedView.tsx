import { useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, Circle, ExternalLink, FileText, Folder, Info, RefreshCw, TriangleAlert, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { formatEuros } from '../../domain/conversion/finance';
import { sendConversionAction } from '../../lib/conversionApi';
import { Feedback } from '../settings/settingsUi';
import { ownerLabel, SaleCard, whenLabel } from './saleUi';
import { SaleTrackingCard } from './SaleTrackingCard';
import { MainStepsCard } from './MainStepsCard';
import type { ConversionView, SaleLead, SaleView } from './useSaleData';

const STEPS = ['Vente enregistrée', 'Client créé', 'Dossier créé', 'Documents transférés', 'Synchronisation confirmée'];

/** Adresse du CRM principal (optionnelle) : sans elle, le numéro de dossier est affiché sans lien. */
const MAIN_CRM_URL = (import.meta.env.VITE_MAIN_CRM_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/** Étapes de la transmission terminées (§11.8), déduites de ce que la conversion a déjà enregistré. */
export function transmissionSteps(c: Pick<ConversionView, 'state' | 'clientId' | 'dossierId' | 'documentsTransferred'> | null): boolean[] {
  return [true, !!c?.clientId, !!c?.dossierId, c?.documentsTransferred === true, c?.state === 'confirmed'];
}

function Tile({ icon, label, value, muted }: { icon: React.ReactNode; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className={cn('truncate text-lg font-bold tabular-nums', muted ? 'text-slate-400' : 'text-slate-900')}>{value}</p>
      </div>
    </div>
  );
}

/** Fig. 3 : la vente est créée ; la transmission au CRM principal est suivie étape par étape. */
export function SaleCreatedView({ leadId, lead, sale, conversion, names, backPath, canRetry = false, canTrack = false, canCancel = false }: { leadId: string; lead: SaleLead; sale: SaleView; conversion: ConversionView | null; names: ReadonlyMap<string, string>; backPath: string; canRetry?: boolean; canTrack?: boolean; canCancel?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const state = conversion?.state ?? 'pending';
  const steps = transmissionSteps(conversion);
  const firstTodo = steps.findIndex((x) => !x);
  const failed = state === 'failed';
  const confirmed = state === 'confirmed';
  const duplicate = failed && conversion?.lastError?.code === 'duplicate_dossier';
  const dossierUrl = confirmed && conversion?.dossierId && MAIN_CRM_URL ? `${MAIN_CRM_URL}/dossier/${conversion.dossierId}` : null;

  const retry = async (key: string, decision?: 'link' | 'create') => {
    setBusy(key);
    setNotice(null);
    const r = await sendConversionAction(leadId, { kind: 'transmit', decision });
    setBusy(null);
    setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
  };

  const recap: [string, string][] = [
    ['Client', sale.clientName || '—'],
    ['Solution', sale.productLabel || '—'],
    ['Adresse', sale.addressLabel || '—'],
    ['Reste à charge', formatEuros(sale.remainderCents)],
    ["MaPrimeRénov' (MPR)", formatEuros(sale.mprCents)],
    ["Certificats d'Économies d'Énergie (CEE)", formatEuros(sale.ceeCents)],
    ['Campagne', sale.campaignName ?? '—'],
    ['Téléprospecteur', ownerLabel(names, sale.createdBy)],
  ];
  if (sale.validatedBy) recap.push(['Validée par', ownerLabel(names, sale.validatedBy)]);
  const chain: [string, string][] = [['Lead ID', leadId], ['Vente ID', sale.number], ['Client ID', conversion?.clientId ?? '—'], ['Dossier ID', conversion?.dossierId ?? '—']];

  return (
    <div className="space-y-5">
      {confirmed ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle2 className="mt-0.5 h-6 w-6 flex-shrink-0 text-emerald-600" />
          <div>
            <p className="font-semibold text-emerald-900">La vente a été créée avec succès</p>
            <p className="text-sm text-emerald-800">{conversion?.linkedExisting ? 'Le lead est rattaché au dossier existant du CRM principal.' : 'Le client et son dossier ont été transmis au CRM principal.'}</p>
          </div>
        </div>
      ) : duplicate ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="flex items-center gap-2 font-semibold text-amber-900"><TriangleAlert className="h-5 w-5" /> Un dossier existe déjà pour ce contact</p>
          <p className="mt-1 text-sm text-amber-800">{conversion?.lastError?.message}</p>
          {canRetry ? (
            <div className="mt-3 flex flex-wrap gap-3">
              {conversion?.lastError?.duplicates[0] && (
                <button type="button" disabled={busy !== null} onClick={() => void retry('link', 'link')} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {busy === 'link' ? 'Rattachement…' : `Rattacher au dossier n° ${conversion.lastError.duplicates[0].clientNumber || conversion.lastError.duplicates[0].id}`}
                </button>
              )}
              <button type="button" disabled={busy !== null} onClick={() => void retry('create', 'create')} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {busy === 'create' ? 'Création…' : 'Créer un nouveau dossier quand même'}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-amber-800">Un manager ou un administrateur doit décider.</p>
          )}
        </div>
      ) : failed ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="flex items-center gap-2 font-semibold text-red-900"><TriangleAlert className="h-5 w-5" /> Vente créée — transmission échouée</p>
          <p className="mt-1 text-sm text-red-800">La vente est conservée et rien n&apos;est perdu. {conversion?.lastError?.message}</p>
          <p className="mt-1 text-xs text-red-700">Tentative {conversion?.attempts ?? 0} : la reprise est automatique, sans doublon.</p>
          {canRetry && (
            <button type="button" disabled={busy !== null} onClick={() => void retry('retry')} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
              <RefreshCw className={cn('h-4 w-4', busy === 'retry' && 'animate-spin')} /> {busy === 'retry' ? 'Reprise…' : 'Relancer la transmission'}
            </button>
          )}
        </div>
      ) : (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <Info className="mt-0.5 h-6 w-6 flex-shrink-0 text-blue-600" />
          <div>
            <p className="font-semibold text-blue-900">La vente {sale.number} est enregistrée</p>
            <p className="text-sm text-blue-800">La transmission au CRM principal est en cours. La vente ne sera pas recréée.</p>
            {canRetry && (
              <button type="button" disabled={busy !== null} onClick={() => void retry('retry')} className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:underline disabled:opacity-50">
                <RefreshCw className={cn('h-4 w-4', busy === 'retry' && 'animate-spin')} /> Relancer maintenant
              </button>
            )}
          </div>
        </div>
      )}
      <Feedback errors={[]} notice={notice} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={<FileText className="h-5 w-5" />} label="Vente" value={`#${sale.number}`} />
        <Tile icon={<UserRound className="h-5 w-5" />} label="Client" value={conversion?.clientId ? `#${conversion.clientId}` : 'En attente'} muted={!conversion?.clientId} />
        <Tile icon={<Folder className="h-5 w-5" />} label="Dossier CRM" value={conversion?.dossierId ? `#${conversion.dossierId}` : 'En attente'} muted={!conversion?.dossierId} />
        <Tile icon={<span className="text-lg font-bold">€</span>} label="Montant TTC" value={formatEuros(sale.totalTtcCents)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <SaleCard title="Récapitulatif de la vente">
          <dl className="space-y-2.5 text-sm">
            {recap.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{v}</dd></div>
            ))}
          </dl>
        </SaleCard>

        <SaleCard title="Transmission au CRM principal">
          <ol className="space-y-4">
            {STEPS.map((label, i) => {
              const ok = steps[i];
              const isFailed = failed && i === firstTodo;
              return (
                <li key={label} className="flex items-center gap-3 text-sm">
                  <span className={cn('flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', ok ? 'bg-blue-600 text-white' : isFailed ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-400')}>{i + 1}</span>
                  <div className="flex-1">
                    <p className="font-medium text-slate-800">{label}</p>
                    {i === 0 && <p className="text-xs text-slate-500">{whenLabel(sale.createdAtMs)}</p>}
                    {i === 3 && ok && conversion && <p className="text-xs text-slate-500">{conversion.documentsCount} pièce{conversion.documentsCount > 1 ? 's' : ''}</p>}
                  </div>
                  {ok ? <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">Terminé <Check className="h-4 w-4" /></span> : isFailed ? <span className="text-xs font-medium text-red-600">Échec</span> : <span className="flex items-center gap-1 text-xs text-slate-400">En attente <Circle className="h-3.5 w-3.5" /></span>}
                </li>
              );
            })}
          </ol>
        </SaleCard>

        <SaleCard title="Correspondance technique">
          <ol className="flex flex-wrap items-center gap-2 text-sm">
            {chain.map(([k, v], i) => (
              <li key={k} className="flex items-center gap-2"><span className="rounded-lg border border-slate-200 px-2.5 py-1.5"><span className="block text-xs text-slate-500">{k}</span><span className="block font-medium tabular-nums text-slate-900">{v}</span></span>{i < chain.length - 1 && <span className="text-slate-300">→</span>}</li>
            ))}
          </ol>
          {conversion && conversion.attempts > 0 && <p className="mt-3 text-xs text-slate-500">{conversion.attempts} tentative{conversion.attempts > 1 ? 's' : ''} de transmission.</p>}
        </SaleCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SaleTrackingCard leadId={leadId} lead={lead} remainderCents={sale.remainderCents} canTrack={canTrack} canCancel={canCancel} />
        </div>
        <MainStepsCard main={lead.mainStatus} />
      </div>

      <div className="flex flex-wrap gap-3">
        {dossierUrl && (
          <a href={dossierUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"><ExternalLink className="h-4 w-4" /> Voir le dossier CRM</a>
        )}
        <Link to={backPath} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Retour à ma file</Link>
      </div>
    </div>
  );
}
