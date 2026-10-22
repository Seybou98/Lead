import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Info, Mail, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { EXPORT_FORMAT_LABELS, EXPORT_FORMATS, EXPORT_KIND_LABELS, EXPORT_KINDS } from '../../domain/reports/exports';
import {
  describeSchedule,
  FREQUENCY_LABELS,
  MAX_SCHEDULES,
  newScheduleId,
  nextOccurrence,
  RETENTION_DAYS,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_PERIOD_LABELS,
  SCHEDULE_PERIODS,
  SCHEDULE_TZ,
  validateSchedules,
  WEEKDAY_LABELS,
  type ScheduledExport,
} from '../../domain/reports/schedule';
import { DATE_MODE_LABELS } from '../../domain/reports/direction';
import { errorMessage, saveExports } from '../../lib/adminApi';
import { runScheduleNow } from '../../lib/exportsApi';
import { Feedback, inputCls, Switch } from '../settings/settingsUi';
import { useRecipients, useScheduledExports, type Recipient } from './useScheduledExports';
import type { ReportsData } from './useReportsData';

const blank = (id: string): ScheduledExport => ({
  id, name: '', kind: 'direction', format: 'csv', frequency: 'weekly', weekday: 1, dayOfMonth: 1, time: '08:00', period: 'previous_week', mode: 'event', sourceId: '', product: '', corrected: true, detail: false, recipients: [], active: true, endDate: '', createdAtMs: 0,
});

