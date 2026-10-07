import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../engine/assignment';
import { mapPayload } from '../ingest/mapPayload';
import { planIngestion, type CampaignInfo } from '../ingest/plan';
import { buildCandidates, type ProfileInput } from '../ingest/candidates';
import { simulateAssignment, SIMULATION_LEAD_ID, type SimulationInput } from './simulate';

// Lundi 5 octobre 2026, 10h00 à Paris (UTC+2).
const NOW = Date.UTC(2026, 9, 5, 8, 0);

const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '18:00' }));
const profile = (uid: string, over: Partial<ProfileInput> = {}): ProfileInput => ({
  uid,
  primaryTeamId: 't1',
  teamIds: ['t1'],
  managerIds: ['mgr'],
  scope: { productCodes: ['pac_air_eau'], zones: ['ile_de_france'] },
  capacity: { newLeadsCap: 10, override: null },
  operationalStatus: 'available',
  distributionSuspended: false,
  accessEndsAtMs: null,
  lastAssignedAtMs: null,
  load: { newLeads: 0, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 },
  schedule: { timezone: 'Europe/Paris', weekly: week, breaks: [] },
  ...over,
});
const withLoad = (n: number): ProfileInput['load'] => ({ newLeads: n, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 });

const users = Object.fromEntries(
  ['sarah', 'mehdi', 'laura'].map((u) => [u, { uid: u, role: 'telepro commercial', status: 'active', name: u[0].toUpperCase() + u.slice(1) }])
);
const online = { connected: true, lastSeenAtMs: NOW - 5000 };
const presence = { sarah: online, mehdi: online, laura: online };

const campaign: CampaignInfo = {
  id: 'c1',
  name: 'PAC IDF',
  status: 'active',
  productCode: 'pac_air_eau',
  eligibleUserIds: [],
  eligibleTeamIds: ['t1'],
  fallbackTeamId: null,
};

const base = (over: Partial<SimulationInput> = {}): SimulationInput => ({
  lead: { productCode: 'PAC Air/Eau', zone: 'Île-de-France' },
  campaign,
  profiles: [profile('sarah', { load: withLoad(4) }), profile('mehdi', { load: withLoad(8) }), profile('laura', { operationalStatus: 'in_meeting' })],
  users,
  presence,
  absences: [],
  nowMs: NOW,
  config: DEFAULT_ASSIGNMENT_CONFIG,
  ...over,
});

describe('simulateAssignment', () => {
  it('recommande le télépro à la charge la plus faible et exclut celui en rendez-vous (cas de la fig. 17)', () => {
    const r = simulateAssignment(base());
    expect(r.recommendedName).toBe('Sarah');
    expect(r.rows.map((x) => [x.name, x.eligible, x.recommended])).toEqual([
      ['Sarah', true, true],
      ['Mehdi', true, false],
      ['Laura', false, false],
    ]);
    expect(r.rows[2].exclusions).toEqual(['status_in_meeting']);
    expect(r.rows[0]).toMatchObject({ newLeads: 4, cap: 10 });
  });

  it('personne d\'éligible : aucune recommandation, motif de file tampon', () => {
    const r = simulateAssignment(base({ presence: {} }));
    expect(r.recommendedUid).toBeNull();
    expect(r.decision.bufferReason).toBeDefined();
    expect(r.rows.every((x) => !x.eligible)).toBe(true);
  });

  it('un critère décoché dans le formulaire change la décision : Laura (en rendez-vous) devient éligible', () => {
    const r = simulateAssignment(base({ config: { ...DEFAULT_ASSIGNMENT_CONFIG, criteria: { exclude_in_meeting: false } } }));
    expect(r.rows.find((x) => x.name === 'Laura')?.eligible).toBe(true);
    // Laura a la charge la plus faible (0) : elle passe devant.
    expect(r.recommendedName).toBe('Laura');
  });

  it('l\'ordre de priorité du formulaire est appliqué', () => {
    const profiles = [
      profile('sarah', { load: { newLeads: 1, callbacks: 9, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } }),
      profile('mehdi', { load: withLoad(3) }),
    ];
    expect(simulateAssignment(base({ profiles })).recommendedName).toBe('Mehdi'); // charge active 3 < 10
    const byNew = simulateAssignment(base({ profiles, config: { ...DEFAULT_ASSIGNMENT_CONFIG, rankingOrder: ['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment'] } }));
    expect(byNew.recommendedName).toBe('Sarah'); // 1 nouveau lead < 3
  });

  it('le plafond du formulaire s\'applique : 10 leads Nouveaux = exclu, 9 = éligible', () => {
    const at = (n: number) => simulateAssignment(base({ profiles: [profile('sarah', { load: withLoad(n) })] })).recommendedUid;
    expect(at(9)).toBe('sarah');
    expect(at(10)).toBeNull();
  });

  it('un manager ou un administrateur avec un profil n\'est jamais proposé', () => {
    const r = simulateAssignment(base({ profiles: [profile('boss')], users: { boss: { uid: 'boss', role: 'Manager', status: 'active', name: 'Boss' } }, presence: { boss: online } }));
    expect(r.rows).toEqual([]);
  });

  it('équipe de secours utilisée quand l\'équipe de la campagne est indisponible', () => {
    const r = simulateAssignment(
      base({
        campaign: { ...campaign, fallbackTeamId: 'backup' },
        profiles: [profile('sarah', { operationalStatus: 'paused' }), profile('laura', { teamIds: ['backup'] })],
      })
    );
    expect(r.recommendedName).toBe('Laura');
    expect(r.decision.stage).toBe('fallback');
  });
});

