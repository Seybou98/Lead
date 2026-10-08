import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { DEFAULT_RULES_SETTINGS, formatDelay, validateRulesSettings, type RulesSettings } from '../../domain/settings/settings';
import { errorMessage, saveRules } from '../../lib/adminApi';
import { useSettings } from './useSettings';
import { DelayField, Feedback, inputCls, NumberField, SaveBar, SettingsCard } from './settingsUi';

const FIXED_CALLBACK_STEPS = [
  ['H-5 min', 'Notification « Rappel dans 5 minutes »'],
  ['Heure exacte', 'Carte P0 « Rappel client » avec le bouton Appeler'],
  ['+5 min', 'Retard orange'],
  ['+15 min', 'Retard rouge'],
] as const;

/**
 * Cycles NR, rappels et documents (§8, §10.4, §14) : la matrice des tentatives NR1 à NR5, le recyclage et l'archivage, les
 * paliers des rappels, la cadence des relances documentaires. Ces valeurs sont CELLES qu'utilisent la qualification
 * d'appel, les relances et le planificateur : aucune valeur n'est gardée en double dans le code.
 */
export function RulesPage() {
  const settings = useSettings();
  const [draft, setDraft] = useState<RulesSettings>(DEFAULT_RULES_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadedKey = `${settings.loading}:${JSON.stringify(settings.rules)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(settings.rules);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const set = <K extends keyof RulesSettings>(k: K, v: RulesSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
    setNotice(null);
  };
  const setNr = (i: number, minutes: number) => set('nrDelaysMinutes', draft.nrDelaysMinutes.map((m, j) => (j === i ? minutes : m)) as RulesSettings['nrDelaysMinutes']);
  const setDay = (i: number, v: number) => set('followUpDays', draft.followUpDays.map((d, j) => (j === i ? v : d)));

  const errors = validateRulesSettings(draft);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveRules(draft);
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Paramètres enregistrés. Ils s’appliquent aux prochaines qualifications d’appel ; les tentatives déjà programmées ne bougent pas.' });
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
        <span>Cycles NR, rappels et documents</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Cycles NR, rappels et documents</h1>
      <p className="mt-1 text-slate-500">Réglez le rythme des relances. Les horaires et jours fermés viennent de « SLA &amp; horaires » : une tentative n&apos;est jamais programmée hors horaires.</p>

      {!settings.saved.rules && !settings.loading && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Aucun réglage n&apos;a encore été enregistré : ce sont les valeurs du cahier des charges qui s&apos;appliquent. Enregistrez pour les rendre vôtres.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <SettingsCard title="Matrice NR (pas de réponse)" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th scope="col" className="py-2 font-medium">Tentative</th><th scope="col" className="py-2 font-medium">Délai avant la suivante</th><th scope="col" className="py-2 font-medium">Priorité</th><th scope="col" className="py-2 font-medium">Résultat</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td className="py-3 font-medium text-slate-900">NR{i + 1}</td>
                  <td className="py-3"><DelayField label={`Délai après NR${i + 1}`} minutes={draft.nrDelaysMinutes[i]} onChange={(m) => setNr(i, m)} /></td>
                  <td className="py-3 text-slate-600">P3</td>
                  <td className="py-3 text-slate-600">NR{i + 2} programmée dans les horaires ({Number.isFinite(draft.nrDelaysMinutes[i]) ? formatDelay(draft.nrDelaysMinutes[i]) : '—'} après)</td>
                </tr>
              ))}
              <tr>
                <td className="py-3 font-medium text-slate-900">NR5</td>
                <td className="py-3 text-slate-500">—</td>
                <td className="py-3 text-slate-600">—</td>
                <td className="py-3 text-slate-600">« Injoignable — fin du cycle », le lead sort de la file quotidienne et reste consultable</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">Le nouveau lead reste prioritaire sur un NR ordinaire. Un « mauvais moment » n&apos;est pas un NR : il programme un rappel court.</p>

        <dl className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 text-sm"><dt className="text-slate-700">Délai avant le recyclage (après NR5)</dt><dd><NumberField label="Délai de recyclage" value={draft.recycleAfterDays} onChange={(v) => set('recycleAfterDays', v)} min={1} max={365} suffix="jours" /></dd></div>
          <div className="flex items-center justify-between gap-3 text-sm"><dt className="text-slate-700">Cycles avant « Injoignable / archivé »</dt><dd><NumberField label="Nombre de cycles" value={draft.maxRecycleCycles} onChange={(v) => set('maxRecycleCycles', v)} min={1} max={10} suffix="cycles" /></dd></div>
        </dl>
      </SettingsCard>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <SettingsCard title="Rappels client">
          <ol className="space-y-2 text-sm">
            {FIXED_CALLBACK_STEPS.map(([when, what]) => (
              <li key={when} className="flex items-baseline gap-3"><span className="w-24 flex-shrink-0 font-medium text-slate-800">{when}</span><span className="text-slate-600">{what}</span></li>
            ))}
          </ol>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4 text-sm">
            <span className="text-slate-700">Alerte manager « rappel non effectué » après</span>
            <NumberField label="Alerte manager rappel non effectué" value={draft.callbackEscalationMin} onChange={(v) => set('callbackEscalationMin', v)} min={1} suffix="min" />
          </div>
          <p className="mt-2 text-xs text-slate-500">Un rappel client promis n&apos;est jamais réattribué automatiquement : le manager décide.</p>
        </SettingsCard>

        <SettingsCard title="Leads non attribués (file tampon)">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3"><span className="text-slate-700">Alerte manager après</span><NumberField label="Alerte lead non attribué" value={draft.bufferWarnMin} onChange={(v) => set('bufferWarnMin', v)} min={1} suffix="min" /></div>
            <div className="flex items-center justify-between gap-3"><span className="text-slate-700">Anomalie après</span><NumberField label="Anomalie lead non attribué" value={draft.bufferAnomalyHours} onChange={(v) => set('bufferAnomalyHours', v)} min={1} suffix="heures" /></div>
          </div>
          <p className="mt-3 text-xs text-slate-500">Un lead sans télépro disponible reste visible, chronométré et réévalué toutes les 5 minutes.</p>
        </SettingsCard>
      </div>

      <SettingsCard title="Relances documentaires" className="mt-5">
        <p className="text-sm text-slate-600">Jours, depuis la demande, de chaque relance. La dernière échéance est la décision obligatoire : poursuivre, recycler ou clôturer.</p>
        <ul className="mt-4 flex flex-wrap items-end gap-3">
          {draft.followUpDays.map((d, i) => {
            const last = i === draft.followUpDays.length - 1;
            return (
              <li key={i} className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">{last ? 'Décision' : `Relance ${i + 1}`}</span>
                <span className="inline-flex items-center gap-1">
                  <span className="text-sm text-slate-500">J+</span>
                  <input aria-label={last ? 'Jour de la décision' : `Jour de la relance ${i + 1}`} type="number" min={1} max={120} value={Number.isFinite(d) ? d : ''} onChange={(e) => setDay(i, e.target.value === '' ? Number.NaN : Number(e.target.value))} className={`${inputCls} w-20`} />
                  {draft.followUpDays.length > 2 && <button type="button" aria-label="Retirer cette échéance" onClick={() => set('followUpDays', draft.followUpDays.filter((_, j) => j !== i))} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X className="h-4 w-4" /></button>}
                </span>
              </li>
            );
          })}
          {draft.followUpDays.length < 8 && (
            <li><button type="button" onClick={() => set('followUpDays', [...draft.followUpDays.slice(0, -1), (draft.followUpDays[draft.followUpDays.length - 2] ?? 0) + 2, draft.followUpDays[draft.followUpDays.length - 1] + 2])} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-600 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"><Plus className="h-4 w-4" /> Ajouter une relance</button></li>
          )}
        </ul>
        <dl className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 text-sm"><dt className="text-slate-700">Nouvelle décision si le dossier est maintenu</dt><dd><NumberField label="Délai entre deux décisions" value={draft.decisionRepeatDays} onChange={(v) => set('decisionRepeatDays', v)} min={1} max={60} suffix="jours" /></dd></div>
          <div className="flex items-center justify-between gap-3 text-sm"><dt className="text-slate-700">Marge « documents promis non reçus »</dt><dd><NumberField label="Marge documents promis" value={draft.promisedMarginMinutes} onChange={(v) => set('promisedMarginMinutes', v)} min={0} max={1440} suffix="min" /></dd></div>
        </dl>
      </SettingsCard>

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar onCancel={() => { setDraft(settings.rules); setDirty(false); setNotice(null); }} onSave={save} busy={busy} blocked={errors.length > 0} dirty={dirty} />
    </div>
  );
}
