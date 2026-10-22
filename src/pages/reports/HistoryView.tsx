import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Mail, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { EXPORT_KIND_LABELS } from '../../domain/reports/exports';
import { emailsSettled, MAX_EMAIL_ATTEMPTS, RETENTION_DAYS, RUN_STATUS_LABELS, runLabel, SCHEDULE_TZ, type ExportRun, type RunFile } from '../../domain/reports/schedule';
import { fetchRunFile, fetchRuns, resendRunEmails } from '../../lib/exportsApi';
import { Feedback } from '../settings/settingsUi';
import { deliverFile } from './fileActions';
import { useRecipients } from './useScheduledExports';

const at = (ms: number): string => new Date(ms).toLocaleString('fr-FR', { timeZone: SCHEDULE_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const TONE: Record<ExportRun['status'], string> = { running: 'bg-amber-50 text-amber-700', ready: 'bg-emerald-50 text-emerald-700', error: 'bg-red-50 text-red-700', expired: 'bg-slate-100 text-slate-500' };

/** Résumé des envois d'un fichier : « 2 envoyés », « 1 en échec »… */
function mailSummary(f: RunFile): { text: string; failed: boolean } {
  const sent = f.recipients.filter((r) => r.status === 'sent').length;
  const failed = f.recipients.filter((r) => r.status === 'error').length;
  const pending = f.recipients.length - sent - failed;
  return { text: [sent && `${sent} envoyé${sent > 1 ? 's' : ''}`, failed && `${failed} en échec`, pending && `${pending} en attente`].filter(Boolean).join(' · '), failed: failed > 0 };
}

/**
 * Historique des rapports programmés (§22.10, fig. 34) : une ligne par exécution, avec l'état de chaque envoi. L'administrateur
 * voit tout et peut renvoyer ; un manager voit les fichiers qui lui sont destinés.
 */
export function HistoryView() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { recipients } = useRecipients();
  const [runs, setRuns] = useState<ExportRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const names = new Map(recipients.map((r) => [r.uid, r.name]));

  const load = useCallback(async () => {
    setError(null);
    const res = await fetchRuns();
    if (res.ok) setRuns(res.runs);
    else {
      setRuns([]);
      setError(res.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const download = async (run: ExportRun, scope: string) => {
    setBusy(`${run.id}:${scope}`);
    setNotice(null);
    const res = await fetchRunFile(run.id, scope);
    setBusy(null);
    if (!res.ok) return setNotice({ kind: 'error', text: res.message });
    try {
      deliverFile(res);
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : 'Téléchargement impossible.' });
    }
  };
  const resend = async (run: ExportRun) => {
    setBusy(run.id);
    setNotice(null);
    const res = await resendRunEmails(run.id);
    setBusy(null);
    setNotice(res.ok ? { kind: 'ok', text: 'Envois relancés.' } : { kind: 'error', text: res.message });
    void load();
  };

  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Historique des rapports programmés</h2>
          <p className="mt-0.5 text-xs text-slate-500">Fichiers conservés {RETENTION_DAYS} jours, puis supprimés ; la ligne reste. {isAdmin ? 'Vous voyez toutes les exécutions.' : 'Vous voyez les fichiers qui vous sont destinés.'}</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"><RefreshCw className="h-4 w-4" /> Actualiser</button>
      </div>
      <div className="mt-3"><Feedback errors={[]} notice={notice} /></div>
      {error && <p role="alert" className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {error}</p>}
      {runs === null ? <p className="mt-4 text-sm text-slate-500">Chargement…</p> : runs.length === 0 && !error ? <p className="mt-4 rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">Aucune exécution pour le moment.</p> : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 font-medium">Exécuté le</th><th className="py-2 font-medium">Rapport</th><th className="py-2 font-medium">Période</th><th className="py-2 font-medium">État</th><th className="py-2 font-medium">Fichiers et envois</th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-slate-100 align-top">
                  <td className="py-2.5 text-slate-600">{at(run.atMs)}<span className="block text-[11px] text-slate-400">{run.trigger === 'manual' ? 'Manuel' : 'Planifié'}</span></td>
                  <td className="py-2.5"><span className="font-medium text-slate-900">{run.scheduleName}</span><span className="block text-xs text-slate-500">{EXPORT_KIND_LABELS[run.kind]} · {run.format.toUpperCase()}</span></td>
                  <td className="py-2.5 text-xs text-slate-600">{runLabel(run)}</td>
                  <td className="py-2.5"><span className={cn('rounded px-2 py-0.5 text-xs font-medium', TONE[run.status])}>{RUN_STATUS_LABELS[run.status]}</span>{run.error && <span className="mt-1 block max-w-[220px] text-xs text-red-700">{run.error}</span>}</td>
                  <td className="py-2.5">
                    {run.files.map((f) => {
                      const sum = mailSummary(f);
                      return (
                        <div key={f.scope} className="mb-2 last:mb-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-slate-700">{f.scope === 'all' ? 'Fichier complet' : `Équipe de ${names.get(f.scope) ?? f.scope}`}</span>
                            <span className="text-[11px] text-slate-400">{f.rows} ligne{f.rows > 1 ? 's' : ''}</span>
                            {run.status === 'ready' && <button type="button" disabled={busy !== null} onClick={() => void download(run, f.scope)} aria-label={`Télécharger ${f.filename}`} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Download className="h-3 w-3" /> {busy === `${run.id}:${f.scope}` ? '…' : 'Télécharger'}</button>}
                          </div>
                          {isAdmin && (
                            <p className={cn('mt-0.5 flex items-start gap-1 text-xs', sum.failed ? 'text-red-700' : 'text-slate-500')}><Mail className="mt-0.5 h-3 w-3 flex-shrink-0" /> {sum.text}
                              {f.recipients.filter((r) => r.status === 'error').map((r) => <span key={r.uid} className="block">{names.get(r.uid) ?? r.uid} : {r.error} ({r.attempts}/{MAX_EMAIL_ATTEMPTS})</span>)}
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {run.notes.length > 0 && isAdmin && <ul className="mt-1 list-disc pl-4 text-xs text-amber-700">{run.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                    {isAdmin && run.status === 'ready' && !emailsSettled(run) && <span className="mt-1 block text-[11px] text-slate-400">Envois en cours ou à retenter automatiquement.</span>}
                    {isAdmin && run.status === 'ready' && run.files.some((f) => f.recipients.some((r) => r.status === 'error')) && <button type="button" disabled={busy !== null} onClick={() => void resend(run)} className="mt-1 inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-3 w-3" /> Renvoyer les envois en échec</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
