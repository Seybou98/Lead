import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Download, FileText, Loader2, Printer } from 'lucide-react';
import { fetchRunFile } from '../../lib/exportsApi';
import { deliverFile } from './fileActions';

type State = { kind: 'loading' } | { kind: 'error'; message: string; gone: boolean } | { kind: 'ready'; file: { filename: string; mime: string; content: string } };

/**
 * Page ouverte par le lien de l'email d'un rapport programmé. Le fichier n'est jamais dans l'email : il est lu par le serveur
 * après vérification de la connexion et du droit (administrateur, ou destinataire de ce fichier). Un CSV se télécharge ;
 * une page imprimable s'affiche et s'enregistre en PDF avec l'impression du navigateur.
 */
export function ExportDownloadPage() {
  const { runId = '' } = useParams();
  const [params] = useSearchParams();
  const scope = params.get('f') || 'all';
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await fetchRunFile(runId, scope);
    setState(res.ok ? { kind: 'ready', file: res } : { kind: 'error', message: res.message, gone: res.gone === true });
  }, [runId, scope]);
  useEffect(() => {
    void load();
  }, [load]);

  const isHtml = state.kind === 'ready' && state.file.mime.startsWith('text/html');
  return (
    <div className="w-full max-w-3xl">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/rapports" className="text-blue-600 hover:underline">Rapports</Link>
        <span className="mx-2">/</span>
        <span>Rapport programmé</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Rapport programmé</h1>

      {state.kind === 'loading' && <p className="mt-6 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement du fichier…</p>}
      {state.kind === 'error' && (
        <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5">
          <p className="flex items-center gap-2 font-semibold text-red-800"><AlertTriangle className="h-5 w-5" /> {state.gone ? 'Fichier supprimé' : 'Fichier indisponible'}</p>
          <p className="mt-1 text-sm text-red-900">{state.message}</p>
          <Link to="/rapports" className="mt-3 inline-block rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100">Aller aux rapports</Link>
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
          <p className="flex items-center gap-2 font-semibold text-slate-900"><FileText className="h-5 w-5 text-slate-500" /> {state.file.filename}</p>
          <p className="mt-1 text-sm text-slate-500">Données anonymisées. {isHtml ? 'Imprimez la page puis choisissez « Enregistrer au format PDF ».' : 'Le fichier s’ouvre directement dans Excel.'}</p>
          <button type="button" onClick={() => deliverFile(state.file)} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
            {isHtml ? <Printer className="h-4 w-4" /> : <Download className="h-4 w-4" />} {isHtml ? 'Imprimer / enregistrer en PDF' : 'Télécharger le fichier'}
          </button>
          {isHtml && <iframe title="Aperçu du rapport" sandbox="" srcDoc={state.file.content} className="mt-4 h-[28rem] w-full rounded-lg border border-slate-200" />}
        </div>
      )}
    </div>
  );
}
