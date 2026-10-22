import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { errorMessage, saveReportsConfig } from '../../lib/adminApi';
import {
  ALERT_METRICS,
  ALERT_METRIC_DEFS,
  ALERT_OPS,
  ALERT_OP_LABELS,
  MAX_ALERTS,
  MAX_OBJECTIVES,
  monthKey,
  newTargetId,
  OBJECTIVE_DIRECTION,
  OBJECTIVE_METRICS,
  OBJECTIVE_METRIC_LABELS,
  OBJECTIVE_SCOPES,
  OBJECTIVE_SCOPE_LABELS,
  OBJECTIVE_UNITS,
  ruleText,
  validateReportSettings,
  type AlertRule,
  type Objective,
  type ObjectiveScope,
  type ReportSettings,
} from '../../domain/reports/targets';
import { useConfigData } from './useConfigData';
import { Feedback, inputCls, SaveBar, SettingsCard, Switch } from './settingsUi';

const clone = (s: ReportSettings): ReportSettings => JSON.parse(JSON.stringify(s));
const numberOrNaN = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));

/**
 * Objectifs et alertes KPI (§22.8, fig. 34). Les objectifs se fixent par mois et par périmètre ; les alertes ont un seuil
 * ET un volume minimum, pour ne pas déclencher sur trois leads. Ces valeurs sont celles qu'évaluent les rapports.
 */
