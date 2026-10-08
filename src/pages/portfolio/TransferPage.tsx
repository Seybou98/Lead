import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { AlertTriangle, ArrowLeft, ArrowRight, Calendar, Check, CheckCircle2, Layers, Save, User } from 'lucide-react';
import { cn } from '../../lib/utils';
import { consequencesOf, FAMILIES, FAMILY_LABELS, planTransfer, portfolioTotal, type Destination, type Family } from '../../domain/portfolio/portfolio';
import { runTransfer, type TransferOutcome } from '../../lib/transferRunner';
import { deleteTransferDraft, loadTransferDraft, saveTransferDraft, type StoredDraft } from '../../lib/transferDraft';
import type { TransferDraft } from '../../domain/portfolio/draft';
import { usePortfolioData, type PortfolioData } from './usePortfolioData';
import { BeforeAfter, DetailTable, FAMILY_ICON_TONE, ReconcileBox } from './TransferParts';

const STEPS = ['Analyse', 'Sélection', 'Destination', 'Simulation', 'Confirmation'] as const;
const CAUSES = ["Changement d'équipe", 'Absence longue', 'Départ du télépro', 'Rééquilibrage de la charge', 'Autre'] as const;
const field = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

export function TransferPage() {
  const { uid = '' } = useParams();
  const { user } = useAuth();
  return <TransferView data={usePortfolioData(uid)} uid={uid} actorUid={user?.uid ?? null} />;
}

/**
 * Transfert de portefeuille (§20.8, fig. 24) en cinq étapes : analyse de la charge, sélection des catégories, choix des
 * destinations, simulation avant/après, confirmation. La simulation vérifie les capacités et réconcilie toujours
 * éléments sélectionnés, affectés et non attribués ; le propriétaire historique est conservé.
 */
