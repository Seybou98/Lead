import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Modal } from '../../components/ui/Modal';
import { MODULE_LABELS, versionsOf, type VersionEntry, type VersionModule } from '../../domain/settings/versions';
import { checklistKey } from '../../domain/documents/checklist';
import { errorMessage, saveChecklist, saveConversion, saveReasons, saveRules, saveSla } from '../../lib/adminApi';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { useConfigData } from './useConfigData';

const MODULES: VersionModule[] = ['sla', 'rules', 'conversion', 'reasons', 'checklist'];

/**
 * Versions & publication (§21.9, fig. 25) : l'historique de chaque réglage et le retour arrière. Un retour arrière ne
 * détruit rien : il enregistre à nouveau l'ancienne valeur, ce qui crée une NOUVELLE version équivalente, elle-même tracée
 * (auteur, date, motif). Avant de confirmer, le périmètre touché est rappelé.
 */
export function VersionsPage() {
  const data = useConfigData();
  const [module, setModule] = useState<VersionModule>('sla');
  const [subject, setSubject] = useState<string>('');
  const [target, setTarget] = useState<VersionEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const families = useMemo(() => [...new Set([...data.coverage.map((c) => checklistKey(c.product)), 'default', ...data.audit.filter((a) => a.entityType === 'checklist').map((a) => a.entityId)])], [data.coverage, data.audit]);
  const labelOf = (key: string) => (key === 'default' ? 'Par défaut' : (data.coverage.find((c) => checklistKey(c.product) === key)?.product ?? key));
  const versions = useMemo(() => versionsOf(data.audit, module, module === 'checklist' ? (subject || undefined) : undefined), [data.audit, module, subject]);
  const nameOf = (uid: string) => data.userNames.get(uid) ?? (uid === 'engine' ? 'Moteur' : 'Administrateur');
  const now = Date.now();

  const restore = async () => {
    if (!target?.payload) return;
    setBusy(true);
    setNotice(null);
    const input = { ...target.payload, reason: `Retour à la version v${target.number}` };
    try {
      if (target.module === 'sla') await saveSla(input);
      else if (target.module === 'rules') await saveRules(input);
      else if (target.module === 'conversion') await saveConversion(input);
      else if (target.module === 'reasons') await saveReasons(input);
      else await saveChecklist(input as never);
      setNotice({ kind: 'ok', text: `Version v${target.number} rétablie : elle devient une nouvelle version, l'historique est conservé.` });
      setTarget(null);
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Versions &amp; publication</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Versions &amp; publication</h1>
      <p className="mt-1 text-slate-500">Chaque enregistrement d&apos;un réglage crée une version. Rétablissez une ancienne valeur sans rien perdre de l&apos;historique.</p>

      <div className="mt-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Modules">
        {MODULES.map((m) => (
          <button key={m} type="button" role="tab" aria-selected={module === m} onClick={() => { setModule(m); setNotice(null); }} className={cn('rounded-full border px-4 py-1.5 text-sm font-medium', module === m ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}>{MODULE_LABELS[m]}</button>
        ))}
        {module === 'checklist' && (
          <select aria-label="Famille de produit" value={subject} onChange={(e) => setSubject(e.target.value)} className="ml-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm">
            <option value="">Toutes les familles</option>
            {families.map((k) => <option key={k} value={k}>{labelOf(k)}</option>)}
          </select>
        )}
      </div>

      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
        </p>
      )}

      <section className="mt-4 rounded-xl border border-slate-200 bg-white" aria-label={`Versions : ${MODULE_LABELS[module]}`}>
        {versions.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">{data.loading ? 'Chargement…' : 'Aucune version enregistrée : ce réglage n’a jamais été modifié depuis Paramètres, les valeurs du cahier s’appliquent.'}</p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-slate-900">v{v.number}{module === 'checklist' ? ` — ${labelOf(v.subject)}` : ''}</span>
                    {v.current && <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">En vigueur</span>}
                    {v.deleted && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Suppression</span>}
                    <span className="text-slate-500">{new Date(v.atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {nameOf(v.actorId)} · il y a {sinceLabel(v.atMs, now)}</span>
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-slate-700">{v.changes.map((c) => <li key={c}>{c}</li>)}</ul>
                  {v.reason && <p className="mt-1 text-xs text-slate-500">Motif : {v.reason}</p>}
                </div>
                {!v.current && v.payload && (
                  <button type="button" onClick={() => { setNotice(null); setTarget(v); }} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><RotateCcw className="h-4 w-4" /> Rétablir cette version</button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="mt-3 text-xs text-slate-500">Les 300 enregistrements les plus récents du journal sont lus. Les règles de réattribution propres à une campagne ne sont pas versionnées ici.</p>

      {target && (
        <Modal
          title={`Rétablir la version v${target.number} ?`}
          onClose={() => setTarget(null)}
          busy={busy}
          width="max-w-lg"
          footer={
            <>
              <button type="button" onClick={() => setTarget(null)} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
              <button type="button" onClick={restore} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Enregistrement…' : 'Rétablir cette version'}</button>
            </>
          }
        >
          <p className="text-sm text-slate-700">La valeur de la version v{target.number} redevient celle en vigueur. Une <span className="font-medium">nouvelle version</span> est créée : aucune version antérieure n&apos;est détruite.</p>
          <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm">
            <p className="font-semibold text-slate-900">Périmètre concerné</p>
            <ul className="mt-2 space-y-1 text-slate-700">
              <li>{data.counts.activeCampaigns} campagne{data.counts.activeCampaigns > 1 ? 's' : ''} active{data.counts.activeCampaigns > 1 ? 's' : ''}</li>
              <li>{data.counts.telepros} télépro{data.counts.telepros > 1 ? 's' : ''} avec profil</li>
              <li>{data.counts.teams} équipe{data.counts.teams > 1 ? 's' : ''} active{data.counts.teams > 1 ? 's' : ''}</li>
            </ul>
            <p className="mt-3 text-xs text-slate-500">S&apos;applique aux prochains leads, appels et relances. Les échéances déjà programmées ne sont pas recalculées.</p>
          </div>
          <ul className="mt-4 list-disc space-y-0.5 pl-5 text-sm text-slate-700">{target.changes.map((c) => <li key={c}>{c}</li>)}</ul>
        </Modal>
      )}
    </div>
  );
}
