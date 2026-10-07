import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Gauge, MapPin, Package, Play, Trophy, UserCheck, Users, Clock, CalendarX } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ELIGIBILITY_CRITERIA, type AssignmentConfig, type EligibilityCriterion, type RankingCriterion } from '../../domain/engine/assignment';
import { parseAssignmentConfig } from '../../domain/ingest/configParse';
import { simulateAssignment } from '../../domain/admin/simulate';
import { ELIGIBILITY_CRITERION_LABELS, EXCLUSION_LABELS, RANKING_CRITERION_LABELS } from '../../domain/labels';
import { errorMessage, saveAssignmentConfig } from '../../lib/adminApi';
import { useAssignmentData, type AssignmentData } from './useAssignmentData';

const CRITERION_ICON: Record<EligibilityCriterion, React.ComponentType<{ className?: string }>> = {
  active_connected: UserCheck,
  product: Package,
  zone: MapPin,
  team: Users,
  working_hours: Clock,
  capacity: Gauge,
  exclude_in_meeting: CalendarX,
};

const selectClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';
const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

/** Configuration effectivement lue par le moteur : défauts, puis configuration globale publiée, puis règles de la campagne. */
const configFor = (globalConfig: unknown, raw: Record<string, unknown> | null): AssignmentConfig => parseAssignmentConfig(globalConfig, raw);

/** Formulaire → entrée de la fonction d'enregistrement. Tous les critères sont envoyés explicitement. */
function toSaveInput(c: AssignmentConfig) {
  return {
    autoDistribution: c.autoDistribution,
    defaultNewLeadsCap: c.defaultNewLeadsCap,
    criteria: Object.fromEntries(ELIGIBILITY_CRITERIA.map((k) => [k, c.criteria[k] !== false])) as Record<string, boolean>,
    rankingOrder: [...c.rankingOrder],
  };
}

export function AssignmentRulesPage() {
  return <AssignmentRulesView data={useAssignmentData()} />;
}

