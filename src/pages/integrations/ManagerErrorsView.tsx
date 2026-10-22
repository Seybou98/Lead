import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import type { JournalEntry } from '../../domain/integrations/hub';
import { fetchTransmissionErrors } from '../../lib/hubApi';
import { useNow } from '../leads/useLeadsData';
import { fmtShort } from './useJournal';

/**
 * Ce que le hub montre à un manager (§24.11) : les transmissions au CRM principal en échec pour les leads de son équipe, avec
 * leur cause et leur ancienneté. Ni donnée brute, ni charge utile, ni secret ; la reprise se fait sur la fiche du dossier.
 */
export function ManagerErrorsView() {
  const now = useNow(60_000);
  const [state, setState] = useState<{ loading: boolean; error: string | null; entries: JournalEntry[]; truncated: boolean }>({ loading: true, error: null, entries: [], truncated: false });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = await fetchTransmissionErrors();
    setState(r.ok ? { loading: false, error: null, entries: r.entries, truncated: r.truncated } : (s) => ({ ...s, loading: false, error: r.message }));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Erreurs de transmission</h1>
          <p className="mt-1 text-slate-500">Les dossiers de votre équipe qui n’ont pas pu être transmis au CRM principal. Ouvrez le dossier pour relancer la transmission.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={state.loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"><RefreshCw className="h-4 w-4" /> Actualiser</button>
      </div>
      {state.error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {state.error}</p>}
      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3 font-medium">Dossier</th><th className="px-3 py-3 font-medium">Cause</th><th className="px-3 py-3 text-right font-medium">Tentatives</th><th className="px-3 py-3 font-medium">Dernier essai</th><th className="px-3 py-3" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {state.loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Chargement…</td></tr>}
            {!state.loading && !state.error && state.entries.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-emerald-700"><span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Aucune transmission en erreur dans votre équipe.</span></td></tr>}
            {state.entries.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="px-3 py-3 font-mono text-xs text-slate-700">{e.reference}</td>
                <td className="px-3 py-3 text-slate-800">{e.error?.message ?? 'Transmission échouée.'}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-600">{e.attempts ?? '—'}</td>
                <td className="px-3 py-3 text-slate-600">{fmtShort(e.atMs)}<span className="block text-xs text-slate-400">il y a {sinceLabel(e.atMs, now)}</span></td>
                <td className="px-3 py-3 text-right">{e.leadId && <Link to={`/dossiers/${e.leadId}`} className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50">Ouvrir le dossier</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.truncated && <p className="mt-2 text-xs text-slate-500">Lecture bornée : seules les erreurs les plus récentes sont affichées.</p>}
    </div>
  );
}
