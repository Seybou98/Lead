import { describe, expect, it } from 'vitest';
import {
  buildUserRows,
  computeAlerts,
  computeKpis,
  filterUserRows,
  isConnected,
  NO_FILTERS,
  summarizeTeams,
  type MainUserView,
  type PresenceView,
  type ProfileView,
  type TeamView,
} from './userRows';

const NOW = Date.UTC(2026, 9, 6, 10, 0);
const MIN = 60_000;

const user = (uid: string, role: string, over: Partial<MainUserView> = {}): MainUserView => ({
  uid,
  name: uid.toUpperCase(),
  email: `${uid}@x.fr`,
  role,
  status: 'active',
  ...over,
});

const profile = (uid: string, over: Partial<ProfileView> = {}): ProfileView => ({
  uid,
  primaryTeamId: 't1',
  teamIds: ['t1'],
  scope: { productCodes: ['pac'], zones: ['idf'] },
  capacity: { newLeadsCap: 10, override: null },
  operationalStatus: 'available',
  distributionSuspended: false,
  newLeads: 2,
  accessEndsAtMs: null,
  ...over,
});

const team = (id: string, memberIds: string[], over: Partial<TeamView> = {}): TeamView => ({
  id,
  name: `Équipe ${id}`,
  managerId: 'm1',
  secondaryManagerId: null,
  memberIds,
  active: true,
  ...over,
});

const online: PresenceView = { connected: true, lastSeenAtMs: NOW - 10_000 };

const users = [
  user('sarah', 'Télépro commercial'),
  user('mehdi', 'telepro'),
  user('laura', 'Telepro-commercial'),
  user('marc', 'Manager'),
  user('raph', 'Administrateur'),
  user('tech', 'technicien'),
  user('compta', 'commercial'),
];
const profiles = new Map([
  ['sarah', profile('sarah', { newLeads: 4 })],
  ['mehdi', profile('mehdi', { operationalStatus: 'on_call', newLeads: 8 })],
  ['laura', profile('laura', { distributionSuspended: true, operationalStatus: 'paused', newLeads: 6 })],
]);
const teams = [team('t1', ['sarah', 'mehdi', 'laura'])];
const presence = new Map<string, PresenceView>([
  ['sarah', online],
  ['mehdi', online],
  ['marc', online],
]);

const rows = () => buildUserRows(users, profiles, teams, presence, NOW);