export function AssignmentRulesView({ data }: { data: AssignmentData }) {
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campagne') ?? data.campaigns[0]?.id ?? '';
  const campaign = data.campaigns.find((c) => c.id === campaignId) ?? null;

  // Formulaire local ; réinitialisé quand on change de campagne ou quand la campagne est modifiée ailleurs.
  // Clé de contenu (et non la référence de l'objet) : Firestore renvoie de nouveaux objets à chaque
  // changement de n'importe quelle campagne, ce qui effacerait sinon les modifications en cours.
  const savedKey = JSON.stringify([data.globalConfig ?? null, campaign?.assignmentConfig ?? null]);
  const saved = useMemo(() => configFor(data.globalConfig, campaign?.assignmentConfig ?? null), [savedKey]);
  const [form, setForm] = useState<AssignmentConfig>(saved);
  useEffect(() => setForm(saved), [saved]);
  const dirty = JSON.stringify(toSaveInput(form)) !== JSON.stringify(toSaveInput(saved));

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Lead fictif de la simulation, prérempli depuis la campagne.
  const [simProduct, setSimProduct] = useState('');
  const [simZone, setSimZone] = useState('');
  useEffect(() => {
    setSimProduct(campaign?.productCode ?? '');
    setSimZone(campaign?.zones[0] ?? '');
  }, [campaign?.id, campaign?.productCode, campaign?.zones[0]]);
  const [simNow, setSimNow] = useState(() => Date.now());
  // Heure du dernier clic sur « Tester » : sert à confirmer visiblement que le test a bien été relancé.
  const [testedAt, setTestedAt] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const runTest = () => {
    const now = Date.now();
    setSimNow(now);
    setTestedAt(now);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 900);
  };

  const result = useMemo(
    () =>
      campaign
        ? simulateAssignment({
            lead: { productCode: simProduct.trim() || null, zone: simZone.trim() || null },
            campaign: { id: campaign.id, name: campaign.name, status: campaign.status, productCode: campaign.productCode, eligibleUserIds: campaign.eligibleUserIds, eligibleTeamIds: campaign.eligibleTeamIds, fallbackTeamId: campaign.fallbackTeamId, autoEligible: campaign.autoEligible },
            profiles: data.profiles,
            users: data.users,
            presence: data.presence,
            absences: data.absences,
            nowMs: simNow,
            config: form,
          })
        : null,
    [campaign, data.profiles, data.users, data.presence, data.absences, simProduct, simZone, simNow, form]
  );

  const setCriterion = (k: EligibilityCriterion, on: boolean) => setForm((f) => ({ ...f, criteria: { ...f.criteria, [k]: on } }));
  const move = (i: number, dir: -1 | 1) =>
    setForm((f) => {
      const next = [...f.rankingOrder];
      const j = i + dir;
      if (j < 0 || j >= next.length) return f;
      [next[i], next[j]] = [next[j], next[i]];
      return { ...f, rankingOrder: next as RankingCriterion[] };
    });

  const save = async () => {
    if (!campaign) return;
    setSaving(true);
    setNotice(null);
    try {
      await saveAssignmentConfig({ campaignId: campaign.id, config: toSaveInput(form), reason: 'Modification des règles d\'attribution' });
      setNotice({ kind: 'ok', text: 'Règles enregistrées. Elles s\'appliquent aux prochains leads.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold text-slate-900">Règles d'attribution</h1>
      <p className="mt-1 text-slate-500">Définissez comment les nouveaux leads sont distribués aux télépros.</p>

      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {notice.text}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex items-center gap-3 text-sm text-slate-700">
          Campagne
          <select className={selectClass} value={campaign?.id ?? ''} onChange={(e) => { setParams({ campagne: e.target.value }); setNotice(null); }} disabled={data.campaigns.length === 0}>
            {data.campaigns.length === 0 && <option value="">Aucune campagne</option>}
            {data.campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-3 text-sm font-medium text-slate-800">
          Distribution automatique {form.autoDistribution ? 'activée' : 'désactivée'}
          <button
            type="button"
            role="switch"
            aria-checked={form.autoDistribution}
            onClick={() => setForm((f) => ({ ...f, autoDistribution: !f.autoDistribution }))}
            className={cn('relative h-6 w-11 rounded-full transition-colors', form.autoDistribution ? 'bg-emerald-500' : 'bg-slate-300')}
          >
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', form.autoDistribution ? 'left-[22px]' : 'left-0.5')} />
          </button>
        </label>
      </div>

      {!form.autoDistribution && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Distribution automatique désactivée : les nouveaux leads de cette campagne iront en file tampon, visibles des managers, jusqu'à une attribution manuelle.
        </p>
      )}

      {!campaign && !data.loading && (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">Créez d'abord une campagne dans « Campagnes » pour définir ses règles d'attribution.</p>
      )}

      {campaign && (
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <div className="grid gap-6 md:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-base font-semibold text-slate-900">Critères d'éligibilité</h2>
                <p className="mt-1 text-sm text-slate-500">Les télépros doivent remplir les critères suivants.</p>
                <div className="mt-4 space-y-2">
                  {ELIGIBILITY_CRITERIA.map((k) => {
                    const Icon = CRITERION_ICON[k];
                    const on = form.criteria[k] !== false;
                    return (
                      <label key={k} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm hover:bg-slate-50">
                        <input type="checkbox" checked={on} onChange={(e) => setCriterion(k, e.target.checked)} className="h-4 w-4" />
                        <span className="flex-1 text-slate-800">{ELIGIBILITY_CRITERION_LABELS[k]}</span>
                        <Icon className="h-4 w-4 text-slate-400" />
                      </label>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-slate-500">Pause, absence et distribution suspendue excluent toujours un télépro : ces règles ne sont pas désactivables.</p>
              </section>

              <div className="space-y-6">
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="text-base font-semibold text-slate-900">Ordre de priorité</h2>
                  <p className="mt-1 text-sm text-slate-500">Les règles sont évaluées dans l'ordre ci-dessous.</p>
                  <ol className="mt-4 space-y-2">
                    {form.rankingOrder.map((k, i) => (
                      <li key={k} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{i + 1}</span>
                        <span className="flex-1 text-slate-800">{RANKING_CRITERION_LABELS[k]}</span>
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Monter « ${RANKING_CRITERION_LABELS[k]} »`} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === form.rankingOrder.length - 1} aria-label={`Descendre « ${RANKING_CRITERION_LABELS[k]} »`} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="text-base font-semibold text-slate-900">Capacité</h2>
                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Plafond de nouveaux leads actifs
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      className={cn(inputClass, 'mt-1')}
                      value={form.defaultNewLeadsCap}
                      onChange={(e) => setForm((f) => ({ ...f, defaultNewLeadsCap: Number(e.target.value) || 0 }))}
                    />
                  </label>
                  <p className="mt-2 text-xs text-slate-500">
                    S'applique aux télépros dont le plafond n'est pas défini individuellement (fiche utilisateur). Le critère « Capacité disponible » à gauche bloque l'attribution quand ce plafond est atteint.
                  </p>
                </section>
              </div>
            </div>
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-slate-900">Simulation en temps réel</h2>
            <p className="mt-1 text-sm text-slate-500">Testez l'attribution d'un lead entrant avec les règles ci-contre, même non enregistrées.</p>

            <div className="mt-4 rounded-lg bg-blue-50 p-4">
              <p className="text-xs text-blue-700">Lead entrant</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <input className={inputClass} value={simProduct} onChange={(e) => setSimProduct(e.target.value)} placeholder="Produit (ex. PAC Air/Eau)" aria-label="Produit du lead simulé" />
                <input className={inputClass} value={simZone} onChange={(e) => setSimZone(e.target.value)} placeholder="Zone (ex. Île-de-France)" aria-label="Zone du lead simulé" />
              </div>
            </div>

            <p className="mt-4 text-sm font-medium text-slate-700">Télépros éligibles</p>
            <ul className="mt-2 space-y-2">
              {result?.rows.length === 0 && <li className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">Aucun télépro n'a de profil. Configurez-les dans « Utilisateurs ».</li>}
              {result?.rows.map((r) => (
                <li key={r.uid} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm', r.recommended ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200')}>
                  <span className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', r.eligible ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500')}>{initials(r.name)}</span>
                  <span className="flex-1 font-medium text-slate-800">{r.name}</span>
                  {r.eligible ? (
                    <span className="text-emerald-700">{r.newLeads}/{r.cap} — Disponible</span>
                  ) : (
                    <span className="text-right text-xs font-medium text-red-600" title={r.exclusions.map((x) => EXCLUSION_LABELS[x]).join(', ')}>
                      Indisponible
                      <span className="block font-normal text-slate-500">{r.exclusions.map((x) => EXCLUSION_LABELS[x]).join(', ')}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {result && (
              <div aria-live="polite" className={cn('mt-4 flex items-start gap-3 rounded-lg border p-4 transition-shadow duration-300', result.recommendedName ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50', flash && 'ring-4 ring-blue-300')}>
                {result.recommendedName ? <Trophy className="mt-0.5 h-5 w-5 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />}
                <div className="text-sm">
                  {result.recommendedName ? (
                    <>
                      <p className="font-semibold text-emerald-800">Attribution recommandée : {result.recommendedName}</p>
                      <p className="text-emerald-700">Basée sur les règles et critères configurés.</p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold text-amber-900">Aucun télépro éligible : le lead irait en file tampon.</p>
                      <p className="text-amber-800">Motif principal : {result.decision.bufferReason ? (EXCLUSION_LABELS[result.decision.bufferReason as keyof typeof EXCLUSION_LABELS] ?? 'aucun candidat') : 'aucun candidat'}.</p>
                    </>
                  )}
                </div>
              </div>
            )}

            <button type="button" onClick={runTest} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
              <Play className="h-4 w-4" /> Tester une attribution
            </button>
            <p className="mt-2 text-center text-xs text-slate-500" role="status">
              {testedAt === null
                ? "Le résultat ci-dessus se met à jour en direct quand vous changez une règle ou le lead. Ce bouton relit la présence des télépros et l'heure."
                : `Test relancé à ${new Date(testedAt).toLocaleTimeString('fr-FR')} : présence des télépros et horaires relus.`}
            </p>
            <p className="mt-2 text-xs text-slate-400">La simulation et l'attribution réelle utilisent le même moteur. À égalité parfaite, le départage dépend de l'identifiant du lead.</p>
          </section>
        </div>
      )}

      {campaign && (
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
          {dirty && <span className="mr-auto text-sm text-amber-700">Modifications non enregistrées</span>}
          <button type="button" disabled={!dirty || saving} onClick={() => { setForm(saved); setNotice(null); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">Annuler</button>
          <button type="button" disabled={!dirty || saving} onClick={save} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
            {saving ? 'Enregistrement…' : 'Enregistrer les règles'}
          </button>
        </div>
      )}
    </div>
  );
}
