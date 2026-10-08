import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Info, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DEFAULT_SLA_SETTINGS, effectiveSla, OUTSIDE_HOURS, OUTSIDE_HOURS_LABELS, validateSlaSettings, type OutsideHours, type SlaSettings } from '../../domain/settings/settings';
import type { WorkSlotLike } from '../../domain/engine/schedule';
import { deleteSlaOverride, errorMessage, saveSla, saveSlaOverride } from '../../lib/adminApi';
import { useCampaignFormData } from '../campaigns/useCampaignFormData';
import { useSettings } from './useSettings';
import { Feedback, inputCls, NumberField, SaveBar, SettingsCard, Switch } from './settingsUi';

const DAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Lundi' }, { day: 2, label: 'Mardi' }, { day: 3, label: 'Mercredi' }, { day: 4, label: 'Jeudi' }, { day: 5, label: 'Vendredi' }, { day: 6, label: 'Samedi' }, { day: 0, label: 'Dimanche' },
];
const TIMEZONES = ['Europe/Paris', 'Indian/Reunion', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'Indian/Mayotte', 'Pacific/Noumea', 'Pacific/Tahiti', 'Europe/Brussels', 'Europe/Zurich'];

type Scope = 'general' | string;

/**
 * SLA et horaires (§19.4, §14, fig. 18). Réglages généraux : paliers du SLA, horaires commerciaux, jours fermés,
 * comportement hors horaires. Pour une campagne, seule la règle de réattribution se surcharge (délai, nombre maximal,
 * équipe de secours) : les alertes, les horaires et le comportement hors horaires restent ceux de l'entreprise.
 */