const when = (ms: number | null): string => (ms ? new Date(ms).toLocaleString('fr-FR', { timeZone: SCHEDULE_TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * Rapports programmés (§22.10, fig. 34). Un rapport récurrent garde les réglages de sa création ; à chaque échéance le serveur
 * génère le fichier (toujours anonymisé), le range dans Storage et envoie un LIEN par email : jamais le fichier. Réglage réservé
 * à l'administrateur ; un manager voit seulement ce qui lui est destiné, dans l'Historique.
 */
export function ScheduledView({ data, now }: { data: ReportsData; now: number }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { loading, error, schedules } = useScheduledExports();
  const { recipients } = useRecipients();
  const [draft, setDraft] = useState<ScheduledExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const products = useMemo(() => [...new Set(data.leads.map((l) => l.productCode).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, 'fr')), [data.leads]);
  const nameOf = useMemo(() => new Map(recipients.map((r) => [r.uid, r.name])), [recipients]);

  const persist = async (next: ScheduledExport[], okText: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await saveExports({ schedules: next });
      setNotice({ kind: 'ok', text: okText });
      return true;
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const errors = draft ? validateSchedules([...schedules.filter((s) => s.id !== draft.id), draft]) : [];
  const save = async () => {
    if (!draft || errors.length > 0) return;
    const next = schedules.some((s) => s.id === draft.id) ? schedules.map((s) => (s.id === draft.id ? draft : s)) : [...schedules, draft];
    if (await persist(next, 'Rapport programmé enregistré.')) setDraft(null);
  };
  const toggle = (s: ScheduledExport) => void persist(schedules.map((x) => (x.id === s.id ? { ...x, active: !x.active } : x)), s.active ? 'Rapport suspendu.' : 'Rapport réactivé : la prochaine échéance s’applique, aucune échéance passée n’est rattrapée.');
  const remove = (s: ScheduledExport) => {
    if (window.confirm(`Supprimer le rapport programmé « ${s.name} » ? Les fichiers déjà générés restent disponibles dans l’historique.`)) void persist(schedules.filter((x) => x.id !== s.id), 'Rapport supprimé.');
  };
  const runNow = async (s: ScheduledExport) => {
    if (!window.confirm(`Générer « ${s.name} » maintenant et envoyer le lien à ${s.recipients.length} destinataire${s.recipients.length > 1 ? 's' : ''} ?`)) return;
    setRunning(s.id);
    setNotice(null);
    const res = await runScheduleNow(s.id);
    setRunning(null);
    setNotice(res.ok ? { kind: 'ok', text: `Rapport généré (${res.run.files.length} fichier${res.run.files.length > 1 ? 's' : ''}). Suivez les envois dans l’Historique.` } : { kind: 'error', text: res.message });
  };

  const set = <K extends keyof ScheduledExport>(k: K, v: ScheduledExport[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const toggleRecipient = (uid: string, on: boolean) => setDraft((d) => (d ? { ...d, recipients: on ? [...d.recipients, uid] : d.recipients.filter((x) => x !== uid) } : d));

  if (loading) return <p className="mt-6 text-sm text-slate-500">Chargement des rapports programmés…</p>;

  return (
    <div className="mt-5 space-y-5">
      {error && <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> Lecture des rapports programmés refusée. Vérifiez vos droits.</p>}
      <Feedback errors={[]} notice={notice} />

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CalendarClock className="h-4 w-4 text-slate-500" /> Rapports programmés</h2>
            <p className="mt-0.5 text-xs text-slate-500">Un lien de téléchargement part par email à chaque échéance (heure de Paris). Fichiers conservés {RETENTION_DAYS} jours.</p>
          </div>
          {isAdmin && !draft && <button type="button" disabled={schedules.length >= MAX_SCHEDULES} onClick={() => { setNotice(null); setDraft(blank(newScheduleId(new Set(schedules.map((s) => s.id))))); }} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Plus className="h-4 w-4" /> Nouveau rapport programmé</button>}
        </div>

        {schedules.length === 0 ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">Aucun rapport programmé.{isAdmin ? ' Créez-en un pour recevoir un rapport à intervalle régulier.' : ''}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 font-medium">Rapport</th><th className="py-2 font-medium">Fréquence</th><th className="py-2 font-medium">Période</th><th className="py-2 font-medium">Destinataires</th><th className="py-2 font-medium">Prochaine</th><th className="py-2 font-medium">Actif</th>{isAdmin && <th className="py-2 text-right font-medium">Actions</th>}</tr></thead>
              <tbody>
                {schedules.map((s) => {
                  const next = nextOccurrence(s, now);
                  return (
                    <tr key={s.id} className={cn('border-b border-slate-100 align-top', !s.active && 'text-slate-400')}>
                      <td className="py-2.5"><span className="font-medium text-slate-900">{s.name}</span><span className="block text-xs text-slate-500">{EXPORT_KIND_LABELS[s.kind]} · {s.format.toUpperCase()}{s.detail || s.kind === 'leads' ? ' · détail anonymisé' : ''}</span></td>
                      <td className="py-2.5">{describeSchedule(s)}</td>
                      <td className="py-2.5 text-xs">{SCHEDULE_PERIOD_LABELS[s.period]}</td>
                      <td className="py-2.5 text-xs">{s.recipients.map((u) => nameOf.get(u) ?? u).join(', ')}</td>
                      <td className="py-2.5 text-xs">{s.active ? (next ? when(next.atMs) : 'Terminé') : 'Suspendu'}</td>
                      <td className="py-2.5"><Switch label={`${s.name} actif`} checked={s.active} onChange={() => toggle(s)} disabled={!isAdmin || busy} /></td>
                      {isAdmin && (
                        <td className="py-2.5 text-right">
                          <span className="inline-flex gap-1">
                            <button type="button" title="Exécuter maintenant" aria-label={`Exécuter ${s.name} maintenant`} disabled={running !== null} onClick={() => void runNow(s)} className="rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"><Play className="h-4 w-4" /></button>
                            <button type="button" title="Modifier" aria-label={`Modifier ${s.name}`} onClick={() => { setNotice(null); setDraft({ ...s }); }} className="rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50"><Pencil className="h-4 w-4" /></button>
                            <button type="button" title="Supprimer" aria-label={`Supprimer ${s.name}`} disabled={busy} onClick={() => remove(s)} className="rounded-md border border-slate-300 p-1.5 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                          </span>
                          {running === s.id && <span className="block text-[11px] text-slate-500">Génération…</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && isAdmin && (
        <section className="rounded-xl border border-blue-200 bg-white p-5" aria-label="Édition du rapport programmé">
          <h2 className="text-sm font-semibold text-slate-900">{schedules.some((s) => s.id === draft.id) ? 'Modifier le rapport programmé' : 'Nouveau rapport programmé'}</h2>
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <label className="block sm:col-span-2"><span className="font-medium text-slate-700">Nom</span><input aria-label="Nom" value={draft.name} maxLength={60} onChange={(e) => set('name', e.target.value)} className={cn(inputCls, 'mt-1 w-full')} placeholder="Direction du lundi" /></label>
            <label className="block"><span className="font-medium text-slate-700">Rapport</span>
              <select aria-label="Rapport" value={draft.kind} onChange={(e) => set('kind', e.target.value as ScheduledExport['kind'])} className={cn(inputCls, 'mt-1 w-full')}>{EXPORT_KINDS.map((k) => <option key={k} value={k}>{EXPORT_KIND_LABELS[k]}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Format</span>
              <select aria-label="Format" value={draft.format} onChange={(e) => set('format', e.target.value as ScheduledExport['format'])} className={cn(inputCls, 'mt-1 w-full')}>{EXPORT_FORMATS.map((f) => <option key={f} value={f}>{EXPORT_FORMAT_LABELS[f]}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Fréquence</span>
              <select aria-label="Fréquence" value={draft.frequency} onChange={(e) => set('frequency', e.target.value as ScheduledExport['frequency'])} className={cn(inputCls, 'mt-1 w-full')}>{SCHEDULE_FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}</select>
            </label>
            <div className="flex gap-3">
              {draft.frequency === 'weekly' && (
                <label className="block flex-1"><span className="font-medium text-slate-700">Jour</span>
                  <select aria-label="Jour de la semaine" value={draft.weekday} onChange={(e) => set('weekday', Number(e.target.value))} className={cn(inputCls, 'mt-1 w-full')}>{WEEKDAY_LABELS.slice(1).map((l, i) => <option key={l} value={i + 1}>{l}</option>)}</select>
                </label>
              )}
              {draft.frequency === 'monthly' && (
                <label className="block flex-1"><span className="font-medium text-slate-700">Jour du mois</span>
                  <select aria-label="Jour du mois" value={draft.dayOfMonth} onChange={(e) => set('dayOfMonth', Number(e.target.value))} className={cn(inputCls, 'mt-1 w-full')}>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 1 ? '1er' : d}</option>)}</select>
                </label>
              )}
              <label className="block flex-1"><span className="font-medium text-slate-700">Heure ({SCHEDULE_TZ})</span><input aria-label="Heure" type="time" value={draft.time} onChange={(e) => set('time', e.target.value)} className={cn(inputCls, 'mt-1 w-full')} /></label>
            </div>
            <label className="block"><span className="font-medium text-slate-700">Période couverte</span>
              <select aria-label="Période couverte" value={draft.period} onChange={(e) => set('period', e.target.value as ScheduledExport['period'])} className={cn(inputCls, 'mt-1 w-full')}>{SCHEDULE_PERIODS.map((p) => <option key={p} value={p}>{SCHEDULE_PERIOD_LABELS[p]}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Mode de date</span>
              <select aria-label="Mode de date" value={draft.mode} onChange={(e) => set('mode', e.target.value as ScheduledExport['mode'])} className={cn(inputCls, 'mt-1 w-full')}>{(Object.keys(DATE_MODE_LABELS) as (keyof typeof DATE_MODE_LABELS)[]).map((m) => <option key={m} value={m}>{DATE_MODE_LABELS[m]}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Source</span>
              <select aria-label="Source" value={draft.sourceId} onChange={(e) => set('sourceId', e.target.value)} className={cn(inputCls, 'mt-1 w-full')}><option value="">Toutes les sources</option>{data.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Produit</span>
              <select aria-label="Produit" value={draft.product} onChange={(e) => set('product', e.target.value)} className={cn(inputCls, 'mt-1 w-full')}><option value="">Tous les produits</option>{products.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Dernier jour d’envoi (facultatif)</span><input aria-label="Dernier jour d’envoi" type="date" value={draft.endDate} onChange={(e) => set('endDate', e.target.value)} className={cn(inputCls, 'mt-1 w-full')} /></label>
            <div className="space-y-2.5 sm:col-span-2">
              <div className="flex items-start justify-between gap-3"><span><span className="block font-medium text-slate-700">Données corrigées</span><span className="block text-xs text-slate-500">Hors doublons, faux leads et leads exclus. Désactivé : données brutes.</span></span><Switch label="Données corrigées" checked={draft.corrected} onChange={(v) => set('corrected', v)} /></div>
              <div className="flex items-start justify-between gap-3"><span><span className="block font-medium text-slate-700">Inclure le détail des leads</span><span className="block text-xs text-slate-500">Une ligne par lead, avec un pseudonyme : jamais de nom, téléphone, email ni adresse.</span></span><Switch label="Inclure le détail des leads" checked={draft.detail || draft.kind === 'leads'} onChange={(v) => set('detail', v)} disabled={draft.kind === 'leads'} /></div>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="font-medium text-slate-700">Destinataires</legend>
              {recipients.length === 0 ? <p className="mt-1 text-xs text-slate-500">Aucun administrateur ou manager actif trouvé.</p> : (
                <ul className="mt-1 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {recipients.map((r: Recipient) => (
                    <li key={r.uid}>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={draft.recipients.includes(r.uid)} disabled={!r.email} onChange={(e) => toggleRecipient(r.uid, e.target.checked)} />
                        <span className={cn(!r.email && 'text-slate-400')}>{r.name}</span>
                        <span className="text-xs text-slate-500">{r.role === 'admin' ? 'administrateur · fichier complet' : 'manager · son équipe seulement'}{!r.email && ' · sans email'}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          </div>

          <div className="mt-4 flex gap-2 rounded-lg bg-blue-50 px-3 py-2.5 text-xs text-blue-900">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <p>Le fichier est toujours anonymisé. L’administrateur reçoit le fichier complet ; chaque manager, un fichier limité à son équipe et sans dépenses. L’email ne contient qu’un lien : il faut être connecté au CRM, et destinataire du fichier, pour le télécharger.</p>
          </div>
          {errors.length > 0 && <ul role="alert" className="mt-3 list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-7 pr-3 text-sm text-red-700">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="mt-4 flex gap-3">
            <button type="button" onClick={() => void save()} disabled={busy || errors.length > 0} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" /> {busy ? 'Enregistrement…' : 'Enregistrer'}</button>
            <button type="button" onClick={() => setDraft(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
          </div>
        </section>
      )}

      <p className="flex items-start gap-2 text-xs text-slate-500"><Mail className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> Les filtres de la barre ci-dessus ne s’appliquent pas : un rapport programmé a ses propres réglages. Modifier, suspendre ou réactiver un rapport repart de maintenant : aucune échéance passée n’est rattrapée. Une échéance manquée (service arrêté) n’est rattrapée que dans les 24 heures.</p>
    </div>
  );
}
