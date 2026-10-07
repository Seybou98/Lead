import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Calendar, ChevronDown, CircleDot, Clock, Info, MapPin, Package, Pencil, Plug, Users, Wallet, Megaphone, Link2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { resolveLeadRole } from '../../config/roles';
import { ChipMultiSelect, type ChipOption } from '../../components/ui/ChipMultiSelect';
import { WeeklyScheduleEditor, type WeeklySlot } from '../../components/ui/WeeklyScheduleEditor';
import { Field, inputClass, parseList } from '../../components/ui/Modal';
import { SourceLogo } from '../../components/ui/SourceLogo';
import { parseEuros } from '../../domain/admin/money';
import { formatEuros } from '../../domain/admin/campaignStats';
import { formatWeeklySchedule } from '../../domain/admin/scheduleFormat';
import { errorMessage, saveCampaign, saveSource, type CampaignInput } from '../../lib/adminApi';
import { useCampaignFormData, type CampaignFormData } from './useCampaignFormData';
import type { CampaignRecord } from './useCampaignsData';

type Status = CampaignInput['status'];

const STATUS_LABELS: Record<Status, string> = { draft: 'Brouillon', active: 'Active', suspended: 'Suspendue', ended: 'Terminée' };
const STATUS_DOT: Record<Status, string> = { draft: 'bg-slate-400', active: 'bg-emerald-500', suspended: 'bg-amber-500', ended: 'bg-slate-400' };

const SOURCE_KINDS: { value: 'meta' | 'google' | 'site' | 'agency' | 'import' | 'manual'; label: string }[] = [
  { value: 'meta', label: 'Meta (Facebook, Instagram)' },
  { value: 'google', label: 'Google Ads' },
  { value: 'site', label: 'Formulaire du site' },
  { value: 'agency', label: 'Agence ou fournisseur' },
  { value: 'import', label: 'Import' },
  { value: 'manual', label: 'Saisie manuelle' },
];

const toDateInput = (ms: number | null) => (ms === null ? '' : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10));
const fromDateInput = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : null);
/** « 2026-10-31 » → « 31/10/2026 » */
const frDate = (v: string) => (v ? v.split('-').reverse().join('/') : '');

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-6', className)}>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function SummaryRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <div className="text-sm font-medium text-slate-800">{children}</div>
      </div>
    </div>
  );
}

export function CampaignFormPage() {
  const { campaignId } = useParams();
  return <CampaignFormView data={useCampaignFormData()} campaignId={campaignId ?? null} />;
}

export function CampaignFormView({ data, campaignId }: { data: CampaignFormData; campaignId: string | null }) {
  const campaign = campaignId ? (data.campaigns.find((c) => c.id === campaignId) ?? null) : null;
  const back = (
    <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
      <Link to="/campagnes" className="text-blue-600 hover:underline">Campagnes</Link>
      <span className="mx-2">/</span>
      <span>{campaignId ? 'Modifier la campagne' : 'Nouvelle campagne'}</span>
    </nav>
  );

  if (data.loading) return <div className="w-full">{back}<p className="mt-6 text-slate-500">Chargement…</p></div>;
  if (campaignId && !campaign) {
    return (
      <div className="w-full">
        {back}
        <div role="alert" className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-slate-900">Campagne introuvable</h1>
          <Link to="/campagnes" className="mt-4 inline-block text-sm text-blue-600 hover:underline">Retour aux campagnes</Link>
        </div>
      </div>
    );
  }
  return <CampaignForm key={campaignId ?? 'new'} data={data} campaign={campaign} breadcrumb={back} />;
}