describe('buildUserRows', () => {
  it('ne liste que les rôles qui ouvrent le module (technicien et « commercial » exclus, §2)', () => {
    expect(rows().map((r) => r.uid).sort()).toEqual(['laura', 'marc', 'mehdi', 'raph', 'sarah']);
  });

  it('trie par nom, sans tenir compte des accents ni de la casse', () => {
    const r = buildUserRows([user('b', 'manager', { name: 'Éric' }), user('a', 'manager', { name: 'Zoé' }), user('c', 'manager', { name: 'alice' })], new Map(), [], new Map(), NOW);
    expect(r.map((x) => x.name)).toEqual(['alice', 'Éric', 'Zoé']);
  });

  it('un télépro rattaché à une équipe affiche son équipe, son périmètre, sa charge et son plafond', () => {
    const s = rows().find((r) => r.uid === 'sarah')!;
    expect(s).toMatchObject({ teamNames: ['Équipe t1'], products: ['pac'], zones: ['idf'], newLeads: 4, cap: 10, distribution: 'active', connected: true });
  });

  it('distribution : suspendue, en pause, plafond atteint, sans profil', () => {
    const find = (uid: string, p: Map<string, ProfileView> = profiles) => buildUserRows(users, p, teams, presence, NOW).find((r) => r.uid === uid)!;
    expect(find('laura').distribution).toBe('suspended');
    expect(find('sarah', new Map([['sarah', profile('sarah', { operationalStatus: 'absent' })]])).distribution).toBe('paused');
    expect(find('sarah', new Map([['sarah', profile('sarah', { newLeads: 10 })]])).distribution).toBe('full');
    expect(find('sarah', new Map([['sarah', profile('sarah', { newLeads: 9 })]])).distribution).toBe('active');
    expect(find('sarah', new Map()).distribution).toBe('no_profile');
  });

  it('la suspension prime sur la pause et sur le plafond', () => {
    const p = new Map([['sarah', profile('sarah', { distributionSuspended: true, operationalStatus: 'paused', newLeads: 10 })]]);
    expect(buildUserRows(users, p, teams, presence, NOW).find((r) => r.uid === 'sarah')!.distribution).toBe('suspended');
  });

  it('une dérogation de capacité en cours relève le plafond affiché ; expirée, elle ne compte plus', () => {
    const live = { value: 15, fromMs: NOW - MIN, untilMs: NOW + MIN };
    const gone = { value: 15, fromMs: NOW - 10 * MIN, untilMs: NOW - MIN };
    const cap = (o: typeof live) => buildUserRows(users, new Map([['sarah', profile('sarah', { capacity: { newLeadsCap: 10, override: o }, newLeads: 12 })]]), teams, presence, NOW).find((r) => r.uid === 'sarah')!;
    expect(cap(live)).toMatchObject({ cap: 15, distribution: 'active' });
    expect(cap(gone)).toMatchObject({ cap: 10, distribution: 'full' });
  });

  it("plafond individuel absent (NaN) : la valeur par défaut s'applique, et son changement aussi", () => {
    const p = new Map([['sarah', profile('sarah', { capacity: { newLeadsCap: Number.NaN, override: null }, newLeads: 10 })]]);
    const at = (def: number) => buildUserRows(users, p, teams, presence, NOW, def).find((r) => r.uid === 'sarah')!;
    expect(at(10)).toMatchObject({ cap: 10, distribution: 'full' });
    expect(at(15)).toMatchObject({ cap: 15, distribution: 'active' });
  });

  it('managers et administrateurs : pas de capacité ni de distribution', () => {
    expect(rows().find((r) => r.uid === 'marc')).toMatchObject({ cap: null, newLeads: null, distribution: 'not_applicable' });
  });

  it('compte non actif : listé mais marqué inactif', () => {
    const r = buildUserRows([user('x', 'manager', { status: 'inactive' })], new Map(), [], new Map(), NOW);
    expect(r[0].accountActive).toBe(false);
  });

  it('un nom absent retombe sur l\'email', () => {
    const r = buildUserRows([user('x', 'manager', { name: '' })], new Map(), [], new Map(), NOW);
    expect(r[0].name).toBe('x@x.fr');
  });
});

describe('isConnected', () => {
  it('connecté si le dernier battement a moins de 2 minutes', () => {
    expect(isConnected({ connected: true, lastSeenAtMs: NOW - 119_000 }, NOW)).toBe(true);
    expect(isConnected({ connected: true, lastSeenAtMs: NOW - 121_000 }, NOW)).toBe(false);
  });
  it('déconnexion explicite, absence de présence ou de date : non connecté', () => {
    expect(isConnected({ connected: false, lastSeenAtMs: NOW }, NOW)).toBe(false);
    expect(isConnected(undefined, NOW)).toBe(false);
    expect(isConnected({ connected: true, lastSeenAtMs: null }, NOW)).toBe(false);
  });
});

