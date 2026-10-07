import { describe, expect, it } from 'vitest';
import { PRESENCE_TTL_MS, buildCandidates, type ProfileInput, type UserInput } from './candidates';
import { parseAssignmentConfig } from './configParse';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../engine/assignment';

// lundi 5 octobre 2026, 10:00 à Paris (UTC+2)
const NOW = Date.UTC(2026, 9, 5, 8, 0);
const weekdaySchedule = {
  timezone: 'Europe/Paris',
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '18:00' })),
};

const profile = (uid: string, over: Partial<ProfileInput> = {}): ProfileInput => ({
  uid,
  primaryTeamId: 'pac',
  teamIds: ['pac'],
  managerIds: ['m1'],
  scope: { productCodes: ['*'], zones: ['*'] },
  capacity: { newLeadsCap: 10, override: null },
  operationalStatus: 'available',
  distributionSuspended: false,
  accessEndsAtMs: null,
  lastAssignedAtMs: null,
  load: { newLeads: 0, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 },
  schedule: weekdaySchedule,
  ...over,
});
const user = (uid: string, over: Partial<UserInput> = {}): UserInput => ({
  uid,
  role: 'telepro commercial',
  status: 'active',
  name: uid,
  ...over,
});
const online = { connected: true, lastSeenAtMs: NOW - 10_000 };

const build = (over: Partial<Parameters<typeof buildCandidates>[0]> = {}) =>
  buildCandidates({
    profiles: [profile('u1')],
    users: { u1: user('u1') },
    presence: { u1: online },
    absences: [],
    nowMs: NOW,
    ...over,
  });

describe('buildCandidates', () => {
  it('un télépro actif, connecté et dans ses horaires devient candidat', () => {
    const { candidates, profileInfo } = build();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ uid: 'u1', accountActive: true, connected: true, withinSchedule: true, absent: false });
    expect(profileInfo.u1).toEqual({ managerIds: ['m1'], primaryTeamId: 'pac' });
  });

  it('seuls les télépros reçoivent des leads : manager, admin et autres rôles sont ignorés', () => {
    for (const role of ['manager', 'administrateur', 'technicien', 'commercial', null]) {
      expect(build({ users: { u1: user('u1', { role }) } }).candidates).toHaveLength(0);
    }
  });

  it('profil sans document utilisateur : ignoré', () => {
    expect(build({ users: {} }).candidates).toHaveLength(0);
  });

  it('compte non actif : candidat conservé (pour expliquer l\'exclusion) mais marqué inactif', () => {
    const { candidates } = build({ users: { u1: user('u1', { status: 'inactive' }) } });
    expect(candidates[0].accountActive).toBe(false);
  });

  it('statut « Active » en majuscule accepté, comme dans le login du CRM principal', () => {
    expect(build({ users: { u1: user('u1', { status: 'Active' }) } }).candidates[0].accountActive).toBe(true);
  });

  describe('présence', () => {
    it('battement trop ancien : déconnecté', () => {
      const stale = { connected: true, lastSeenAtMs: NOW - PRESENCE_TTL_MS - 1 };
      expect(build({ presence: { u1: stale } }).candidates[0].connected).toBe(false);
    });
    it('exactement à la limite : encore connecté', () => {
      const edge = { connected: true, lastSeenAtMs: NOW - PRESENCE_TTL_MS };
      expect(build({ presence: { u1: edge } }).candidates[0].connected).toBe(true);
    });
    it('déconnexion explicite, ou aucun document de présence : déconnecté', () => {
      expect(build({ presence: { u1: { connected: false, lastSeenAtMs: NOW } } }).candidates[0].connected).toBe(false);
      expect(build({ presence: {} }).candidates[0].connected).toBe(false);
    });
  });

  describe('absences', () => {
    it('absence en cours : absent', () => {
      const abs = [{ userId: 'u1', fromMs: NOW - 1000, toMs: NOW + 1000 }];
      expect(build({ absences: abs }).candidates[0].absent).toBe(true);
    });
    it('absence passée ou à venir, ou d\'un autre utilisateur : présent', () => {
      const abs = [
        { userId: 'u1', fromMs: NOW - 5000, toMs: NOW - 1000 },
        { userId: 'u1', fromMs: NOW + 1000, toMs: NOW + 5000 },
        { userId: 'autre', fromMs: NOW - 1000, toMs: NOW + 1000 },
      ];
      expect(build({ absences: abs }).candidates[0].absent).toBe(false);
    });
  });

  it('horaires : hors créneau, et jour fermé de l\'entreprise', () => {
    const night = Date.UTC(2026, 9, 5, 20, 0); // 22:00 à Paris
    expect(build({ nowMs: night, presence: { u1: { connected: true, lastSeenAtMs: night } } }).candidates[0].withinSchedule).toBe(false);
    expect(build({ closedDates: ['2026-10-05'] }).candidates[0].withinSchedule).toBe(false);
  });

  it('charge active = somme de toutes les familles ; nouveaux leads séparés', () => {
    const load = { newLeads: 3, callbacks: 2, interested: 4, documents: 1, filesToBuild: 1, recycling: 5 };
    const c = build({ profiles: [profile('u1', { load })] }).candidates[0];
    expect(c.newLeads).toBe(3);
    expect(c.activeLoad).toBe(16);
  });

  it('plusieurs télépros : l\'ordre des profils est conservé', () => {
    const { candidates } = build({
      profiles: [profile('a'), profile('b'), profile('c')],
      users: { a: user('a'), b: user('b'), c: user('c') },
      presence: { a: online, b: online, c: online },
    });
    expect(candidates.map((c) => c.uid)).toEqual(['a', 'b', 'c']);
  });
});

