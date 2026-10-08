import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, FileText, Gauge, Headset, Phone, Plus, Search, UserMinus, Users, UserCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ROLES, type OperationalStatus, type Role } from '../../domain/enums';
import { DISTRIBUTION_LABELS, OPERATIONAL_STATUS_LABELS, ROLE_LABELS } from '../../domain/labels';
import {
  buildUserRows,
  computeAlerts,
  computeKpis,
  filterUserRows,
  NO_FILTERS,
  summarizeTeams,
  type DistributionState,
  type UserFilters,
  type UserRow,
} from '../../domain/admin/userRows';
import { errorMessage, saveProfile } from '../../lib/adminApi';
import { useUsersData, type UsersData } from './useUsersData';
import { ProfileModal } from './ProfileModal';
import { TeamModal } from './TeamModal';
import { KebabMenu } from '../../components/ui/KebabMenu';

const PAGE_SIZES = [10, 25, 50];

/** « État des équipes » (fig. 20) : une couleur et un pictogramme par équipe, en rotation. */
const TEAM_PALETTE = [
  { Icon: Users, circle: 'bg-blue-50 text-blue-600', bar: 'bg-blue-500', text: 'text-blue-600' },
  { Icon: Headset, circle: 'bg-emerald-50 text-emerald-600', bar: 'bg-emerald-500', text: 'text-emerald-600' },
  { Icon: FileText, circle: 'bg-violet-50 text-violet-600', bar: 'bg-violet-500', text: 'text-violet-600' },
] as const;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

// §12.11 : la couleur est toujours accompagnée d'un libellé.
const DISTRIBUTION_STYLE: Record<DistributionState, string> = {
  active: 'text-emerald-700',
  suspended: 'text-red-600',
  paused: 'text-amber-600',
  full: 'text-red-600',
  no_profile: 'text-slate-500',
  not_applicable: 'text-slate-400',
};

function StatusPill({ row }: { row: UserRow }) {
  if (!row.accountActive) return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">Compte inactif</span>;
  if (!row.connected) return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">● Déconnecté</span>;
  if (row.operationalStatus === null) return <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">● Connecté</span>;
  const tone: Record<OperationalStatus, string> = {
    available: 'bg-emerald-50 text-emerald-700',
    on_call: 'bg-blue-50 text-blue-700',
    processing: 'bg-blue-50 text-blue-700',
    doc_followup: 'bg-blue-50 text-blue-700',
    file_building: 'bg-blue-50 text-blue-700',
    in_meeting: 'bg-amber-50 text-amber-700',
    paused: 'bg-amber-50 text-amber-700',
    absent: 'bg-amber-50 text-amber-700',
    disconnected: 'bg-slate-100 text-slate-600',
    unavailable: 'bg-red-50 text-red-700',
  };
  return <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', tone[row.operationalStatus])}>● {OPERATIONAL_STATUS_LABELS[row.operationalStatus]}</span>;
}

function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className={cn('flex h-11 w-11 items-center justify-center rounded-full', tone)}>{icon}</div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-2xl font-semibold text-slate-900">{value}</p>
      </div>
    </div>
  );
}

const selectClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

/** Lecture Firestore ici ; tout l'affichage est dans UsersView (rendu aussi avec des données fictives pour contrôle visuel). */
export function UsersPage() {
  // Message de confirmation laissé par la page de création (fig. 21) avant la redirection.
  const state = useLocation().state as { notice?: { text: string; warnings?: string[] } } | null;
  return <UsersView data={useUsersData()} initialNotice={state?.notice ? { kind: 'ok', ...state.notice } : null} />;
}