export function TransferView({ data, uid, actorUid = null }: { data: PortfolioData; uid: string; actorUid?: string | null }) {
  const { row, portfolio, nowMs } = data;
  const [step, setStep] = useState(1);
  const [cause, setCause] = useState<string>(CAUSES[0]);
  const [picked, setPicked] = useState<Set<Family>>(new Set(FAMILIES));
  const [destKind, setDestKind] = useState<'engine' | 'users' | 'team'>('engine');
  const [destUsers, setDestUsers] = useState<string[]>([]);
  const [destTeam, setDestTeam] = useState('');
  const [reasonOther, setReasonOther] = useState('');
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<TransferOutcome | null>(null);
  // Brouillon : choix du manager enregistrés pour reprendre plus tard (la simulation, elle, est toujours recalculée).
  const [stored, setStored] = useState<StoredDraft | null>(null);
  const [draftNotice, setDraftNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (!actorUid) return;
    let cancelled = false;
    loadTransferDraft(actorUid, uid)
      .then((d) => !cancelled && setStored(d))
      .catch(() => undefined); // un brouillon illisible ne bloque jamais le transfert
    return () => {
      cancelled = true;
    };
  }, [actorUid, uid]);
  const applyDraft = (d: TransferDraft) => {
    setStep(d.step);
    setCause(d.cause);
    setReasonOther(d.reasonOther);
    setPicked(new Set(d.families));
    setDestKind(d.destKind);
    setDestUsers(d.destUsers);
    setDestTeam(d.destTeam);
    setStored(null);
    setDraftNotice(null);
  };

  const destination: Destination = destKind === 'engine' ? { kind: 'engine' } : destKind === 'users' ? { kind: 'users', uids: destUsers } : { kind: 'team', teamId: destTeam };
  const families = FAMILIES.filter((f) => picked.has(f) && portfolio[f].length > 0);
  const selected = useMemo(() => families.flatMap((f) => portfolio[f]), [families, portfolio]);
  const plan = useMemo(() => planTransfer({ leads: selected, fromUid: uid, destination, targets: data.targets }), [selected, uid, destination, data.targets]);
  const names = useMemo(() => new Map(data.targets.map((t) => [t.uid, t.name])), [data.targets]);
  const consequences = useMemo(() => consequencesOf(portfolio, nowMs), [portfolio, nowMs]);
  const teams = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data.cockpit.rows) r.teamIds.forEach((id, i) => m.set(id, r.teamNames[i] ?? id));
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [data.cockpit.rows]);

  if (!row) return <div className="w-full"><p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-600">{data.loading ? 'Chargement…' : "Ce télépro n'existe pas ou n'est pas dans votre périmètre."}</p></div>;

  const reason = cause === 'Autre' ? reasonOther.trim() : cause;
  const destOk = destKind === 'engine' || (destKind === 'users' && destUsers.length > 0) || (destKind === 'team' && destTeam !== '');
  const canNext: Record<number, boolean> = { 1: portfolioTotal(portfolio) > 0, 2: families.length > 0, 3: destOk, 4: plan.reconcile.assigned > 0 && reason.length >= 3, 5: true };
  const total = portfolioTotal(portfolio);

  const confirm = async () => {
    setRunning({ done: 0, total: plan.reconcile.assigned });
    const out = await runTransfer({ fromUid: uid, plan, reason: `${cause === 'Autre' ? '' : `${cause} — `}${reason}`.replace(/ — $/, '') || reason, onProgress: (done, t) => setRunning({ done, total: t }) });
    setRunning(null);
    setOutcome(out);
    if (actorUid && out.done > 0) void deleteTransferDraft(actorUid, uid).catch(() => undefined); // le transfert est fait : le brouillon n'a plus lieu d'être
  };
  const saveDraft = async () => {
    if (!actorUid) return;
    setDraftNotice(null);
    try {
      await saveTransferDraft(actorUid, { fromUid: uid, step, cause, reasonOther, families: FAMILIES.filter((f) => picked.has(f)), destKind, destUsers, destTeam });
      setDraftNotice({ kind: 'ok', text: 'Brouillon enregistré. Vous pourrez reprendre ce transfert plus tard : la simulation sera recalculée avec la charge du moment.' });
    } catch {
      setDraftNotice({ kind: 'error', text: "Le brouillon n'a pas pu être enregistré (droits ou réseau)." });
    }
  };
  const dropDraft = async () => {
    if (!actorUid) return;
    await deleteTransferDraft(actorUid, uid).catch(() => undefined);
    setStored(null);
  };
  const toggleFamily = (f: Family) => setPicked((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to={data.role === 'admin' ? '/utilisateurs' : '/equipe'} className="text-blue-600 hover:underline">{data.role === 'admin' ? 'Utilisateurs' : 'Équipe'}</Link>
        <span className="mx-2">/</span>
        <Link to={`/utilisateurs/${uid}`} className="text-blue-600 hover:underline">{row.name}</Link>
        <span className="mx-2">/</span>
        <span>Transfert</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Transférer le portefeuille</h1>

      <ol className="mt-4 grid gap-2 rounded-xl border border-slate-200 bg-white p-2 sm:grid-cols-5" aria-label="Étapes">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = outcome ? true : n < step;
          return (
            <li key={label} aria-current={n === step ? 'step' : undefined} className={cn('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm', n === step ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-600')}>
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-emerald-500 text-white' : n === step ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600')}>{done ? <Check className="h-3.5 w-3.5" /> : n}</span>
              {label}
            </li>
          );
        })}
      </ol>

      {stored && !outcome && (
        <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <span>Un brouillon de ce transfert est enregistré{stored.savedAtMs ? ` (${new Date(stored.savedAtMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})` : ''}.</span>
          <span className="flex gap-3"><button type="button" onClick={() => applyDraft(stored.draft)} className="font-semibold underline">Reprendre le brouillon</button><button type="button" onClick={dropDraft} className="text-blue-700 underline">Supprimer</button></span>
        </div>
      )}
      {draftNotice && <p role={draftNotice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 rounded-lg border px-4 py-3 text-sm', draftNotice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>{draftNotice.text}</p>}

      {outcome ? (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-8 text-center" role="status">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
          <h2 className="mt-3 text-lg font-semibold text-slate-900">{outcome.done} élément{outcome.done > 1 ? 's' : ''} transféré{outcome.done > 1 ? 's' : ''}</h2>
          {outcome.failed > 0 && <p className="mt-1 text-sm text-red-700">{outcome.failed} non transféré{outcome.failed > 1 ? 's' : ''} : {outcome.messages[0] ?? 'refusé'}.</p>}
          {plan.reconcile.unassigned > 0 && <p className="mt-1 text-sm text-slate-600">{plan.reconcile.unassigned} élément{plan.reconcile.unassigned > 1 ? 's' : ''} resté{plan.reconcile.unassigned > 1 ? 's' : ''} chez {row.name} (capacité ou périmètre).</p>}
          <p className="mt-2 text-sm text-slate-500">{row.name} reste propriétaire historique des éléments transférés ; chaque lead garde sa chronologie.</p>
          <Link to={`/utilisateurs/${uid}`} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">Retour à la fiche</Link>
        </section>
      ) : (
        <>
          <div className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
            <p className="flex items-center gap-3 text-sm"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600"><User className="h-4 w-4" /></span><span><span className="block text-xs text-slate-500">Départ</span><span className="font-semibold text-slate-900">{row.name}</span></span></p>
            <p className="flex items-center gap-3 text-sm"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Calendar className="h-4 w-4" /></span><span><span className="block text-xs text-slate-500">Cause du transfert</span><span className="font-semibold text-slate-900">{cause}</span></span></p>
            <p className="flex items-center gap-3 text-sm"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Layers className="h-4 w-4" /></span><span><span className="block text-xs text-slate-500">Volume sélectionné</span><span className="font-semibold text-slate-900">{selected.length} élément{selected.length > 1 ? 's' : ''}</span></span></p>
          </div>

          {step === 1 && (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-base font-semibold text-slate-900">Analyse de la charge</h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {FAMILIES.map((f) => (
                  <li key={f} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm"><span className="flex items-center gap-2"><span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold', FAMILY_ICON_TONE[f])}>{FAMILY_LABELS[f][0]}</span>{FAMILY_LABELS[f]}</span><span className="text-lg font-bold text-slate-900">{portfolio[f].length}</span></li>
                ))}
              </ul>
              {(consequences.callbacksSoon > 0 || consequences.nearSla > 0 || consequences.promisedDocs > 0) && (
                <ul className="mt-4 space-y-1.5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  {consequences.callbacksSoon > 0 && <li className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {consequences.callbacksSoon} rappel{consequences.callbacksSoon > 1 ? 's' : ''} dans les prochaines 24 h</li>}
                  {consequences.nearSla > 0 && <li className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {consequences.nearSla} lead{consequences.nearSla > 1 ? 's' : ''} proche{consequences.nearSla > 1 ? 's' : ''} du SLA</li>}
                  {consequences.promisedDocs > 0 && <li className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {consequences.promisedDocs} promesse{consequences.promisedDocs > 1 ? 's' : ''} documentaire{consequences.promisedDocs > 1 ? 's' : ''} à échéance</li>}
                </ul>
              )}
              <label className="mt-4 block max-w-sm text-sm font-medium text-slate-700">Cause du transfert
                <select aria-label="Cause du transfert" className={field} value={cause} onChange={(e) => setCause(e.target.value)}>{CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              </label>
              {total === 0 && <p className="mt-4 text-sm text-slate-500">Ce portefeuille est vide : il n&apos;y a rien à transférer.</p>}
            </section>
          )}

          {step === 2 && (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-base font-semibold text-slate-900">Sélection des catégories</h2>
              <ul className="mt-3 space-y-2">
                {FAMILIES.map((f) => (
                  <li key={f}>
                    <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm', portfolio[f].length === 0 && 'cursor-not-allowed opacity-50')}>
                      <input type="checkbox" disabled={portfolio[f].length === 0} checked={picked.has(f) && portfolio[f].length > 0} onChange={() => toggleFamily(f)} />
                      <span className="flex-1">{FAMILY_LABELS[f]}</span>
                      <span className="font-semibold">{portfolio[f].length}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-slate-600">{selected.length} élément{selected.length > 1 ? 's' : ''} sélectionné{selected.length > 1 ? 's' : ''}.</p>
            </section>
          )}

          {step === 3 && (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-base font-semibold text-slate-900">Choix des destinations</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {([['engine', 'Moteur automatique', 'Répartition par capacité entre tous les télépros disponibles'], ['users', 'Un ou plusieurs utilisateurs', 'Vous choisissez les destinataires'], ['team', 'Une équipe', 'Répartition entre les membres de l’équipe']] as const).map(([k, title, hint]) => (
                  <label key={k} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', destKind === k ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200')}>
                    <input type="radio" name="dest" checked={destKind === k} onChange={() => setDestKind(k)} className="mt-1" />
                    <span><span className="block text-sm font-semibold text-slate-900">{title}</span><span className="block text-xs text-slate-500">{hint}</span></span>
                  </label>
                ))}
              </div>
              {destKind === 'users' && (
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {data.targets.filter((t) => t.uid !== uid).map((t) => (
                    <li key={t.uid}>
                      <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm', !t.canReceive && 'opacity-50')}>
                        <input type="checkbox" disabled={!t.canReceive} checked={destUsers.includes(t.uid)} onChange={(e) => setDestUsers(e.target.checked ? [...destUsers, t.uid] : destUsers.filter((x) => x !== t.uid))} />
                        <span className="flex-1">{t.name}</span><span className="text-xs text-slate-500">{t.canReceive ? `${t.newLeads}/${t.cap}` : 'indisponible'}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {destKind === 'team' && (
                <label className="mt-4 block max-w-sm text-sm font-medium text-slate-700">Équipe
                  <select aria-label="Équipe de destination" className={field} value={destTeam} onChange={(e) => setDestTeam(e.target.value)}><option value="">Choisir une équipe</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                </label>
              )}
            </section>
          )}

          {(step === 4 || step === 5) && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_300px]">
              <div className="space-y-4">
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="mb-3 text-base font-semibold text-slate-900">{step === 4 ? 'Simulation avant confirmation' : 'Récapitulatif'}</h2>
                  <BeforeAfter plan={plan} from={row} portfolio={portfolio} families={families} />
                </section>
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="mb-3 text-base font-semibold text-slate-900">Détail de la répartition</h2>
                  <DetailTable plan={plan} names={names} />
                </section>
              </div>
              <aside className="rounded-xl border border-slate-200 bg-white p-5 lg:self-start">
                <h2 className="text-base font-semibold text-slate-900">Contrôle avant transfert</h2>
                <div className="mt-3"><ReconcileBox plan={plan} /></div>
                <label className="mt-4 flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" checked disabled className="mt-0.5" /><span>Conserver {row.name} comme propriétaire historique<span className="block text-xs text-slate-500">Toujours appliqué : les performances passées restent attribuées à {row.name}.</span></span></label>
                <label className="mt-4 block text-sm font-medium text-slate-700">Raison du transfert <span className="text-red-600">*</span>
                  <select aria-label="Raison du transfert" className={field} value={cause} onChange={(e) => setCause(e.target.value)}>{CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                </label>
                {cause === 'Autre' && <input aria-label="Précisez la raison" className={field} value={reasonOther} maxLength={200} onChange={(e) => setReasonOther(e.target.value)} placeholder="Précisez (obligatoire)" />}
                <p className="mt-1 text-xs text-slate-500">Champ obligatoire</p>
              </aside>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-3 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-3 py-4 backdrop-blur sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
            {step > 1 ? <button type="button" disabled={running !== null} onClick={() => setStep(step - 1)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Retour</button> : <Link to={`/utilisateurs/${uid}`} className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</Link>}
            <span className="flex flex-wrap items-center gap-3">
              {actorUid && (
                <button type="button" disabled={running !== null} onClick={saveDraft} className="inline-flex items-center gap-2 rounded-lg border border-blue-600 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"><Save className="h-4 w-4" /> Enregistrer comme brouillon</button>
              )}
            {step < 5 ? (
              <button type="button" disabled={!canNext[step]} onClick={() => setStep(step + 1)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{step === 4 ? 'Continuer vers la confirmation' : 'Continuer'} <ArrowRight className="h-4 w-4" /></button>
            ) : (
              <button type="button" disabled={running !== null || plan.reconcile.assigned === 0 || reason.length < 3} onClick={confirm} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {running ? `Transfert en cours… ${running.done}/${running.total}` : `Confirmer le transfert de ${plan.reconcile.assigned} élément${plan.reconcile.assigned > 1 ? 's' : ''}`}
              </button>
            )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