describe('filterUserRows', () => {
  it('sans filtre : tout', () => expect(filterUserRows(rows(), NO_FILTERS)).toHaveLength(5));
  it('recherche : nom ou email, sans accents ni casse', () => {
    expect(filterUserRows(rows(), { ...NO_FILTERS, search: 'SARA' }).map((r) => r.uid)).toEqual(['sarah']);
    expect(filterUserRows(rows(), { ...NO_FILTERS, search: 'marc@x' }).map((r) => r.uid)).toEqual(['marc']);
  });
  it('rôle', () => expect(filterUserRows(rows(), { ...NO_FILTERS, role: 'manager' }).map((r) => r.uid)).toEqual(['marc']));
  it('équipe, et « sans équipe »', () => {
    expect(filterUserRows(rows(), { ...NO_FILTERS, teamId: 't1' })).toHaveLength(3);
    expect(filterUserRows(rows(), { ...NO_FILTERS, teamId: 'none' }).map((r) => r.uid).sort()).toEqual(['marc', 'raph']);
  });
  it('statut : un utilisateur non connecté n\'est jamais « disponible », même si son profil le dit', () => {
    expect(filterUserRows(rows(), { ...NO_FILTERS, status: 'available' }).map((r) => r.uid)).toEqual(['sarah']);
    expect(filterUserRows(rows(), { ...NO_FILTERS, status: 'offline' }).map((r) => r.uid).sort()).toEqual(['laura', 'raph']);
  });
  it('distribution', () => expect(filterUserRows(rows(), { ...NO_FILTERS, distribution: 'suspended' }).map((r) => r.uid)).toEqual(['laura']));
  it('filtres combinés', () => {
    expect(filterUserRows(rows(), { ...NO_FILTERS, role: 'telepro', status: 'on_call' }).map((r) => r.uid)).toEqual(['mehdi']);
  });
});

describe('computeKpis — mêmes lignes que le tableau', () => {
  it('compte les actifs, disponibles, en appel, absents et la capacité globale', () => {
    const k = computeKpis(rows());
    expect(k.activeUsers).toBe(5);
    expect(k.availableTelepros).toBe(1); // sarah : connectée, disponible, distribution active
    expect(k.onCall).toBe(1); // mehdi
    expect(k.absent).toBe(0);
    expect(k.capacityUsed).toBe(4 + 8 + 6);
    expect(k.capacityTotal).toBe(30);
  });
  it('un compte inactif n\'entre dans aucun total', () => {
    const p = new Map([['sarah', profile('sarah')]]);
    const k = computeKpis(buildUserRows([user('sarah', 'telepro', { status: 'disabled' })], p, teams, presence, NOW));
    expect(k).toMatchObject({ activeUsers: 0, availableTelepros: 0, capacityTotal: 0 });
  });
  it('liste vide : tout à zéro', () => {
    expect(computeKpis([])).toEqual({ activeUsers: 0, availableTelepros: 0, onCall: 0, absent: 0, capacityUsed: 0, capacityTotal: 0 });
  });
});

describe('summarizeTeams et alertes', () => {
  it('capacité de l\'équipe = somme des plafonds de ses membres actifs', () => {
    expect(summarizeTeams(teams, rows())).toEqual([{ id: 't1', name: 'Équipe t1', memberCount: 3, used: 18, total: 30, percent: 60 }]);
  });
  it('équipe vide : 0 %, jamais de division par zéro', () => {
    const s = summarizeTeams([team('vide', [])], rows());
    expect(s[0]).toMatchObject({ memberCount: 0, total: 0, percent: 0 });
  });
  it('équipe inactive : non listée', () => {
    expect(summarizeTeams([team('x', [], { active: false })], rows())).toEqual([]);
  });
  it('alerte « équipe sans membre »', () => {
    const a = computeAlerts([team('vide', [])], rows());
    expect(a.find((x) => x.kind === 'team_without_members')).toMatchObject({ count: 1, ids: ['vide'] });
  });
  it('alerte « capacité atteinte » et « sans profil »', () => {
    const p = new Map([['sarah', profile('sarah', { newLeads: 10 })]]);
    const r = buildUserRows(users, p, teams, presence, NOW);
    const a = computeAlerts(teams, r);
    expect(a.find((x) => x.kind === 'capacity_reached')?.ids).toEqual(['sarah']);
    expect(a.find((x) => x.kind === 'user_without_profile')?.ids.sort()).toEqual(['laura', 'mehdi']);
  });
  it('profil sans équipe : alerte « sans équipe »', () => {
    const p = new Map([['sarah', profile('sarah', { teamIds: [], primaryTeamId: null })]]);
    const r = buildUserRows([user('sarah', 'telepro')], p, [], presence, NOW);
    expect(computeAlerts([], r).find((x) => x.kind === 'user_without_team')?.ids).toEqual(['sarah']);
  });
  it('aucune anomalie : aucune alerte', () => {
    expect(computeAlerts(teams, rows())).toEqual([]);
  });
});