function CampaignForm({ data, campaign, breadcrumb }: { data: CampaignFormData; campaign: CampaignRecord | null; breadcrumb: React.ReactNode }) {
  const navigate = useNavigate();
  const editing = campaign !== null;

  const [name, setName] = useState(campaign?.name ?? '');
  const [sourceId, setSourceId] = useState(campaign?.sourceId ?? '');
  const [newSource, setNewSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceKind, setNewSourceKind] = useState<(typeof SOURCE_KINDS)[number]['value']>('meta');
  const [externalId, setExternalId] = useState(campaign?.externalId ?? '');
  const [product, setProduct] = useState(campaign?.productCode ?? '');
  const [zones, setZones] = useState((campaign?.zones ?? []).join(', '));
  const [status, setStatus] = useState<Status>(campaign?.status ?? 'draft');
  const [budget, setBudget] = useState(campaign?.budgetCents != null ? String(campaign.budgetCents / 100).replace('.', ',') : '');
  const [starts, setStarts] = useState(toDateInput(campaign?.startsAtMs ?? null));
  const [ends, setEnds] = useState(toDateInput(campaign?.endsAtMs ?? null));
  const [reception, setReception] = useState<WeeklySlot[]>(campaign?.receptionSchedule?.weekly ?? []);
  const [editHours, setEditHours] = useState(false);
  const [eligible, setEligible] = useState<string[]>([
    ...(campaign?.eligibleTeamIds ?? []).map((id) => `team:${id}`),
    ...(campaign?.eligibleUserIds ?? []).map((id) => `user:${id}`),
  ]);
  const [autoEligible, setAutoEligible] = useState(campaign?.autoEligible ?? false);
  const [fallbackId, setFallbackId] = useState(campaign?.fallbackTeamId ?? '');
  const [maxReassign, setMaxReassign] = useState(campaign?.maxReassignments != null ? String(campaign.maxReassignments) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: ChipOption[] = useMemo(() => {
    const teams = data.teams.map((t) => ({ id: `team:${t.id}`, label: t.name, hint: `${t.memberIds.length} membre${t.memberIds.length > 1 ? 's' : ''}` }));
    const users = data.users
      .filter((u) => String(u.status ?? '').toLowerCase() === 'active' && resolveLeadRole(u.role) === 'telepro')
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'fr'))
      .map((u) => ({ id: `user:${u.uid}`, label: u.name || u.email, disabledReason: data.profileUids.has(u.uid) ? undefined : 'Non configuré' }));
    return [...teams, ...users];
  }, [data.teams, data.users, data.profileUids]);

  const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id.replace(/^(team|user):/, '');
  const sourceById = new Map(data.sources.map((s) => [s.id, s]));
  const chosenSource = newSource ? { name: newSourceName.trim() || 'Nouvelle source', kind: newSourceKind } : sourceById.get(sourceId);

  const productHints = [...new Set(data.campaigns.map((c) => c.productCode).filter((p): p is string => !!p))];
  const zoneHints = [...new Set(data.campaigns.flatMap((c) => c.zones))];

  const submit = async (forced: Status | null) => {
    setError(null);
    if (!name.trim()) return setError('Le nom de la campagne est obligatoire.');
    const budgetCents = budget.trim() === '' ? null : parseEuros(budget);
    if (budget.trim() !== '' && budgetCents === null) return setError('Budget : un montant en euros, positif.');
    const reassign = maxReassign.trim() === '' ? null : Number(maxReassign);
    if (reassign !== null && !Number.isInteger(reassign)) return setError('Réattributions maximales : un nombre entier.');

    const finalStatus = forced ?? status;
    setBusy(true);
    try {
      let src = sourceId;
      if (newSource) {
        if (!newSourceName.trim()) throw new Error('Donnez un nom à la nouvelle source.');
        src = (await saveSource({ name: newSourceName.trim(), kind: newSourceKind, enabled: true })).id;
      }
      if (!src) throw new Error('Choisissez une source (ou créez-en une).');

      const res = await saveCampaign({
        id: campaign?.id,
        name: name.trim(),
        sourceId: src,
        externalId: externalId.trim() || null,
        productCode: product.trim() || null,
        zones: parseList(zones),
        status: finalStatus,
        budgetCents,
        startsAtMs: fromDateInput(starts),
        endsAtMs: fromDateInput(ends),
        eligibleTeamIds: eligible.filter((i) => i.startsWith('team:')).map((i) => i.slice(5)),
        eligibleUserIds: eligible.filter((i) => i.startsWith('user:')).map((i) => i.slice(5)),
        autoEligible,
        fallbackTeamId: fallbackId || null,
        maxReassignments: reassign,
        receptionSchedule: reception.length ? { timezone: campaign?.receptionSchedule?.timezone ?? 'Europe/Paris', weekly: reception } : null,
        reason: reason.trim() || undefined,
      });
      navigate('/campagnes', { state: { notice: { text: editing ? 'Campagne enregistrée.' : finalStatus === 'active' ? 'Campagne créée et activée.' : 'Campagne enregistrée en brouillon.', warnings: res.warnings } } });
    } catch (e) {
      // Une erreur locale (nouvelle source vide…) est déjà lisible ; une erreur d'écriture passe par errorMessage.
      setError(e instanceof Error && !('code' in e) ? e.message : errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      {breadcrumb}
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">{editing ? 'Modifier la campagne' : 'Créer une campagne'}</h1>
      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}

      <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card title="Informations générales">
            <Field label="Nom de la campagne">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="PAC IDF — Octobre 2026" autoFocus={!editing} />
            </Field>

            <div>
              <Field label="Source">
                <select
                  className={inputClass}
                  value={newSource ? '__new' : sourceId}
                  onChange={(e) => (e.target.value === '__new' ? setNewSource(true) : (setNewSource(false), setSourceId(e.target.value)))}
                >
                  <option value="">— Choisir —</option>
                  {data.sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.enabled ? '' : ' (désactivée)'}</option>
                  ))}
                  <option value="__new">+ Nouvelle source…</option>
                </select>
              </Field>
              {!newSource && sourceId && (
                <p className="mt-1.5 text-xs text-slate-500">
                  Identifiant de la source : <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{sourceId}</code>
                  <span className="block">À ajouter à l'adresse de réception des leads : <code className="font-mono">?source={sourceId}</code> (facultatif).</span>
                </p>
              )}
              {newSource && (
                <div className="mt-2 space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <input className={inputClass} placeholder="Nom de la source (ex. Meta Ads)" value={newSourceName} onChange={(e) => setNewSourceName(e.target.value)} aria-label="Nom de la nouvelle source" />
                  <select className={inputClass} value={newSourceKind} onChange={(e) => setNewSourceKind(e.target.value as typeof newSourceKind)} aria-label="Type de la nouvelle source">
                    {SOURCE_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <Field label="Identifiant externe">
              <input className={inputClass} value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="META-98341 — celui envoyé par la source avec chaque lead" />
            </Field>
            <Field label="Produit">
              <input className={inputClass} list="product-hints" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="PAC Air/Eau" />
              <datalist id="product-hints">{productHints.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <Field label="Zone géographique">
              <input className={inputClass} list="zone-hints" value={zones} onChange={(e) => setZones(e.target.value)} placeholder="Île-de-France (plusieurs : séparées par des virgules)" />
              <datalist id="zone-hints">{zoneHints.map((z) => <option key={z} value={z} />)}</datalist>
            </Field>
            <Field label="Statut">
              <div className="relative">
                <span className={cn('pointer-events-none absolute left-3 top-1/2 mt-0.5 h-2.5 w-2.5 -translate-y-1/2 rounded-full', STATUS_DOT[status])} />
                <select className={cn(inputClass, 'pl-8')} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
                  {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </Field>
          </Card>

          <Card title="Équipe éligible">
            <div>
              <p className="text-sm font-medium text-slate-700">Télépros éligibles</p>
              <div className="mt-1">
                <ChipMultiSelect options={options} selected={eligible} onChange={setEligible} placeholder="Choisir des télépros ou des équipes" ariaLabel="Télépros et équipes éligibles" />
              </div>
              {options.some((o) => o.disabledReason) && (
                <p className="mt-1.5 text-xs text-slate-500">Un télépro « non configuré » n'a pas encore de profil de distribution : configurez-le d'abord dans « Utilisateurs ».</p>
              )}
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-800">
              <input type="checkbox" checked={autoEligible} onChange={(e) => setAutoEligible(e.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>
                Tous les télépros autorisés pour ce produit
                <span className="block text-xs text-slate-500">Aucune restriction d'équipe : le produit, la zone, les horaires et la capacité de chaque télépro décident.</span>
              </span>
            </label>

            <details className="rounded-lg border border-slate-200">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-slate-700">
                Options avancées <ChevronDown className="h-4 w-4 text-slate-400" />
              </summary>
              <div className="space-y-4 border-t border-slate-200 p-4">
                <Field label="Équipe de secours" hint="Reçoit les leads quand plus personne n'est disponible dans les équipes éligibles.">
                  <select className={inputClass} value={fallbackId} onChange={(e) => setFallbackId(e.target.value)}>
                    <option value="">— Aucune —</option>
                    {data.teams.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Réattributions maximales" hint="Nombre de transferts automatiques autorisés par lead.">
                  <input type="number" min={0} max={20} className={inputClass} value={maxReassign} onChange={(e) => setMaxReassign(e.target.value)} />
                </Field>
                <Field label="Motif de la modification (facultatif)" hint="Conservé dans le journal d'audit.">
                  <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </div>
            </details>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Budget & période">
            <Field label="Budget prévu">
              <div className="relative">
                <input inputMode="decimal" className={cn(inputClass, 'pr-8')} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="12 000" />
                <span className="pointer-events-none absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 text-sm text-slate-500">€</span>
              </div>
            </Field>
            <Field label="Date de début">
              <input type="date" className={inputClass} value={starts} onChange={(e) => setStarts(e.target.value)} />
            </Field>
            <Field label="Date de fin">
              <input type="date" className={inputClass} value={ends} onChange={(e) => setEnds(e.target.value)} />
            </Field>
            <div>
              <span className="text-sm font-medium text-slate-700">Horaires de réception</span>
              <button
                type="button"
                onClick={() => setEditHours((o) => !o)}
                aria-expanded={editHours}
                className="mt-1 flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-50"
              >
                <span>{formatWeeklySchedule(reception)}</span>
                <ChevronDown className={cn('h-4 w-4 text-slate-500 transition-transform', editHours && 'rotate-180')} />
              </button>
              {editHours && (
                <div className="mt-2">
                  <WeeklyScheduleEditor initial={reception} onChange={setReception} />
                </div>
              )}
              <p className="mt-1.5 text-xs text-slate-500">Enregistrés avec la campagne ; le moteur ne les applique pas encore.</p>
            </div>
          </Card>

          <Card title="Traçabilité">
            <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
              <p>La source, la campagne et la date d'arrivée seront conservées dans l'historique du lead.</p>
            </div>
          </Card>
        </div>

        <aside>
          <section className="rounded-xl border border-slate-200 bg-white p-6 xl:sticky xl:top-0">
            <h2 className="text-base font-semibold text-slate-900">Résumé de la campagne</h2>
            <div className="mt-4 space-y-4">
              <SummaryRow icon={<Megaphone className="h-4 w-4" />} label="Nom de la campagne">{name.trim() || <span className="font-normal text-slate-400">À renseigner</span>}</SummaryRow>
              <SummaryRow icon={<Plug className="h-4 w-4" />} label="Source">
                {chosenSource ? (
                  <span className="inline-flex items-center gap-2"><SourceLogo kind={chosenSource.kind} className="h-3.5 w-4" />{chosenSource.name}</span>
                ) : (
                  <span className="font-normal text-slate-400">À choisir</span>
                )}
              </SummaryRow>
              <SummaryRow icon={<Link2 className="h-4 w-4" />} label="Identifiant externe">{externalId.trim() || <span className="font-normal text-slate-400">—</span>}</SummaryRow>
              <SummaryRow icon={<Package className="h-4 w-4" />} label="Produit">{product.trim() || <span className="font-normal text-slate-400">—</span>}</SummaryRow>
              <SummaryRow icon={<MapPin className="h-4 w-4" />} label="Zone géographique">{parseList(zones).join(', ') || <span className="font-normal text-slate-400">—</span>}</SummaryRow>
              <SummaryRow icon={<CircleDot className="h-4 w-4" />} label="Statut">
                <span className="inline-flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />{STATUS_LABELS[status]}</span>
              </SummaryRow>
              <hr className="border-slate-100" />
              <SummaryRow icon={<Wallet className="h-4 w-4" />} label="Budget prévu">
                {budget.trim() && parseEuros(budget) !== null ? formatEuros(parseEuros(budget), 0) : <span className="font-normal text-slate-400">—</span>}
              </SummaryRow>
              <SummaryRow icon={<Calendar className="h-4 w-4" />} label="Période">
                {starts || ends ? `${frDate(starts) || '…'} → ${frDate(ends) || '…'}` : <span className="font-normal text-slate-400">—</span>}
              </SummaryRow>
              <SummaryRow icon={<Clock className="h-4 w-4" />} label="Horaires de réception">{formatWeeklySchedule(reception)}</SummaryRow>
              <SummaryRow icon={<Users className="h-4 w-4" />} label="Équipe éligible">
                {eligible.length ? eligible.map(labelOf).join(', ') : <span className="font-normal text-slate-400">{autoEligible ? 'Aucune restriction' : 'Aucune sélection'}</span>}
              </SummaryRow>
              {autoEligible && (
                <p className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700">
                  <Pencil className="h-3.5 w-3.5 text-slate-400" /> Tous les télépros autorisés pour ce produit
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>

      {error && (
        <p role="alert" className="mt-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}
        </p>
      )}

      <div className="sticky bottom-0 z-10 -mx-3 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-3 py-4 backdrop-blur sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <Link to="/campagnes" className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</Link>
        {editing ? (
          <button type="button" disabled={busy} onClick={() => submit(null)} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => submit('draft')} className="rounded-lg border border-blue-600 px-5 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60">
              Enregistrer en brouillon
            </button>
            <button type="button" disabled={busy} onClick={() => submit('active')} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {busy ? 'Enregistrement…' : 'Créer et activer'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
