import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FlaskConical, Gauge, Rocket, FileClock } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { draftChanges, DRAFT_LABELS, DRAFT_PAGES, hasBlocking, impactOf, isDraftModule, isStale, simulateDraft, type DraftModule } from '../../domain/settings/publication';
import { errorMessage, publishDraft } from '../../lib/adminApi';
import { useLeadsList } from '../leads/useLeadsData';
import { inputCls } from './settingsUi';
import { useSettings } from './useSettings';
import { useConfigData } from './useConfigData';

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

function Step({ n, title, icon, done, children }: { n: number; title: string; icon: React.ReactNode; done: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label={title}>
      <h2 className="flex items-center gap-2.5 text-base font-semibold text-slate-900">
        <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-sm', done ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700')}>{done ? <CheckCircle2 className="h-4 w-4" /> : n}</span>
        <span className="text-blue-600">{icon}</span>{title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Cycle de publication d'un réglage (§21.9) : Brouillon → Tester → Vérifier l'impact → Publier. Rien de ce qui est fait ici
 * n'affecte un lead avant le dernier clic : la simulation utilise des données fictives, l'impact est une lecture.
 */
export function PublishPage() {
  const { module: param } = useParams();
  const { user } = useAuth();
  const settings = useSettings();
  const config = useConfigData();
  const leads = useLeadsList('admin', user?.uid ?? '');
  const [tested, setTested] = useState(false);
  const [seen, setSeen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const module: DraftModule | null = isDraftModule(param) ? param : null;
  const draft = module ? settings.drafts[module] : undefined;
  const raw = module ? settings.published[module] : undefined;
  const nowMs = useMemo(() => Date.now(), [draft?.meta.atMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(() => (module && draft ? draftChanges(module, raw, draft) : []), [module, raw, draft]);
  const sim = useMemo(() => (module && draft ? simulateDraft(module, draft.doc, { campaigns: config.campaigns }) : null), [module, draft, config.campaigns]);
  const impact = useMemo(() => (module && draft ? impactOf(module, raw, draft, leads.items, nowMs, { campaigns: config.campaigns }) : null), [module, raw, draft, leads.items, nowMs, config.campaigns]);
  const stale = draft ? isStale(draft, ms(raw?.updatedAt)) : false;
  const warnings = sim?.checks.filter((c) => c.level === 'warning') ?? [];

  const crumbs = (
    <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
      <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
      <span className="mx-2">/</span>
      {module && <><Link to={DRAFT_PAGES[module]} className="text-blue-600 hover:underline">{DRAFT_LABELS[module]}</Link><span className="mx-2">/</span></>}
      <span>Publication</span>
    </nav>
  );

  if (!module) return <div className="w-full">{crumbs}<p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Réglage inconnu.</p></div>;
  if (settings.loading) return <div className="w-full">{crumbs}<p className="mt-4 text-sm text-slate-500">Chargement…</p></div>;
  if (published) {
    return (
      <div className="w-full max-w-3xl">
        {crumbs}
        <p role="status" className="mt-5 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800"><CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0" /> <span><strong>{DRAFT_LABELS[module]} publié.</strong> Le nouveau réglage s’applique maintenant ; la version est tracée et peut être rétablie depuis « Versions & publication ».</span></p>
        <div className="mt-4 flex gap-3"><Link to="/parametres/versions" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Voir les versions</Link><Link to="/parametres" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Retour aux paramètres</Link></div>
      </div>
    );
  }
  if (!draft || !sim || !impact) {
    return (
      <div className="w-full max-w-3xl">
        {crumbs}
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Publication : {DRAFT_LABELS[module]}</h1>
        <p className="mt-4 rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">Aucun brouillon en préparation. Modifiez le réglage et enregistrez-le comme brouillon pour le tester puis le publier. <Link to={DRAFT_PAGES[module]} className="font-medium text-blue-700 hover:underline">Ouvrir le réglage</Link></p>
      </div>
    );
  }

  const blocking = hasBlocking(sim);
  const ready = tested && seen && !blocking && reason.trim().length >= 3 && (warnings.length === 0 || accepted);

  const publish = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await publishDraft(module, reason.trim(), force);
      setPublished(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-4xl">
      {crumbs}
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Publier : {DRAFT_LABELS[module]}</h1>
      <p className="mt-1 text-slate-500">Brouillon → Tester → Vérifier l’impact → Publier. Tant que vous n’avez pas publié, aucun lead, aucun télépro et aucune fonction du serveur ne voit ce brouillon.</p>
      {stale && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> Le réglage publié a changé depuis l’enregistrement de ce brouillon : le publier écraserait une modification plus récente. Ouvrez le brouillon, vérifiez-le et enregistrez-le de nouveau.</p>
      )}

      <div className="mt-5 space-y-5">
        <Step n={1} title="Brouillon" icon={<FileClock className="h-[18px] w-[18px]" />} done>
          <p className="text-xs text-slate-500">Enregistré le {new Date(draft.meta.atMs).toLocaleString('fr-FR')} · comparé à la version publiée</p>
          {changes.length === 0 ? <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">Ce brouillon est identique au réglage publié : rien à publier.</p> : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
          )}
          <Link to={DRAFT_PAGES[module]} className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline">Modifier le brouillon</Link>
        </Step>

        <Step n={2} title="Tester (données fictives)" icon={<FlaskConical className="h-[18px] w-[18px]" />} done={tested}>
          {!tested ? (
            <>
              <p className="text-sm text-slate-600">La simulation vérifie la cohérence et montre ce que donnerait ce réglage avec un lead fictif. Elle ne crée ni lead, ni dossier, ni tâche, ni message.</p>
              <button type="button" onClick={() => setTested(true)} className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Lancer le test</button>
            </>
          ) : (
            <>
              <ul className="space-y-1.5 text-sm">
                {sim.checks.map((c) => (
                  <li key={c.text} className={cn('flex items-start gap-2 rounded-lg px-3 py-2', c.level === 'error' ? 'bg-red-50 text-red-800' : c.level === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800')}>
                    {c.level === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />}
                    <span><strong>{c.level === 'error' ? 'Bloquant · ' : c.level === 'warning' ? 'Avertissement · ' : ''}</strong>{c.text}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">Résultat de la simulation</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">{sim.examples.map((e) => <li key={e}>{e}</li>)}</ul>
              {blocking && <p role="alert" className="mt-3 text-sm font-medium text-red-700">Des anomalies bloquantes empêchent la publication : corrigez le brouillon.</p>}
            </>
          )}
        </Step>

        <Step n={3} title="Vérifier l’impact" icon={<Gauge className="h-[18px] w-[18px]" />} done={seen}>
          {!tested ? <p className="text-sm text-slate-500">Lancez d’abord le test.</p> : (
            <>
              <p className="text-sm text-slate-600">{impact.active} lead{impact.active > 1 ? 's' : ''} actif{impact.active > 1 ? 's' : ''} dans votre périmètre{leads.truncated ? ' (lecture limitée aux plus récents)' : ''}.</p>
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {impact.lines.map((l) => (
                  <li key={l.label} className="px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">{l.label}</span>
                      {l.count === null ? <span className="text-slate-400">—</span> : l.leads && l.count > 0 ? <button type="button" onClick={() => setOpen(open === l.label ? null : l.label)} className="rounded-full bg-blue-50 px-2.5 py-0.5 font-semibold tabular-nums text-blue-700 hover:bg-blue-100">{l.count}</button> : <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-semibold tabular-nums text-slate-500">{l.count}</span>}
                    </div>
                    <p className="text-xs text-slate-500">{l.detail}</p>
                    {open === l.label && l.leads && (
                      <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{l.leads.slice(0, 12).map((x) => <li key={x.id}><Link to={`/leads/${x.id}`} className="text-blue-700 hover:underline">{x.fullName || x.id}</Link></li>)}{l.leads.length > 12 && <li className="text-slate-400">+ {l.leads.length - 12} autres</li>}</ul>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900"><strong>Stratégie pour les leads en cours :</strong> {impact.strategy}</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} /> J’ai pris connaissance de l’impact</label>
            </>
          )}
        </Step>

        <Step n={4} title="Publier" icon={<Rocket className="h-[18px] w-[18px]" />} done={false}>
          <label className="block text-sm"><span className="font-medium text-slate-700">Justification (obligatoire, conservée dans le journal)</span>
            <input aria-label="Justification de la publication" value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="Pourquoi publier ce changement ?" className={`${inputCls} mt-1 w-full`} />
          </label>
          {warnings.length > 0 && <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> J’accepte les {warnings.length} avertissement{warnings.length > 1 ? 's' : ''} du test</label>}
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={!ready || busy || stale || changes.length === 0} onClick={() => void publish(false)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Rocket className="h-4 w-4" /> {busy ? 'Publication…' : 'Publier'}</button>
            {stale && ready && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Publier quand même ? La modification publiée plus récemment sera écrasée (elle reste dans l’historique des versions).')) void publish(true); }} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">Publier quand même</button>}
            {!ready && <span className="text-xs text-slate-500">{!tested ? 'Lancez le test.' : !seen ? 'Confirmez l’impact.' : blocking ? 'Corrigez les anomalies bloquantes.' : reason.trim().length < 3 ? 'Saisissez la justification.' : 'Acceptez les avertissements.'}</span>}
          </div>
        </Step>
      </div>
    </div>
  );
}