describe('parseAssignmentConfig', () => {
  it('sans couche : valeurs par défaut (plafond 10)', () => {
    expect(parseAssignmentConfig()).toEqual(DEFAULT_ASSIGNMENT_CONFIG);
    expect(parseAssignmentConfig(undefined, null, 'n\'importe quoi', 42).defaultNewLeadsCap).toBe(10);
  });

  it('applique le plafond, les critères et l\'ordre valides', () => {
    const c = parseAssignmentConfig({
      defaultNewLeadsCap: 8,
      criteria: { working_hours: false, zone: true },
      rankingOrder: ['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment'],
    });
    expect(c.defaultNewLeadsCap).toBe(8);
    expect(c.criteria).toEqual({ working_hours: false, zone: true });
    expect(c.rankingOrder[0]).toBe('fewest_new_leads');
  });

  it('la couche la plus spécifique (campagne) l\'emporte, sans effacer le reste', () => {
    const c = parseAssignmentConfig(
      { defaultNewLeadsCap: 12, criteria: { zone: false } },
      { defaultNewLeadsCap: 6 }
    );
    expect(c.defaultNewLeadsCap).toBe(6);
    expect(c.criteria.zone).toBe(false);
  });

  it('valeurs invalides ignorées : une config corrompue ne bloque jamais la distribution', () => {
    const c = parseAssignmentConfig({
      defaultNewLeadsCap: -3,
      criteria: { working_hours: 'non', inconnu: false },
      rankingOrder: ['nimporte', 5, null],
    });
    expect(c).toEqual(DEFAULT_ASSIGNMENT_CONFIG);
    expect(parseAssignmentConfig({ defaultNewLeadsCap: 1.5 }).defaultNewLeadsCap).toBe(10);
    expect(parseAssignmentConfig({ defaultNewLeadsCap: 5000 }).defaultNewLeadsCap).toBe(10);
  });

  it('ordre incomplet : les critères oubliés passent en dernier, le classement reste total', () => {
    const c = parseAssignmentConfig({ rankingOrder: ['oldest_last_assignment'] });
    expect(c.rankingOrder).toEqual(['oldest_last_assignment', 'lowest_active_load', 'fewest_new_leads']);
  });

  it('ordre avec doublons : dédoublonné', () => {
    const c = parseAssignmentConfig({ rankingOrder: ['fewest_new_leads', 'fewest_new_leads'] });
    expect(c.rankingOrder).toEqual(['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment']);
  });

  it('ne modifie pas la configuration par défaut partagée', () => {
    const before = JSON.stringify(DEFAULT_ASSIGNMENT_CONFIG);
    parseAssignmentConfig({ defaultNewLeadsCap: 3, criteria: { zone: false }, rankingOrder: ['fewest_new_leads'] });
    expect(JSON.stringify(DEFAULT_ASSIGNMENT_CONFIG)).toBe(before);
  });
});

describe('parseAssignmentConfig : distribution automatique', () => {
  it('activée par défaut ; la campagne peut la désactiver, une valeur invalide est ignorée', () => {
    expect(parseAssignmentConfig().autoDistribution).toBe(true);
    expect(parseAssignmentConfig({ autoDistribution: false }).autoDistribution).toBe(false);
    expect(parseAssignmentConfig({ autoDistribution: false }, { autoDistribution: true }).autoDistribution).toBe(true);
    expect(parseAssignmentConfig({ autoDistribution: 'non' }).autoDistribution).toBe(true);
  });
});
