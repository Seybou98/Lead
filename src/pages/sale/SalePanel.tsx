import { useState } from 'react';
import { Hammer, Lock } from 'lucide-react';
import { useAuth } from '../../auth/AuthProvider';
import { LEAD_STATUS_LABELS } from '../../domain/labels';
import { sendDocumentAction } from '../../lib/documentsApi';
import { Feedback } from '../settings/settingsUi';
import { MontageView } from './MontageView';
import { SaleCreatedView } from './SaleCreatedView';
import { ValidationView } from './ValidationView';
import { useSaleData } from './useSaleData';

/**
 * Onglet « Vente » de la fiche (§11) : selon le statut du lead, montage du dossier (fig. 1), validation du manager
 * (fig. 2) ou vente créée et suivi de la transmission (fig. 3).
 */
export function SalePanel({ leadId, names, campaignName, backPath }: { leadId: string; names: ReadonlyMap<string, string>; campaignName: string | null; backPath: string }) {
  const { user } = useAuth();
  const data = useSaleData(leadId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (data.loading) return <p className="text-sm text-slate-500">Chargement…</p>;
  const lead = data.lead;
  if (data.error || !lead || !user) return <p role="alert" className="text-sm text-red-600">La lecture du dossier a échoué. Réessayez dans quelques instants.</p>;

  const isOwner = lead.ownerId === user.uid;
  const isManager = user.role === 'manager' && lead.managerIds.includes(user.uid);
  const isAdmin = user.role === 'admin';
  const canAct = isOwner || isManager || isAdmin;

  // Vente créée : elle existe, quel que soit le statut (transmission en cours, erreur, converti).
  if (data.sale) return <SaleCreatedView leadId={leadId} lead={lead} sale={data.sale} conversion={data.conversion} names={names} backPath={backPath} canRetry={isManager || isAdmin} canTrack={canAct} canCancel={isManager || isAdmin} />;

  if (lead.status === 'manager_validation') {
    return <ValidationView leadId={leadId} lead={lead} data={data} names={names} userId={user.uid} canDecide={isManager || isAdmin} campaignName={campaignName} />;
  }
  if (lead.status === 'file_building' || lead.status === 'file_ready') return <MontageView leadId={leadId} lead={lead} data={data} canAct={canAct} />;

  if (lead.status === 'file_ready_to_build') {
    const start = async () => {
      setBusy(true);
      setNotice(null);
      const r = await sendDocumentAction(leadId, { kind: 'start_building' });
      setBusy(false);
      setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
    };
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
        <p className="text-base font-semibold text-emerald-900">Dossier prêt à monter</p>
        <p className="mt-1 text-sm text-emerald-800">Toutes les pièces obligatoires sont conformes. Le montage reprend les informations déjà collectées : aucune ressaisie.</p>
        <Feedback errors={[]} notice={notice} />
        {canAct && (
          <button type="button" onClick={() => void start()} disabled={busy} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            <Hammer className="h-4 w-4" /> {busy ? 'Ouverture…' : 'Commencer le montage'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">
      <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
      <div>
        <p className="font-semibold text-slate-800">Le montage n&apos;est pas encore ouvert</p>
        <p className="mt-1">Il s&apos;ouvre automatiquement quand toutes les pièces obligatoires sont conformes (« Dossier prêt à monter »). Statut actuel : {LEAD_STATUS_LABELS[lead.status] ?? lead.status}.</p>
      </div>
    </div>
  );
}
