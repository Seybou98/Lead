import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, FileText, FolderOpen, UserPlus, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Modal } from '../../components/ui/Modal';
import { ABSENCE_TYPES, validateAbsence, type AbsenceType } from '../../domain/portfolio/absence';
import { consequencesOf, DEFAULT_HANDLING, FAMILIES, FAMILY_ELEMENT_LABELS, familiesToTransfer, HANDLING_OPTIONS, loadRatio, planTransfer, portfolioTotal, type Family, type Handling } from '../../domain/portfolio/portfolio';
import { sendAbsence } from '../../lib/portfolioApi';
import { runTransfer } from '../../lib/transferRunner';
import { usePortfolioData, type PortfolioData } from './usePortfolioData';
import { BeforeAfter, DetailTable, ReconcileBox } from './TransferParts';

const toLocalInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : Number.NaN);
const field = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

export function AbsencePage() {
  const { uid = '' } = useParams();
  return <AbsenceView data={usePortfolioData(uid)} uid={uid} />;
}

/**
 * Déclaration d'une absence (§20.6, fig. 23) : période, charge actuelle, conséquences, remplacement suggéré et
 * décision de traitement par famille de charge. Avant confirmation, les volumes et les risques sont présentés ; la
 * simulation du transfert montre exactement ce qui sera appliqué.
 */
