import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, Lock, MapPin, Megaphone, Package, TrendingUp, User, Users, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ROLES, type Role } from '../../domain/enums';
import { ROLE_LABELS } from '../../domain/labels';
import { ChipMultiSelect, type ChipOption } from '../../components/ui/ChipMultiSelect';
import { inputClass } from '../../components/ui/Modal';
import { EMPTY_NEW_USER, fullName, initialsOf, validateNewUser, type NewUserInput } from '../../domain/admin/newUser';
import type { TeamInput } from '../../lib/adminApi';
import { createUser, CreateUserError } from '../../lib/userCreate';
import { ProductChips } from '../../components/ui/ProductPickers';
import { useProductCatalog } from '../products/useProductCatalog';
import { useCampaignFormData, type CampaignFormData } from '../campaigns/useCampaignFormData';
import { useUsersData } from './useUsersData';

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <span className="text-blue-600">{icon}</span> {title}
      </h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

/** Ligne « libellé à gauche, champ à droite » des cartes de la maquette. */
function Row({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="grid grid-cols-[140px_1fr] items-center gap-3">
        <span className="text-xs text-slate-600">{label}</span>
        <div>{children}</div>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-600 sm:ml-[152px]">{error}</p>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition-colors', checked ? 'bg-blue-600' : 'bg-slate-300')}
    >
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function ToggleRow({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-600">
        {label}
        {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/** Saisie de valeurs libres sous forme de pastilles : Entrée ou virgule ajoute, la croix retire. */
function TagInput({ values, onChange, placeholder, ariaLabel }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; ariaLabel: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          {v}
          <button type="button" aria-label={`Retirer ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        value={draft}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => (e.target.value.endsWith(',') ? (setDraft(e.target.value.slice(0, -1)), setTimeout(add)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add}
        className="min-w-[80px] flex-1 border-0 bg-transparent px-1 py-1 text-sm focus:outline-none"
      />
    </div>
  );
}

const compact = `${inputClass} !mt-0`;

export function UserFormPage() {
  const data = useCampaignFormData();
  const users = useUsersData();
  const teamInputs = useMemo(
    () =>
      new Map<string, TeamInput>(
        users.teams.map((t) => {
          const raw = users.rawTeams.get(t.id);
          return [t.id, { id: t.id, name: t.name, managerId: t.managerId, secondaryManagerId: t.secondaryManagerId, memberIds: [...t.memberIds], productCodes: raw?.productCodes ?? [], zones: raw?.zones ?? [], fallbackTeamId: raw?.fallbackTeamId ?? null, active: t.active }];
        })
      ),
    [users.teams, users.rawTeams]
  );
  return <UserFormView data={data} teamInputs={teamInputs} loading={users.loading || data.loading} />;
}

export function UserFormView({ data, teamInputs, loading }: { data: CampaignFormData; teamInputs: ReadonlyMap<string, TeamInput>; loading: boolean }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<NewUserInput>(EMPTY_NEW_USER);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catalog = useProductCatalog();
  const set = <K extends keyof NewUserInput>(k: K, v: NewUserInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = useMemo(() => validateNewUser(form, Date.now()), [form]);
  const valid = Object.keys(errors).length === 0;
  const invite = form.invite;
  const show = (k: keyof typeof errors) => (touched ? errors[k] : undefined);

  const isTelepro = form.role === 'telepro';
  const teams = data.teams.filter((t) => t.active);
  const campaignOptions: ChipOption[] = data.campaigns.map((c) => ({ id: c.id, label: c.name }));
  const team = teams.find((t) => t.id === form.teamId) ?? null;
  const campaignNames = form.campaignIds.map((id) => data.campaigns.find((c) => c.id === id)?.name ?? id);
  const capNum = form.cap.trim() === '' ? 10 : Number(form.cap);
  const name = fullName(form);

  const submit = async (draft: boolean) => {
    setTouched(true);
    setError(null);
    // Un brouillon n'ouvre aucun accès : pas de mot de passe à exiger.
    if (Object.keys(draft ? validateNewUser({ ...form, invite: true }, Date.now()) : errors).length > 0) return;
    setBusy(true);
    try {
      const res = await createUser({ input: form, draft, invite: form.invite && !draft, team: isTelepro && team ? (teamInputs.get(team.id) ?? null) : null });
      navigate('/utilisateurs', {
        state: {
          notice: {
            text: draft ? `Brouillon de ${name} enregistré : compte inactif, aucune invitation envoyée.` : `${name} a été créé${invite ? ' et invité par e-mail' : ''}.`,
            warnings: res.warnings,
          },
        },
      });
    } catch (e) {
      setError(e instanceof CreateUserError ? e.message : e instanceof Error ? e.message : "Impossible de créer l'utilisateur.");
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/utilisateurs" className="text-blue-600 hover:underline">Utilisateurs</Link>
        <span className="mx-2">/</span>
        <span>Nouvel utilisateur</span>
      </nav>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">Créer un utilisateur</h1>

      {data.error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_300px]">
        <div className="space-y-5">
          <Card icon={<User className="h-4 w-4" />} title="Identité">
            <Row label="Prénom" error={show('firstName')}>
              <input aria-label="Prénom" className={compact} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
            </Row>
            <Row label="Nom" error={show('lastName')}>
              <input aria-label="Nom" className={compact} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
            </Row>
            <Row label="Email professionnel" error={show('email')}>
              <input aria-label="Email professionnel" type="email" className={compact} value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Row>
            <Row label="Téléphone" error={show('phone')}>
              <input aria-label="Téléphone" type="tel" className={compact} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </Row>
            <Row label="Fonction interne">
              <input aria-label="Fonction interne" className={compact} value={form.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} />
            </Row>
          </Card>

          {isTelepro && (
            <Card icon={<MapPin className="h-4 w-4" />} title="Périmètre commercial">
              <Row label="Équipe principale">
                <select aria-label="Équipe principale" className={compact} value={form.teamId} onChange={(e) => set('teamId', e.target.value)}>
                  <option value="">Aucune équipe</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </Row>
              <Row label="Produits">
                <ProductChips ariaLabel="Produits" selected={form.products} onChange={(v) => set('products', v)} categories={catalog.categories} />
              </Row>
              <Row label="Zones">
                <TagInput ariaLabel="Zones" values={form.zones} onChange={(v) => set('zones', v)} placeholder="Ex. Île-de-France" />
              </Row>
              <Row label="Campagnes">
                <ChipMultiSelect ariaLabel="Campagnes" options={campaignOptions} selected={form.campaignIds} onChange={(v) => set('campaignIds', v)} placeholder="Toutes les campagnes" />
              </Row>
              <p className="text-[11px] text-slate-400">Un télépro sans produit ni zone ne reçoit aucun lead : renseignez au moins un périmètre.</p>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card icon={<Lock className="h-4 w-4" />} title="Accès">
            <Row label="Rôle CRM" error={show('role')}>
              <select aria-label="Rôle CRM" className={compact} value={form.role} onChange={(e) => set('role', e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </Row>
            <ToggleRow label="Invitation par email" checked={invite} onChange={(v) => set('invite', v)} hint={invite ? 'Il reçoit un lien pour choisir son mot de passe' : 'Vous choisissez son mot de passe ci-dessous'} />
            {!invite && (
              <Row label="Mot de passe" error={show('password')}>
                <input aria-label="Mot de passe" type="text" autoComplete="new-password" className={compact} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="8 caractères minimum, lettres et chiffres" />
                <p className="mt-1 text-[11px] text-slate-400">À communiquer à l&apos;utilisateur, qui pourra le changer ensuite.</p>
              </Row>
            )}
            <Row label="Date de fin d'accès" error={show('accessEndsOn')}>
              <div className="relative">
                <input aria-label="Date de fin d'accès" type="date" className={compact} value={form.accessEndsOn} onChange={(e) => set('accessEndsOn', e.target.value)} />
                <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
            </Row>
          </Card>

          {isTelepro && (
            <Card icon={<TrendingUp className="h-4 w-4" />} title="Capacité & distribution">
              <Row label="Plafond de nouveaux leads" error={show('cap')}>
                <input aria-label="Plafond de nouveaux leads" type="number" min={0} max={100} className={`${compact} !w-24`} value={form.cap} onChange={(e) => set('cap', e.target.value)} />
              </Row>
              <ToggleRow label="Distribution automatique" checked={form.autoDistribution} onChange={(v) => set('autoDistribution', v)} hint={form.autoDistribution ? undefined : 'Aucun lead ne sera attribué tant que la distribution est suspendue'} />
            </Card>
          )}
        </div>

        <aside>
          <section className="rounded-xl border border-slate-200 bg-white p-5 xl:sticky xl:top-0">
            <h2 className="text-sm font-semibold text-slate-900">Résumé du profil</h2>
            <div className="mt-4 flex flex-col items-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-violet-500 text-xl font-semibold text-white">{initialsOf(name)}</span>
              <p className="mt-2 text-base font-semibold text-slate-900">{name || 'Nouvel utilisateur'}</p>
              <span className="mt-1 rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">{ROLE_LABELS[form.role]}</span>
            </div>
            {isTelepro && (
              <dl className="mt-5 space-y-3 text-sm">
                <SummaryItem icon={<Users className="h-4 w-4" />} label="Équipe principale" value={team?.name} />
                <SummaryItem icon={<Package className="h-4 w-4" />} label="Produits" value={form.products.join(', ')} />
                <SummaryItem icon={<MapPin className="h-4 w-4" />} label="Zone" value={form.zones.join(', ')} />
                <SummaryItem icon={<Megaphone className="h-4 w-4" />} label="Campagne" value={campaignNames.join(', ')} />
                <div className="border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between text-sm font-medium text-slate-800">
                    <span>Capacité</span>
                    <span>0 / {Number.isFinite(capNum) ? capNum : '—'}</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-slate-100" />
                </div>
              </dl>
            )}
            <p className={cn('mt-5 flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm', valid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800')}>
              {valid ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {valid ? (invite ? 'Prêt à inviter' : 'Prêt à créer') : 'Informations manquantes'}
            </p>
          </section>
        </aside>
      </div>

      {loading && <p className="mt-4 text-xs text-slate-400">Chargement des équipes et des campagnes…</p>}
      {error && (
        <p role="alert" className="mt-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}
        </p>
      )}

      <div className="sticky bottom-0 z-10 -mx-3 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-3 py-4 backdrop-blur sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <Link to="/utilisateurs" className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</Link>
        <button type="button" disabled={busy} onClick={() => submit(true)} className="rounded-lg border border-blue-600 px-5 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60">
          Enregistrer en brouillon
        </button>
        <button type="button" disabled={busy} onClick={() => submit(false)} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? 'Création…' : invite ? "Créer et envoyer l'invitation" : "Créer l'utilisateur"}
        </button>
      </div>
    </div>
  );
}

function SummaryItem({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className="font-medium text-slate-800">{value || <span className="font-normal text-slate-400">—</span>}</p>
      </div>
    </div>
  );
}