export function SlaHoursPage() {
  const settings = useSettings();
  const form = useCampaignFormData();
  const [scope, setScope] = useState<Scope>('general');
  const [draft, setDraft] = useState<SlaSettings>(DEFAULT_SLA_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newClosed, setNewClosed] = useState('');

  const campaign = scope === 'general' ? null : (form.campaigns.find((c) => c.id === scope) ?? null);
  const override = scope === 'general' ? undefined : settings.overrides[scope];
  // Ce que la page édite : les réglages généraux, ou ceux de la campagne (généraux + sa surcharge).
  const saved = useMemo(() => (scope === 'general' ? settings.sla : effectiveSla(settings.sla, override)), [scope, settings.sla, override]);
  const loadedKey = `${scope}:${settings.loading}:${JSON.stringify(saved)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const set = <K extends keyof SlaSettings>(k: K, v: SlaSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
    setNotice(null);
  };
  const setWeekly = (weekly: WorkSlotLike[]) => set('schedule', { ...draft.schedule, weekly });
  const choose = (next: Scope) => {
    if (dirty && !window.confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return;
    setDirty(false);
    setNotice(null);
    setScope(next);
  };

  const isCampaign = scope !== 'general';
  const errors = validateSlaSettings(draft);
  const teams = form.teams.filter((t) => t.active);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (isCampaign) await saveSlaOverride({ campaignId: scope, autoReassign: draft.autoReassign, reassignMin: draft.reassignMin, maxReassignments: draft.maxReassignments, fallbackTeamId: draft.fallbackTeamId });
      else await saveSla(draft);
      setDirty(false);
      setNotice({ kind: 'ok', text: isCampaign ? `Règle de réattribution enregistrée pour « ${campaign?.name ?? 'la campagne'} ».` : 'Paramètres enregistrés. Ils s’appliquent immédiatement aux nouveaux leads et aux compteurs.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const resetCampaign = async () => {
    if (!window.confirm('Retirer la règle propre à cette campagne ? Elle reprendra les réglages généraux.')) return;
    setBusy(true);
    try {
      await deleteSlaOverride(scope);
      setDirty(false);
      setNotice({ kind: 'ok', text: 'La campagne reprend les réglages généraux.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    { key: 'recv', title: 'Lead reçu', sub: '0 min', tone: 'bg-emerald-600', icon: <Check className="h-4 w-4" /> },
    { key: 'first', title: '1re alerte', sub: `+${draft.firstAlertMin} min`, tone: 'bg-blue-600', icon: '1' },
    { key: 'crit', title: 'Retard critique', sub: `+${draft.criticalMin} min`, tone: 'bg-amber-500', icon: '2' },
    { key: 'reas', title: 'Réattribution', sub: `+${draft.reassignMin} min`, tone: draft.autoReassign ? 'bg-red-600' : 'bg-slate-400', icon: '3' },
  ];

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>SLA & horaires</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">SLA &amp; horaires</h1>
      <p className="mt-1 text-slate-500">Configurez les délais de prise en charge et les règles hors horaires.</p>

      <div className="mt-4">
        <select aria-label="Portée des réglages" value={scope} onChange={(e) => choose(e.target.value)} className={cn(inputCls, 'min-w-[260px]')}>
          <option value="general">Toutes les campagnes (réglages généraux)</option>
          {form.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{settings.overrides[c.id] ? ' — règle propre' : ''}</option>)}
        </select>
        {isCampaign && <p className="mt-2 text-sm text-slate-500">Pour une campagne, seule la règle de réattribution est propre. Le reste vient des réglages généraux (grisé).</p>}
      </div>

      {!settings.saved.sla && !settings.loading && !isCampaign && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Aucun réglage n&apos;a encore été enregistré : ce sont les valeurs du cahier des charges qui s&apos;appliquent. Enregistrez pour les rendre vôtres.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SettingsCard title="Délais de prise en charge">
          <ol className="flex items-start justify-between" aria-label="Paliers du SLA">
            {steps.map((s, i) => (
              <li key={s.key} className="relative flex flex-1 flex-col items-center text-center">
                {i > 0 && <span className="absolute left-[-50%] top-4 h-0.5 w-full bg-blue-200" aria-hidden="true" />}
                <span className={cn('relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-white', s.tone)}>{s.icon}</span>
                <span className="mt-2 text-xs font-medium text-slate-700">{s.title}</span>
                <span className="text-xs text-slate-500">{s.sub}</span>
              </li>
            ))}
          </ol>
          <div className="mt-5 grid grid-cols-4 items-end gap-3 text-xs text-slate-500">
            <span>Délai (minutes)</span>
            <NumberField label="Première alerte (minutes)" value={draft.firstAlertMin} onChange={(v) => set('firstAlertMin', v)} min={1} disabled={isCampaign} width="w-16" />
            <NumberField label="Retard critique (minutes)" value={draft.criticalMin} onChange={(v) => set('criticalMin', v)} min={1} disabled={isCampaign} width="w-16" />
            <NumberField label="Réattribution (minutes)" value={draft.reassignMin} onChange={(v) => set('reassignMin', v)} min={1} width="w-16" />
          </div>

          <dl className="mt-5 space-y-3 border-t border-slate-100 pt-4 text-sm">
            <div className="flex items-center justify-between gap-3"><dt className="text-slate-700">Réattribuer automatiquement</dt><dd><Switch checked={draft.autoReassign} onChange={(v) => set('autoReassign', v)} label="Réattribuer automatiquement" /></dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-slate-700">Nombre maximal de réattributions</dt><dd><NumberField label="Nombre maximal de réattributions" value={draft.maxReassignments} onChange={(v) => set('maxReassignments', v)} min={0} max={10} width="w-16" /></dd></div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-700">Équipe de secours</dt>
              <dd>
                <select aria-label="Équipe de secours" value={draft.fallbackTeamId ?? ''} onChange={(e) => set('fallbackTeamId', e.target.value || null)} className={cn(inputCls, 'min-w-[200px]')}>
                  <option value="">Aucune</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3"><dt className="text-slate-700">Suspendre le SLA hors horaires</dt><dd><Switch checked={draft.suspendOutsideHours} onChange={(v) => set('suspendOutsideHours', v)} label="Suspendre le SLA hors horaires" disabled={isCampaign} /></dd></div>
          </dl>
          {draft.autoReassign && <p className="mt-3 text-xs text-slate-500">Un rappel client promis n&apos;est jamais réattribué automatiquement : le manager décide. Un lead déjà pris en charge n&apos;est pas concerné.</p>}
        </SettingsCard>

        <SettingsCard title="Horaires commerciaux">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="tz" className="text-slate-600">Fuseau horaire</label>
            <select id="tz" disabled={isCampaign} value={draft.schedule.timezone} onChange={(e) => set('schedule', { ...draft.schedule, timezone: e.target.value })} className={inputCls}>
              {[...new Set([draft.schedule.timezone, ...TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Horaires par jour">
            {DAYS.map(({ day, label }) => {
              const slots = draft.schedule.weekly.map((s, index) => ({ s, index })).filter((x) => x.s.day === day);
              return (
                <li key={day} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="w-24 text-sm text-slate-800">{label}</span>
                  <div className="flex flex-1 flex-col gap-1.5">
                    {slots.length === 0 && <span className="text-sm italic text-slate-400">Fermé</span>}
                    {slots.map(({ s, index }) => (
                      <span key={index} className="inline-flex items-center gap-2">
                        <input aria-label={`${label} : début`} type="time" disabled={isCampaign} value={s.start} onChange={(e) => setWeekly(draft.schedule.weekly.map((x, i) => (i === index ? { ...x, start: e.target.value } : x)))} className={cn(inputCls, 'w-28')} />
                        <span className="text-slate-400">–</span>
                        <input aria-label={`${label} : fin`} type="time" disabled={isCampaign} value={s.end} onChange={(e) => setWeekly(draft.schedule.weekly.map((x, i) => (i === index ? { ...x, end: e.target.value } : x)))} className={cn(inputCls, 'w-28')} />
                        <button type="button" disabled={isCampaign} aria-label={`Retirer cette plage du ${label}`} onClick={() => setWeekly(draft.schedule.weekly.filter((_, i) => i !== index))} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
                      </span>
                    ))}
                  </div>
                  <button type="button" disabled={isCampaign} aria-label={`Ajouter une plage le ${label}`} onClick={() => setWeekly([...draft.schedule.weekly, { day, start: slots.length ? slots[slots.length - 1].s.end : '09:00', end: slots.length ? '19:00' : '18:00' }])} className="rounded p-1 text-blue-600 hover:bg-blue-50 disabled:opacity-40"><Plus className="h-4 w-4" /></button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4">
            <p className="text-sm font-medium text-slate-700">Jours fermés</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {draft.schedule.closedDates.length === 0 && <li className="text-sm text-slate-400">Aucun jour fermé.</li>}
              {draft.schedule.closedDates.map((d) => (
                <li key={d} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-sm text-slate-700">{d.split('-').reverse().join('/')}
                  <button type="button" disabled={isCampaign} aria-label={`Rouvrir le ${d}`} onClick={() => set('schedule', { ...draft.schedule, closedDates: draft.schedule.closedDates.filter((x) => x !== d) })} className="text-slate-400 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <input aria-label="Date à fermer" type="date" disabled={isCampaign} value={newClosed} onChange={(e) => setNewClosed(e.target.value)} className={cn(inputCls, 'w-44')} />
              <button type="button" disabled={isCampaign || !newClosed || draft.schedule.closedDates.includes(newClosed)} onClick={() => { set('schedule', { ...draft.schedule, closedDates: [...draft.schedule.closedDates, newClosed].sort() }); setNewClosed(''); }} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-600 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40"><Plus className="h-4 w-4" /> Fermer ce jour</button>
            </div>
          </div>
        </SettingsCard>
      </div>

      <SettingsCard title="Comportement hors horaires" className="mt-5">
        <div className="flex flex-wrap gap-x-8 gap-y-3" role="radiogroup" aria-label="Comportement hors horaires">
          {OUTSIDE_HOURS.map((o: OutsideHours) => (
            <label key={o} className={cn('inline-flex items-center gap-2 text-sm', isCampaign ? 'opacity-60' : 'cursor-pointer')}>
              <input type="radio" name="outside" disabled={isCampaign} checked={draft.outsideHours === o} onChange={() => set('outsideHours', o)} />
              {OUTSIDE_HOURS_LABELS[o]}
            </label>
          ))}
        </div>
        {draft.outsideHours === 'duty_team' && !draft.fallbackTeamId && <p className="mt-2 text-sm text-amber-800">Choisissez l&apos;équipe de secours ci-dessus : c&apos;est elle qui reçoit les leads hors horaires.</p>}
        {draft.outsideHours === 'immediate' && <p className="mt-2 text-xs text-slate-500">Les horaires propres à chaque télépro ne bloquent plus l&apos;attribution quand l&apos;entreprise est fermée.</p>}
        {draft.suspendOutsideHours && (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900"><Info className="h-4 w-4 flex-shrink-0" /> Le temps hors horaires ne compte pas comme retard télépro.</p>
        )}
      </SettingsCard>

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar
        onCancel={() => { setDraft(saved); setDirty(false); setNotice(null); }}
        onSave={save}
        busy={busy}
        blocked={errors.length > 0}
        dirty={dirty}
        saveLabel={isCampaign ? 'Enregistrer pour cette campagne' : 'Enregistrer les paramètres'}
        extra={isCampaign && override ? <button type="button" onClick={resetCampaign} disabled={busy} className="mr-auto text-sm text-slate-500 underline hover:text-slate-800">Revenir aux réglages généraux</button> : null}
      />
    </div>
  );
}