export function ObjectivesPage() {
  const data = useConfigData();
  const settings = data.settings;
  const [draft, setDraft] = useState<ReportSettings>(settings.reports);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadedKey = `${settings.loading}:${JSON.stringify(settings.reports)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(clone(settings.reports));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const change = (fn: (d: ReportSettings) => void) => {
    setDraft((cur) => {
      const next = clone(cur);
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };
  const errors = validateReportSettings(draft);

  const options = useMemo(
    () => ({
      campaign: data.campaigns.map((c) => ({ id: c.id, label: c.name })).sort((a, b) => a.label.localeCompare(b.label, 'fr')),
      owner: [...data.userNames.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label, 'fr')),
      product: data.catalog.categories.map((c) => ({ id: c.code, label: c.code })),
    }),
    [data.campaigns, data.userNames, data.catalog.categories]
  );

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveReportsConfig(draft);
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Objectifs et alertes enregistrés. Ils s’appliquent immédiatement aux rapports ; les chiffres passés ne sont pas modifiés.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const addAlert = () => change((d) => {
    d.alerts.push({ id: newTargetId('a', new Set(d.alerts.map((a) => a.id))), metric: 'costPerSale', mode: 'value', op: 'gt', threshold: 500, minVolume: 10, days: 7, level: 'warning', active: true });
  });
  const addObjective = () => change((d) => {
    d.objectives.push({ id: newTargetId('o', new Set(d.objectives.map((o) => o.id))), month: monthKey(Date.now()), scope: 'global', scopeId: '', metric: 'sales', target: 10, active: true });
  });
  const patchAlert = (i: number, p: Partial<AlertRule>) => change((d) => { Object.assign(d.alerts[i], p); });
  const patchObjective = (i: number, p: Partial<Objective>) => change((d) => { Object.assign(d.objectives[i], p); });

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Objectifs et alertes KPI</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Objectifs et alertes KPI</h1>
      <p className="mt-1 text-slate-500">Fixez les cibles du mois et les seuils qui déclenchent une alerte dans les rapports. Une alerte ne se déclenche qu’au-delà de son volume minimum.</p>

      {!settings.saved.reports && !settings.loading && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Rien n’a encore été enregistré : ce sont les alertes d’origine du rapport Direction qui s’appliquent, sans objectif.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <div className="mt-5 space-y-5">
        <SettingsCard title="Alertes KPI">
          {draft.alerts.length === 0 ? <p className="text-sm text-slate-500">Aucune alerte : les rapports n’afficheront aucun point d’attention automatique.</p> : (
            <ul className="space-y-3">
              {draft.alerts.map((a, i) => {
                const def = ALERT_METRIC_DEFS[a.metric];
                const unit = a.mode === 'change' ? (def.unit === '€' ? '%' : def.unit === '%' ? 'pts' : '') : def.unit;
                return (
                  <li key={a.id} className={`rounded-lg border p-3 ${a.active ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50'}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Switch label={`Alerte ${def.label} active`} checked={a.active} onChange={(v) => patchAlert(i, { active: v })} />
                      <select aria-label="Indicateur" value={a.metric} onChange={(e) => { const metric = e.target.value as AlertRule['metric']; patchAlert(i, { metric, mode: ALERT_METRIC_DEFS[metric].changeable ? a.mode : 'value' }); }} className={inputCls}>
                        {ALERT_METRICS.map((m) => <option key={m} value={m}>{ALERT_METRIC_DEFS[m].label}</option>)}
                      </select>
                      {def.changeable && (
                        <select aria-label="Mode" value={a.mode} onChange={(e) => patchAlert(i, { mode: e.target.value as AlertRule['mode'] })} className={inputCls}>
                          <option value="value">Valeur</option>
                          <option value="change">Variation vs période précédente</option>
                        </select>
                      )}
                      {a.metric === 'blockedDossiers' && (
                        <label className="flex items-center gap-1 text-slate-600">attente &gt;
                          <input aria-label="Jours d’attente" type="number" min={1} max={60} value={Number.isFinite(a.days) ? a.days : ''} onChange={(e) => patchAlert(i, { days: numberOrNaN(e.target.value) })} className={`${inputCls} w-16`} /> jours
                        </label>
                      )}
                      <select aria-label="Comparaison" value={a.op} onChange={(e) => patchAlert(i, { op: e.target.value as AlertRule['op'] })} className={inputCls}>
                        {ALERT_OPS.map((o) => <option key={o} value={o}>{ALERT_OP_LABELS[o]}</option>)}
                      </select>
                      <span className="inline-flex items-center gap-1">
                        <input aria-label="Seuil" type="number" value={Number.isFinite(a.threshold) ? a.threshold : ''} onChange={(e) => patchAlert(i, { threshold: numberOrNaN(e.target.value) })} className={`${inputCls} w-24`} />
                        <span className="text-slate-500">{a.metric === 'blockedDossiers' ? 'dossier(s)' : unit}</span>
                      </span>
                      {a.metric !== 'blockedDossiers' && (
                        <label className="flex items-center gap-1 text-slate-600">ET au moins
                          <input aria-label="Volume minimum" type="number" min={0} value={Number.isFinite(a.minVolume) ? a.minVolume : ''} onChange={(e) => patchAlert(i, { minVolume: numberOrNaN(e.target.value) })} className={`${inputCls} w-20`} /> {def.volumeLabel}
                        </label>
                      )}
                      <select aria-label="Gravité" value={a.level} onChange={(e) => patchAlert(i, { level: e.target.value as AlertRule['level'] })} className={inputCls}>
                        <option value="warning">Avertissement</option>
                        <option value="critical">Critique</option>
                      </select>
                      <button type="button" aria-label="Supprimer l’alerte" onClick={() => change((d) => { d.alerts.splice(i, 1); })} className="ml-auto rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500">{ruleText(a)} — {def.definition}</p>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" disabled={draft.alerts.length >= MAX_ALERTS} onClick={addAlert} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter une alerte</button>
        </SettingsCard>

        <SettingsCard title="Objectifs mensuels">
          {draft.objectives.length === 0 ? <p className="text-sm text-slate-500">Aucun objectif. Les rapports n’affichent ni jauge ni écart à l’objectif.</p> : (
            <ul className="space-y-2">
              {draft.objectives.map((o, i) => (
                <li key={o.id} className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${o.active ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50'}`}>
                  <Switch label={`Objectif ${OBJECTIVE_METRIC_LABELS[o.metric]} actif`} checked={o.active} onChange={(v) => patchObjective(i, { active: v })} />
                  <input aria-label="Mois" type="month" value={o.month} onChange={(e) => patchObjective(i, { month: e.target.value })} className={inputCls} />
                  <select aria-label="Périmètre" value={o.scope} onChange={(e) => patchObjective(i, { scope: e.target.value as ObjectiveScope, scopeId: '' })} className={inputCls}>
                    {OBJECTIVE_SCOPES.map((s) => <option key={s} value={s}>{OBJECTIVE_SCOPE_LABELS[s]}</option>)}
                  </select>
                  {o.scope !== 'global' && (
                    <select aria-label="Choix du périmètre" value={o.scopeId} onChange={(e) => patchObjective(i, { scopeId: e.target.value })} className={inputCls}>
                      <option value="">Choisir…</option>
                      {options[o.scope].map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      {o.scopeId && !options[o.scope].some((x) => x.id === o.scopeId) && <option value={o.scopeId}>{o.scopeId} (introuvable)</option>}
                    </select>
                  )}
                  <select aria-label="Indicateur" value={o.metric} onChange={(e) => patchObjective(i, { metric: e.target.value as Objective['metric'] })} className={inputCls}>
                    {OBJECTIVE_METRICS.map((m) => <option key={m} value={m}>{OBJECTIVE_METRIC_LABELS[m]}</option>)}
                  </select>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-slate-500">{OBJECTIVE_DIRECTION[o.metric] === 'max' ? 'au plus' : 'au moins'}</span>
                    <input aria-label="Cible" type="number" min={0} value={Number.isFinite(o.target) ? o.target : ''} onChange={(e) => patchObjective(i, { target: numberOrNaN(e.target.value) })} className={`${inputCls} w-24`} />
                    <span className="text-slate-500">{OBJECTIVE_UNITS[o.metric]}</span>
                  </span>
                  <button type="button" aria-label="Supprimer l’objectif" onClick={() => change((d) => { d.objectives.splice(i, 1); })} className="ml-auto rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={draft.objectives.length >= MAX_OBJECTIVES} onClick={addObjective} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter un objectif</button>
          <p className="mt-3 text-xs text-slate-500">Le réalisé suit les mêmes règles de comptage que les rapports (ventes nettes, dossiers complets…). La projection de fin de mois est une estimation au rythme observé. Pas d’objectif de valeur ni de marge : ces données n’existent pas en base.</p>
        </SettingsCard>
      </div>

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar onCancel={() => { setDraft(clone(settings.reports)); setDirty(false); setNotice(null); }} onSave={save} busy={busy} blocked={errors.length > 0} dirty={dirty} />
    </div>
  );
}
