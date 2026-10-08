import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { dossierStage } from '../../domain/dossiers/board';
import { initialsOf } from '../sale/saleUi';
import { SalePanel } from '../sale/SalePanel';
import { useLeadFile } from '../leads/useLeadsData';
import { TONE_CLASS } from './DossiersPage';

/**
 * Fiche d'un dossier (figs. 1-3) : fil d'Ariane « Dossiers / client / étape », statut, propriétaire du lead, puis
 * le montage, la validation du manager ou la vente créée selon l'avancement.
 */
export function DossierPage() {
  const { leadId = '' } = useParams();
  const state = useLeadFile(leadId);
  const lead = state.lead;

  if (state.loading) return <div className="w-full"><p className="text-slate-500">Chargement…</p></div>;
  if (state.error || !lead) {
    return (
      <div className="w-full">
        <div role="alert" className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-slate-900">{state.error === 'unavailable' ? 'Dossier momentanément indisponible' : 'Dossier introuvable'}</h1>
          <p className="mt-2 text-sm text-slate-600">{state.error === 'unavailable' ? 'La lecture a échoué. Réessayez dans quelques instants.' : "Ce dossier n'existe pas ou n'est pas dans votre périmètre."}</p>
          <Link to="/dossiers" className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">Retour aux dossiers</Link>
        </div>
      </div>
    );
  }

  const stage = dossierStage(lead.status);
  const ownerName = lead.ownerId ? (state.names.users.get(lead.ownerId) ?? lead.ownerId) : null;
  const campaignName = lead.campaignId ? (state.names.campaigns.get(lead.campaignId) ?? lead.campaignId) : null;

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 text-sm text-slate-500">
        <Link to="/dossiers" className="hover:text-slate-900">Dossiers</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <Link to={`/leads/${lead.id}`} className="hover:text-slate-900" title="Ouvrir la fiche du lead">{lead.fullName || 'Contact sans nom'}</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-slate-700">{stage.title}</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{stage.title}</h1>
          <span className={cn('rounded-md px-2.5 py-1 text-xs font-semibold', TONE_CLASS[stage.tone])}>{stage.badge}</span>
        </div>
        {ownerName && (
          <p className="flex items-center gap-2 text-sm text-slate-600">
            Propriétaire du lead
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">{initialsOf(ownerName)}</span>
            <span className="font-medium text-slate-800">{ownerName}</span>
          </p>
        )}
      </header>

      <div className="mt-6">
        <SalePanel leadId={lead.id} names={state.names.users} campaignName={campaignName} backPath="/dossiers" />
      </div>
    </div>
  );
}