export function UsersView({ data, initialNotice = null }: { data: UsersData; initialNotice?: { kind: 'ok' | 'error'; text: string; warnings?: string[] } | null }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<UserFilters>(NO_FILTERS);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [profileRow, setProfileRow] = useState<UserRow | null>(null);
  const [teamEdit, setTeamEdit] = useState<{ id: string | null } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string; warnings?: string[] } | null>(initialNotice);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const rows = useMemo(
    () => buildUserRows(data.users, data.profiles, data.teams, data.presence, data.nowMs),
    [data.users, data.profiles, data.teams, data.presence, data.nowMs]
  );
  const filtered = useMemo(() => filterUserRows(rows, filters), [rows, filters]);
  const kpis = useMemo(() => computeKpis(rows), [rows]);
  const summaries = useMemo(() => summarizeTeams(data.teams, rows), [data.teams, rows]);
  const alerts = useMemo(() => computeAlerts(data.teams, rows), [data.teams, rows]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = filtered.slice((current - 1) * pageSize, current * pageSize);
  const setFilter = <K extends keyof UserFilters>(k: K, v: UserFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  const saved = (what: string) => (warnings: string[]) => {
    setProfileRow(null);
    setTeamEdit(null);
    setNotice({ kind: 'ok', text: `${what} enregistré.`, warnings });
    data.reloadUsers();
  };

  const toggleDistribution = async (row: UserRow) => {
    setBusyUid(row.uid);
    setNotice(null);
    try {
      const suspend = row.distribution !== 'suspended';
      await saveProfile({ uid: row.uid, distributionSuspended: suspend, reason: suspend ? 'Suspension depuis la liste des utilisateurs' : 'Réactivation depuis la liste des utilisateurs' });
      setNotice({ kind: 'ok', text: `Distribution ${suspend ? 'suspendue' : 'réactivée'} pour ${row.name}.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusyUid(null);
    }
  };

  const alertText: Record<string, (n: number) => string> = {
    team_without_members: (n) => `${n} équipe${n > 1 ? 's' : ''} sans membre`,
    capacity_reached: (n) => `${n} capacité${n > 1 ? 's' : ''} atteinte${n > 1 ? 's' : ''}`,
    user_without_profile: (n) => `${n} télépro${n > 1 ? 's' : ''} non configuré${n > 1 ? 's' : ''}`,
    user_without_team: (n) => `${n} télépro${n > 1 ? 's' : ''} sans équipe`,
  };
  const inactiveTeams = data.teams.filter((t) => !t.active);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Utilisateurs &amp; équipes</h1>
          <p className="mt-1 text-slate-500">Gérez les accès, les capacités et la disponibilité de vos équipes.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setTeamEdit({ id: null })}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Users className="h-4 w-4" /> Créer une équipe
          </button>
          <Link to="/utilisateurs/nouveau" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> Créer un utilisateur
          </Link>
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={cn('mt-4 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 font-medium">
                {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {notice.text}
              </p>
              {notice.warnings?.map((w) => (
                <p key={w} className="mt-1 text-amber-800">⚠ {w}</p>
              ))}
            </div>
            <button type="button" onClick={() => setNotice(null)} className="text-xs underline">
              Fermer
            </button>
          </div>
        </div>
      )}

      {data.error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {data.error}
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi icon={<Users className="h-5 w-5" />} label="Utilisateurs actifs" value={String(kpis.activeUsers)} tone="bg-blue-50 text-blue-600" />
        <Kpi icon={<UserCheck className="h-5 w-5" />} label="Télépros disponibles" value={String(kpis.availableTelepros)} tone="bg-emerald-50 text-emerald-600" />
        <Kpi icon={<Phone className="h-5 w-5" />} label="En appel" value={String(kpis.onCall)} tone="bg-sky-50 text-sky-600" />
        <Kpi icon={<UserMinus className="h-5 w-5" />} label="Absents" value={String(kpis.absent)} tone="bg-amber-50 text-amber-600" />
        <Kpi icon={<Gauge className="h-5 w-5" />} label="Capacité globale" value={`${kpis.capacityUsed}/${kpis.capacityTotal}`} tone="bg-violet-50 text-violet-600" />
      </div>

      <div className="mt-6 space-y-6">
        <section id="users-table" className="min-w-0 scroll-mt-4 rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => setFilter('search', e.target.value)}
                placeholder="Rechercher un utilisateur"
                aria-label="Rechercher un utilisateur"
                className="w-56 rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <select aria-label="Filtrer par rôle" className={selectClass} value={filters.role} onChange={(e) => setFilter('role', e.target.value as Role | 'all')}>
              <option value="all">Tous les rôles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <select aria-label="Filtrer par équipe" className={selectClass} value={filters.teamId} onChange={(e) => setFilter('teamId', e.target.value)}>
              <option value="all">Toutes les équipes</option>
              <option value="none">Sans équipe</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select aria-label="Filtrer par statut" className={selectClass} value={filters.status} onChange={(e) => setFilter('status', e.target.value as UserFilters['status'])}>
              <option value="all">Tous les statuts</option>
              <option value="offline">Déconnectés</option>
              {(Object.keys(OPERATIONAL_STATUS_LABELS) as OperationalStatus[])
                .filter((s) => s !== 'disconnected')
                .map((s) => (
                  <option key={s} value={s}>
                    {OPERATIONAL_STATUS_LABELS[s]}
                  </option>
                ))}
            </select>
            <select aria-label="Filtrer par distribution" className={selectClass} value={filters.distribution} onChange={(e) => setFilter('distribution', e.target.value as UserFilters['distribution'])}>
              <option value="all">Distribution : toutes</option>
              {(['active', 'suspended', 'paused', 'full', 'no_profile'] as DistributionState[]).map((d) => (
                <option key={d} value={d}>
                  {DISTRIBUTION_LABELS[d]}
                </option>
              ))}
            </select>
            {filtersActive && (
              <button type="button" onClick={() => { setFilters(NO_FILTERS); setPage(1); }} className="text-sm text-blue-600 underline">
                Réinitialiser
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  {['Utilisateur', 'Rôle', 'Équipe', 'Produits', 'Zones', 'Capacité', 'Statut', 'Distribution', 'Actions'].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.loading && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                      Chargement…
                    </td>
                  </tr>
                )}
                {!data.loading && pageRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                      {rows.length === 0
                        ? "Aucun utilisateur n'a accès au CRM Leads. Les rôles concernés sont « administrateur », « manager » et « telepro commercial »."
                        : 'Aucun résultat pour ces filtres.'}
                    </td>
                  </tr>
                )}
                {pageRows.map((r) => (
                  <tr key={r.uid} className={cn('hover:bg-slate-50', !r.accountActive && 'opacity-60')}>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">{initials(r.name)}</span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{r.role === 'telepro' ? <Link to={`/utilisateurs/${r.uid}`} className="hover:text-blue-700 hover:underline">{r.name}</Link> : r.name}</p>
                          {r.email && <p className="truncate text-xs text-slate-500">{r.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{ROLE_LABELS[r.role]}</td>
                    <td className="px-3 py-3 text-slate-700">{r.teamNames.length ? r.teamNames.join(', ') : <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-3 text-slate-700">{r.products.length ? r.products.join(' + ') : <span className="text-slate-400">{r.role === 'telepro' ? 'Aucun' : 'Tous'}</span>}</td>
                    <td className="px-3 py-3 text-slate-700">{r.zones.length ? r.zones.join(' + ') : <span className="text-slate-400">{r.role === 'telepro' ? 'Aucune' : 'Toutes'}</span>}</td>
                    <td className={cn('whitespace-nowrap px-3 py-3 font-medium', r.distribution === 'full' ? 'text-red-600' : 'text-slate-800')}>
                      {r.cap === null ? '—' : `${r.newLeads}/${r.cap}`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <StatusPill row={r} />
                    </td>
                    <td className={cn('whitespace-nowrap px-3 py-3 font-medium', DISTRIBUTION_STYLE[r.distribution])}>{DISTRIBUTION_LABELS[r.distribution]}</td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {r.role === 'telepro' && r.accountActive ? (
                        <KebabMenu
                          ariaLabel={`Actions pour ${r.name}`}
                          items={[
                            ...(r.hasProfile ? [{ label: 'Voir la fiche', onSelect: () => navigate(`/utilisateurs/${r.uid}`) }] : []),
                            { label: r.hasProfile ? 'Modifier le profil' : 'Configurer le profil', onSelect: () => setProfileRow(r) },
                            ...(r.hasProfile
                              ? [{ label: r.distribution === 'suspended' ? 'Réactiver la distribution' : 'Suspendre la distribution', onSelect: () => toggleDistribution(r), disabled: busyUid === r.uid, separator: true }]
                              : []),
                          ]}
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              {filtered.length === 0 ? 'Aucun utilisateur' : `Affichage de ${(current - 1) * pageSize + 1} à ${Math.min(current * pageSize, filtered.length)} sur ${filtered.length} utilisateur${filtered.length > 1 ? 's' : ''}`}
            </span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                Lignes par page
                <select className={selectClass} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">
                Précédent
              </button>
              <span>
                {current} / {pageCount}
              </span>
              <button type="button" disabled={current >= pageCount} onClick={() => setPage(current + 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">
                Suivant
              </button>
            </div>
          </div>
        </section>

        <aside>
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-slate-900">État des équipes</h2>
            <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
              {data.teams.length === 0 && !data.loading && <p className="text-sm text-slate-500 md:col-span-2 xl:col-span-3">Aucune équipe. Créez la première pour commencer à distribuer des leads.</p>}
              {summaries.map((s, idx) => {
                const pal = TEAM_PALETTE[idx % TEAM_PALETTE.length];
                const critical = s.percent >= 90;
                return (
                  <button key={s.id} type="button" onClick={() => setTeamEdit({ id: s.id })} className="flex w-full items-start gap-3 rounded-lg p-1 text-left hover:bg-slate-50">
                    <span className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full', critical ? 'bg-red-50 text-red-600' : pal.circle)}>
                      <pal.Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between text-sm">
                        <span className="truncate font-medium text-slate-800">{s.name}</span>
                        <span className="ml-2 flex-shrink-0 font-medium text-slate-700">{s.used}/{s.total}</span>
                      </span>
                      <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={s.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Capacité utilisée de ${s.name}`}>
                        <span className={cn('block h-full rounded-full', critical ? 'bg-red-500' : pal.bar)} style={{ width: `${s.percent}%` }} />
                      </span>
                      <span className="mt-1 block text-xs">
                        <span className={cn('font-medium', critical ? 'text-red-600' : pal.text)}>{s.percent} % de capacité</span>
                        <span className="text-slate-400"> · {s.memberCount} membre{s.memberCount > 1 ? 's' : ''}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
              {inactiveTeams.map((t) => (
                <button key={t.id} type="button" onClick={() => setTeamEdit({ id: t.id })} className="flex w-full items-center justify-between rounded-lg p-1 text-left text-sm text-slate-400 hover:bg-slate-50">
                  <span>{t.name}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">Inactive</span>
                </button>
              ))}
            </div>

            {/* Alertes : en bas de la carte, cliquables (fig. 20). */}
            <div className="mt-5 grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-2">
              {alerts.map((a) => {
                const critical = a.kind === 'capacity_reached';
                const teamName = a.kind === 'team_without_members' ? data.teams.filter((t) => a.ids.includes(t.id)).map((t) => t.name).join(', ') : null;
                const open = () => {
                  if (a.kind === 'team_without_members' && a.ids[0]) return setTeamEdit({ id: a.ids[0] });
                  setFilters({ ...NO_FILTERS, ...(a.kind === 'capacity_reached' ? { distribution: 'full' as const } : a.kind === 'user_without_profile' ? { distribution: 'no_profile' as const } : { teamId: 'none' as const }) });
                  setPage(1);
                  document.getElementById('users-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                };
                return (
                  <button key={a.kind} type="button" onClick={open} className={cn('flex w-full items-center gap-3 rounded-xl border p-4 text-left text-sm hover:shadow-sm', critical ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900')}>
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                    <span className="flex-1">
                      <span className="block font-semibold">{alertText[a.kind](a.count)}</span>
                      <span className="mt-0.5 block text-xs opacity-80">
                        {teamName ?? 'Voir les détails'}
                        {a.kind === 'capacity_reached' && ' — ces télépros ne reçoivent plus de nouveaux leads.'}
                        {a.kind === 'user_without_profile' && ' — sans périmètre, ils ne reçoivent aucun lead.'}
                        {a.kind === 'user_without_team' && ' — rattachés à aucune équipe, donc à aucun manager.'}
                        {a.kind === 'team_without_members' && ' — aucun lead ne peut leur être confié.'}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0" />
                  </button>
                );
              })}
              {alerts.length === 0 && !data.loading && (
                <p className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 md:col-span-2">
                  <CheckCircle2 className="h-4 w-4" /> Aucune anomalie détectée.
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>

      {profileRow && (
        <ProfileModal
          row={profileRow}
          raw={data.rawProfiles.get(profileRow.uid)}
          hasActiveOverride={!!data.profiles.get(profileRow.uid)?.capacity.override && (data.profiles.get(profileRow.uid)!.capacity.override!.untilMs > data.nowMs)}
          onClose={() => setProfileRow(null)}
          onSaved={saved('Profil')}
        />
      )}
      {teamEdit && (
        <TeamModal
          team={teamEdit.id ? (data.teams.find((t) => t.id === teamEdit.id) ?? null) : null}
          raw={teamEdit.id ? data.rawTeams.get(teamEdit.id) : undefined}
          users={data.users}
          teams={data.teams}
          onClose={() => setTeamEdit(null)}
          onSaved={saved('Équipe')}
        />
      )}
    </div>
  );
}