describe('une simulation et une attribution réelle donnent la même décision (§19.7)', () => {
  // `assigned` : un télépro est-il attendu ? Évite qu'un scénario passe « pour rien » (null des deux côtés).
  const scenarios: Record<string, { over: Partial<SimulationInput>; assigned: boolean }> = {
    'cas nominal': { over: {}, assigned: true },
    'un télépro en pause': { over: { profiles: [profile('sarah', { operationalStatus: 'paused' }), profile('mehdi', { load: withLoad(2) })] }, assigned: true },
    'plafond atteint partout': { over: { profiles: [profile('sarah', { load: withLoad(10) }), profile('mehdi', { load: withLoad(12) })] }, assigned: false },
    'dérogation de capacité active': {
      over: { profiles: [profile('sarah', { load: withLoad(10), capacity: { newLeadsCap: 10, override: { value: 15, fromMs: NOW - 1000, untilMs: NOW + 1000 } } })] },
      assigned: true,
    },
    'égalité parfaite (départage stable)': { over: { profiles: [profile('sarah'), profile('mehdi'), profile('laura')] }, assigned: true },
    'personne de connecté': { over: { presence: {} }, assigned: false },
  };

  for (const [name, { over, assigned }] of Object.entries(scenarios)) {
    it(name, () => {
      const input = base(over);
      const leadId = 'lead-reel-1';

      const sim = simulateAssignment({ ...input, leadId });

      const { candidates, profileInfo } = buildCandidates({ profiles: input.profiles, users: input.users, presence: input.presence, absences: input.absences, nowMs: NOW });
      const plan = planIngestion({
        nowMs: NOW,
        leadId,
        rawLeadId: 'raw',
        sourceId: 'meta',
        channel: 'webhook',
        mapped: mapPayload({ fullName: 'Jean Dupont', phone: '0612345678', product: 'PAC Air/Eau', zone: 'Île-de-France' }),
        campaign,
        unresolvedCampaignRef: null,
        existing: [],
        candidates,
        profileInfo,
        campaignManagerIds: [],
        config: input.config,
      });
      if (plan.kind !== 'created') throw new Error('attendu : lead créé');

      expect(plan.lead.ownerId).toBe(sim.recommendedUid);
      expect(sim.recommendedUid !== null).toBe(assigned);
    });
  }

  it('la simulation utilise un identifiant par défaut stable', () => {
    expect(simulateAssignment(base()).recommendedUid).toBe(simulateAssignment(base()).recommendedUid);
    expect(SIMULATION_LEAD_ID).toBe('simulation');
  });
});
