import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { AlertTriangle, CheckCircle2, Play, Timer } from 'lucide-react';
import { cn } from '../../lib/utils';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { ms } from '../../lib/firestoreViews';
import { sendSchedulerRun, type SchedulerReportView } from '../../lib/schedulerApi';
import { useNow } from '../leads/useLeadsData';
import { sinceLabel } from '../../domain/cockpit/cockpit';

/** Le planificateur passe toutes les 5 minutes : au-delà de ce retard, on le signale comme arrêté. */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * État du planificateur serveur (§15.1) : dernier passage et ce qu'il a fait. Un passage manuel est possible,
 * utile pour vérifier ou en développement où aucune planification n'existe.
 */
export function SchedulerStatusCard() {
  const now = useNow(30_000);
  const [last, setLast] = useState<{ atMs: number; report: SchedulerReportView } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onSnapshot(
        doc(db, COL.config, 'schedulerStatus'),
        (s) => {
          const at = ms(s.get('lastRunAt'));
          setLast(s.exists() && at !== null ? { atMs: at, report: s.get('report') as SchedulerReportView } : null);
        },
        () => setLast(null)
      ),
    []
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await sendSchedulerRun();
    setBusy(false);
    if (!r.ok) setError(r.message);
  };

  const stale = last === null || (last !== undefined && now - last.atMs > STALE_AFTER_MS);
  const r = last?.report;

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5" aria-label="Planificateur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Timer className="h-5 w-5" /></span>
          <div>
            <h2 className="font-semibold text-slate-900">Traitements automatiques</h2>
            <p className="mt-1 text-sm text-slate-600">Toutes les 5 minutes, même sans navigateur ouvert : alertes aux managers, recyclage des injoignables, attribution des leads en file tampon.</p>
          </div>
        </div>
        <button type="button" onClick={run} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <Play className="h-4 w-4" /> {busy ? 'Exécution…' : 'Exécuter maintenant'}
        </button>
      </div>

      <p className={cn('mt-4 flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm', stale ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800')} role="status">
        {stale ? <AlertTriangle className="h-4 w-4 flex-shrink-0" /> : <CheckCircle2 className="h-4 w-4 flex-shrink-0" />}
        {last === undefined
          ? 'Lecture de l’état…'
          : last === null
            ? 'Aucun passage enregistré : la planification n’est pas active (site non déployé, ou premier lancement).'
            : stale
              ? `Dernier passage il y a ${sinceLabel(last.atMs, now)} : le planificateur ne semble plus tourner.`
              : `Dernier passage il y a ${sinceLabel(last.atMs, now)}.`}
      </p>

      {r && (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          {[
            ['Leads examinés', r.leadsRead],
            ['Alertes envoyées', r.escalations],
            ['Mis en recyclage', r.recycled],
            ['Archivés', r.archived],
            ['Attribués depuis la file', r.assigned],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dd className="text-xl font-bold text-slate-900">{value}</dd>
              <dt className="text-xs text-slate-500">{label}</dt>
            </div>
          ))}
        </dl>
      )}
      {r && r.stillWaiting > 0 && <p className="mt-2 text-xs text-slate-500">{r.stillWaiting} lead{r.stillWaiting > 1 ? 's' : ''} en file tampon attend{r.stillWaiting > 1 ? 'ent' : ''} encore un télépro disponible.</p>}
      {r && r.errors.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 text-sm text-red-700">
          {r.errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}