export function AbsenceView({ data, uid }: { data: PortfolioData; uid: string }) {
  const navigate = useNavigate();
  const { row, portfolio, nowMs } = data;
  const [type, setType] = useState<AbsenceType>('leave');
  const [from, setFrom] = useState(() => toLocalInput(nowMs));
  const [to, setTo] = useState(() => toLocalInput(nowMs + 3 * 86_400_000));
  const [reason, setReason] = useState('');
  const [restore, setRestore] = useState(true);
  const [handling, setHandling] = useState<Handling>(DEFAULT_HANDLING);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);

  const consequences = useMemo(() => consequencesOf(portfolio, nowMs), [portfolio, nowMs]);
  const families = useMemo(() => familiesToTransfer(handling), [handling]);
  const selected = useMemo(() => families.flatMap((f) => portfolio[f]), [families, portfolio]);
  const plan = useMemo(() => (row ? planTransfer({ leads: selected, fromUid: uid, destination: { kind: 'engine' }, targets: data.targets }) : null), [row, selected, uid, data.targets]);
  const names = useMemo(() => new Map(data.targets.map((t) => [t.uid, t.name])), [data.targets]);

  if (!row) return <div className="w-full"><p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-600">{data.loading ? 'Chargement…' : "Ce télépro n'existe pas ou n'est pas dans votre périmètre."}</p></div>;

  const check = validateAbsence({ type, fromMs: fromLocalInput(from), toMs: fromLocalInput(to), reason, restoreDistribution: restore, handling }, nowMs);
  const errors = check.ok ? {} : check.errors;
  const best = plan?.projections[0] ?? null;
  const suggestion = data.targets.filter((t) => t.uid !== uid && t.canReceive).sort((a, b) => a.newLeads / (a.cap || 1) - b.newLeads / (b.cap || 1))[0] ?? null;
  const set = <F extends Family>(f: F, v: Handling[F]) => setHandling((h) => ({ ...h, [f]: v }));

  const submit = async (apply: boolean) => {
    setError(null);
    if (!check.ok) return setError(Object.values(check.errors)[0] ?? 'Saisie incomplète.');
    setBusy(apply ? 'apply' : 'save');
    const r = await sendAbsence(uid, { type, fromMs: check.draft.fromMs, toMs: check.draft.toMs, reason: check.draft.reason, restoreDistribution: restore, handling });
    if (!r.ok) {
      setBusy(null);
      return setError(r.message);
    }
    let message = r.message;
    if (apply && plan && plan.reconcile.selected > 0) {
      // L'absence est enregistrée : le télépro n'est plus candidat, le plan peut donc être appliqué tel que simulé.
      const out = await runTransfer({ fromUid: uid, plan, temporaryFamilies: handling.documents === 'transfer_temporarily' ? ['documents'] : [], returnAtMs: check.draft.toMs, reason: `Absence — ${check.draft.reason}` });
      message += ` ${out.done} élément${out.done > 1 ? 's' : ''} transféré${out.done > 1 ? 's' : ''}${out.failed ? `, ${out.failed} non transféré${out.failed > 1 ? 's' : ''} (${out.messages[0] ?? 'refusé'})` : ''}.`;
    }
    navigate(`/utilisateurs/${uid}`, { state: { notice: message } });
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to={data.role === 'admin' ? '/utilisateurs' : '/equipe'} className="text-blue-600 hover:underline">{data.role === 'admin' ? 'Utilisateurs' : 'Équipe'}</Link>
        <span className="mx-2">/</span>
        <Link to={`/utilisateurs/${uid}`} className="text-blue-600 hover:underline">{row.name}</Link>
        <span className="mx-2">/</span>
        <span>Nouvelle absence</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Déclarer une absence</h1>

      <div className="mt-4 flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-base font-semibold text-blue-700">{initials(row.name)}</span>
        <div><p className="font-semibold text-slate-900">{row.name}</p><p className="text-sm text-slate-500">{row.teamNames.length ? row.teamNames.join(', ') : 'Sans équipe'}</p></div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Période d&apos;absence</h2>
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-slate-700">Type
              <select aria-label="Type d'absence" className={field} value={type} onChange={(e) => setType(e.target.value as AbsenceType)}>
                {(Object.keys(ABSENCE_TYPES) as AbsenceType[]).map((k) => <option key={k} value={k}>{ABSENCE_TYPES[k]}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium text-slate-700">Du<input aria-label="Début de l'absence" type="datetime-local" className={field} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="block text-sm font-medium text-slate-700">à<input aria-label="Fin de l'absence" type="datetime-local" className={field} value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
            {errors.period && <p role="alert" className="text-xs text-red-600">{errors.period}</p>}
            <label className="block text-sm font-medium text-slate-700">Motif
              <textarea aria-label="Motif de l'absence" rows={3} maxLength={500} className={field} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. congé validé par le manager" />
            </label>
            {errors.reason && reason.length > 0 && <p role="alert" className="text-xs text-red-600">{errors.reason}</p>}
            <div className="flex items-center justify-between gap-3 text-sm text-slate-700">
              <span>Rétablir automatiquement la distribution au retour</span>
              <button type="button" role="switch" aria-checked={restore} aria-label="Rétablir automatiquement la distribution au retour" onClick={() => setRestore(!restore)} className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition-colors', restore ? 'bg-blue-600' : 'bg-slate-300')}>
                <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', restore ? 'left-[22px]' : 'left-0.5')} />
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Charge actuelle</h2>
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> Distribution en cours : cette absence impactera le traitement des éléments ci-dessous.</p>
          <ul className="mt-3 space-y-2.5 text-sm">
            {([['newLeads', 'nouveaux leads', Users], ['callbacks', 'rappels programmés', Clock], ['documents', 'suivis documentaires', FileText], ['filesToBuild', 'dossiers à monter', FolderOpen]] as const).map(([f, label, Icon]) => (
              <li key={f} className="flex items-center justify-between"><span><span className="mr-2 text-lg font-bold text-blue-600">{portfolio[f].length}</span>{label}</span><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500"><Icon className="h-4 w-4" /></span></li>
            ))}
          </ul>
          <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">{portfolioTotal(portfolio)} éléments ouverts au total.</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Conséquences</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {consequences.callbacksSoon > 0 && <li className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {consequences.callbacksSoon} rappel{consequences.callbacksSoon > 1 ? 's' : ''} dans les prochaines 24 h</li>}
            {consequences.nearSla > 0 && <li className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {consequences.nearSla} lead{consequences.nearSla > 1 ? 's' : ''} proche{consequences.nearSla > 1 ? 's' : ''} du SLA</li>}
            {consequences.promisedDocs > 0 && <li className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {consequences.promisedDocs} promesse{consequences.promisedDocs > 1 ? 's' : ''} documentaire{consequences.promisedDocs > 1 ? 's' : ''} à échéance</li>}
            {consequences.urgentFiles > 0 && <li className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {consequences.urgentFiles} dossier{consequences.urgentFiles > 1 ? 's' : ''} prêt{consequences.urgentFiles > 1 ? 's' : ''} à monter</li>}
            {Object.values(consequences).every((v) => v === 0) && <li className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Aucun risque immédiat détecté.</li>}
          </ul>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-sm font-semibold text-slate-900">Remplacement suggéré</p>
            {suggestion ? (
              <div className="mt-2 rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between text-sm"><span className="font-semibold text-slate-900">{suggestion.name}</span><span className="font-semibold text-violet-600">{suggestion.newLeads}/{suggestion.cap}</span></div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${loadRatio(suggestion.newLeads, suggestion.cap)}%` }} /></div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Aucun télépro disponible pour le remplacer.</p>
            )}
            <button type="button" onClick={() => setPreview(true)} disabled={!plan || plan.reconcile.selected === 0} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-blue-600 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
              <UserPlus className="h-4 w-4" /> Prévisualiser le transfert
            </button>
          </div>
        </section>
      </div>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Traitement du portefeuille</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th scope="col" className="py-2 font-medium">Élément</th><th scope="col" className="py-2 font-medium">Quantité actuelle</th><th scope="col" className="py-2 font-medium">Décision de traitement</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {FAMILIES.map((f) => (
              <tr key={f}>
                <td className="py-2.5 text-slate-700">{FAMILY_ELEMENT_LABELS[f]}</td>
                <td className="py-2.5 font-semibold text-blue-600">{portfolio[f].length}</td>
                <td className="py-2.5">
                  <select aria-label={`Décision : ${FAMILY_ELEMENT_LABELS[f]}`} className="w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm" value={handling[f]} onChange={(e) => set(f, e.target.value as never)}>
                    {HANDLING_OPTIONS[f].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {handling.interested === 'case_by_case' && portfolio.interested.length > 0 && <p className="mt-3 text-xs text-slate-500">Les leads intéressés restent chez {row.name} : à examiner un par un depuis son portefeuille.</p>}
      </section>

      {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}</p>}

      <div className="sticky bottom-0 z-10 -mx-3 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-3 py-4 backdrop-blur sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <Link to={`/utilisateurs/${uid}`} className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</Link>
        <button type="button" disabled={busy !== null} onClick={() => submit(false)} className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">{busy === 'save' ? 'Enregistrement…' : 'Enregistrer sans transfert'}</button>
        <button type="button" disabled={busy !== null} onClick={() => submit(true)} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{busy === 'apply' ? 'Application…' : "Confirmer l'absence et appliquer"}</button>
      </div>

      {preview && plan && (
        <Modal title="Aperçu du transfert" onClose={() => setPreview(false)} width="max-w-5xl" footer={<button type="button" onClick={() => setPreview(false)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Fermer</button>}>
          <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
            <div className="space-y-4">
              <BeforeAfter plan={plan} from={row} portfolio={portfolio} families={families} />
              <DetailTable plan={plan} names={names} />
              {best && <p className="text-xs text-slate-500">Le transfert est réparti par le moteur selon la capacité de chaque télépro, comme à l&apos;attribution d&apos;un nouveau lead.</p>}
            </div>
            <ReconcileBox plan={plan} />
          </div>
        </Modal>
      )}
    </div>
  );
}
