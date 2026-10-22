import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileClock } from 'lucide-react';
import { DRAFT_LABELS, type Draft, type DraftModule } from '../../domain/settings/publication';
import { discardDraft, errorMessage } from '../../lib/adminApi';

/**
 * Bandeau d'une page de réglage quand un brouillon existe (§21.9) : il n'affecte aucun lead ; on le teste, on mesure son impact,
 * puis on le publie. Les écrans de paramétrage montrent le brouillon ; le moteur et les télépros voient seulement le publié.
 */
export function DraftBanner({ module, draft }: { module: DraftModule; draft: Draft | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!draft) return null;

  const discard = async () => {
    if (!window.confirm(`Abandonner le brouillon « ${DRAFT_LABELS[module]} » ? Le réglage publié ne change pas.`)) return;
    setBusy(true);
    setError(null);
    try {
      await discardDraft(module);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <span className="flex items-start gap-2"><FileClock className="mt-0.5 h-4 w-4 flex-shrink-0" /> <span><strong>Brouillon en préparation</strong> (enregistré le {new Date(draft.meta.atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}) : il n’affecte aucun lead. Testez-le, mesurez son impact, puis publiez-le.</span></span>
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => void discard()} disabled={busy} className="text-xs underline hover:text-amber-950 disabled:opacity-50">Abandonner</button>
        <Link to={`/parametres/publier/${module}`} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">Tester et publier</Link>
      </span>
      {error && <p role="alert" className="w-full text-xs text-red-700">{error}</p>}
    </div>
  );
}
