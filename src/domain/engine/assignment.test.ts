import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSIGNMENT_CONFIG,
  decideAssignment,
  effectiveCap,
  stableHash,
  type AssignmentCampaign,
  type AssignmentLead,
  type Candidate,
} from './assignment';

const NOW = Date.UTC(2026, 9, 5, 8, 0); // lundi 5 octobre 2026, 10:00 à Paris

const lead: AssignmentLead = { id: 'LEAD-1', productCode: 'pac_air_eau', zone: 'idf', campaignId: 'camp1' };
const campaign: AssignmentCampaign = {
  id: 'camp1',
  eligibleUserIds: [],
  eligibleTeamIds: ['pac'],
  fallbackTeamId: null,
};

const cand = (over: Partial<Candidate> & { uid: string }): Candidate => ({
  name: over.uid,
  accountActive: true,
  accessEndsAtMs: null,
  connected: true,
  operationalStatus: 'available',
  distributionSuspended: false,
  absent: false,
  withinSchedule: true,
  teamIds: ['pac'],
  scope: { productCodes: ['pac_air_eau'], zones: ['idf'] },
  newLeads: 0,
  activeLoad: 0,
  capacity: { newLeadsCap: 10, override: null },
  lastAssignedAtMs: null,
  ...over,
});

const decide = (cs: Candidate[], l = lead, c: AssignmentCampaign | null = campaign) =>
  decideAssignment(l, c, cs, NOW);

describe("éligibilité automatique de la campagne (fig. 16)", () => {
  const outsider = () => cand({ uid: "outsider", teamIds: ["autre-equipe"], scope: { productCodes: ["*"], zones: ["*"] } });
  const camp = (autoEligible: boolean): AssignmentCampaign => ({ id: "c1", eligibleUserIds: [], eligibleTeamIds: ["pac"], fallbackTeamId: null, autoEligible });

  it("désactivée : un télépro hors de l'équipe de la campagne est exclu", () => {
    const r = decide([outsider()], lead, camp(false));
    expect(r.chosenUid).toBeNull();
    expect(r.evaluations[0].exclusions).toContain("team_not_allowed");
  });
  it("activée : aucune restriction d'équipe, le télépro autorisé pour le produit et la zone est retenu", () => {
    expect(decide([outsider()], lead, camp(true)).chosenUid).toBe("outsider");
  });
  it("activée : le produit et la zone restent contrôlés", () => {
    const r = decide([cand({ uid: "p", teamIds: [], scope: { productCodes: ["autre"], zones: ["*"] } })], lead, camp(true));
    expect(r.chosenUid).toBeNull();
    expect(r.evaluations[0].exclusions).toContain("product_not_allowed");
  });
  it("activée : un télépro en pause reste exclu", () => {
    const paused = cand({ uid: "x", operationalStatus: "paused", scope: { productCodes: ["*"], zones: ["*"] } });
    expect(decide([paused], lead, camp(true)).chosenUid).toBeNull();
  });
});

describe('éligibilité — chaque critère bloquant suffit à exclure (§19.3)', () => {
  it.each<[string, Partial<Candidate>, string]>([
    ['compte inactif', { accountActive: false }, 'account_inactive'],
    ['accès expiré', { accessEndsAtMs: NOW - 1 }, 'access_expired'],
    ['non connecté', { connected: false }, 'not_connected'],
    ['distribution suspendue', { distributionSuspended: true }, 'distribution_suspended'],
    ['en pause', { operationalStatus: 'paused' }, 'status_paused'],
    ['absent (statut)', { operationalStatus: 'absent' }, 'status_absent'],
    ['indisponible', { operationalStatus: 'unavailable' }, 'status_unavailable'],
    ['déconnecté (statut)', { operationalStatus: 'disconnected' }, 'status_disconnected'],
    ['en rendez-vous', { operationalStatus: 'in_meeting' }, 'status_in_meeting'],
    ['absence déclarée', { absent: true }, 'absent'],
    ['produit non autorisé', { scope: { productCodes: ['ssc'], zones: ['idf'] } }, 'product_not_allowed'],
    ['zone non autorisée', { scope: { productCodes: ['pac_air_eau'], zones: ['grand_est'] } }, 'zone_not_allowed'],
    ['autre équipe', { teamIds: ['documents'] }, 'team_not_allowed'],
    ['hors horaires', { withinSchedule: false }, 'outside_hours'],
    ['plafond atteint', { newLeads: 10 }, 'capacity_reached'],
  ])('%s → exclu (%s)', (_label, over, code) => {
    const d = decide([cand({ uid: 'u1', ...over })]);
    expect(d.chosenUid).toBeNull();
    expect(d.evaluations[0].eligible).toBe(false);
    expect(d.evaluations[0].exclusions).toContain(code);
  });

  it('un candidat sans aucun blocage est éligible', () => {
    const d = decide([cand({ uid: 'u1' })]);
    expect(d.chosenUid).toBe('u1');
    expect(d.evaluations[0]).toMatchObject({ eligible: true, exclusions: [] });
  });

  it('toutes les exclusions d\'un candidat sont listées, pas seulement la première', () => {
    const d = decide([cand({ uid: 'u1', connected: false, withinSchedule: false, newLeads: 10 })]);
    expect(d.evaluations[0].exclusions).toEqual(expect.arrayContaining(['not_connected', 'outside_hours', 'capacity_reached']));
  });
});

describe('plafond de 10 nouveaux leads (§4.2)', () => {
  it('à 9 le télépro est éligible, à 10 il sort du pool', () => {
    expect(decide([cand({ uid: 'u1', newLeads: 9 })]).chosenUid).toBe('u1');
    expect(decide([cand({ uid: 'u1', newLeads: 10 })]).chosenUid).toBeNull();
    expect(decide([cand({ uid: 'u1', newLeads: 11 })]).chosenUid).toBeNull();
  });

  it('seule la charge de leads Nouveaux compte pour le plafond, pas la charge totale', () => {
    expect(decide([cand({ uid: 'u1', newLeads: 2, activeLoad: 40 })]).chosenUid).toBe('u1');
  });

  it('dérogation temporaire : compte pendant sa période, puis retour automatique au plafond normal', () => {
    const override = { value: 15, fromMs: NOW - 1000, untilMs: NOW + 1000 };
    expect(effectiveCap({ newLeadsCap: 10, override }, NOW, 10)).toBe(15);
    expect(effectiveCap({ newLeadsCap: 10, override }, NOW + 2000, 10)).toBe(10); // expirée
    expect(effectiveCap({ newLeadsCap: 10, override }, NOW - 2000, 10)).toBe(10); // pas encore commencée
    expect(decide([cand({ uid: 'u1', newLeads: 12, capacity: { newLeadsCap: 10, override } })]).chosenUid).toBe('u1');
  });

  it('le plafond par défaut de la config s\'applique si le profil n\'en définit pas', () => {
    expect(effectiveCap({ newLeadsCap: Number.NaN, override: null }, NOW, 7)).toBe(7);
  });
});

describe('périmètre produit / zone', () => {
  it('« * » autorise toutes les valeurs', () => {
    const c = cand({ uid: 'u1', scope: { productCodes: ['*'], zones: ['*'] } });
    expect(decide([c], { ...lead, productCode: 'ssc', zone: 'bretagne' }).chosenUid).toBe('u1');
  });

  it('texte libre de la source vs codes du périmètre : casse, accents, ponctuation ignorés', () => {
    const c = cand({ uid: 'u1', scope: { productCodes: ['pac_air_eau'], zones: ['ile_de_france'] } });
    expect(decide([c], { ...lead, productCode: 'PAC Air/Eau', zone: 'Île-de-France' }).chosenUid).toBe('u1');
    expect(decide([c], { ...lead, productCode: 'pac air-eau ', zone: 'ILE DE FRANCE' }).chosenUid).toBe('u1');
  });

  it("une valeur proche mais différente n'est pas acceptée", () => {
    const c = cand({ uid: 'u1', scope: { productCodes: ['pac_air_eau'], zones: ['idf'] } });
    expect(decide([c], { ...lead, productCode: 'PAC Air/Air', zone: 'idf' }).chosenUid).toBeNull();
    expect(decide([c], { ...lead, productCode: '', zone: 'idf' }).chosenUid).toBeNull();
  });

  it('liste vide = aucun accès (jamais « tout »)', () => {
    expect(decide([cand({ uid: 'u1', scope: { productCodes: [], zones: ['idf'] } })]).chosenUid).toBeNull();
    expect(decide([cand({ uid: 'u1', scope: { productCodes: ['pac_air_eau'], zones: [] } })]).chosenUid).toBeNull();
  });

  it('lead sans produit ni zone : seul un périmètre « * » peut le recevoir', () => {
    const noInfo = { ...lead, productCode: null, zone: null };
    expect(decide([cand({ uid: 'u1' })], noInfo).chosenUid).toBeNull();
    expect(decide([cand({ uid: 'u2', scope: { productCodes: ['*'], zones: ['*'] } })], noInfo).chosenUid).toBe('u2');
  });
});

describe('équipe de la campagne', () => {
  it('éligible via la liste nominative de la campagne, même hors équipe', () => {
    const c = { ...campaign, eligibleTeamIds: [], eligibleUserIds: ['u9'] };
    expect(decide([cand({ uid: 'u9', teamIds: [] })], lead, c).chosenUid).toBe('u9');
  });

  it('campagne sans télépro ni équipe éligible : personne, file tampon', () => {
    const c = { ...campaign, eligibleTeamIds: [], eligibleUserIds: [] };
    const d = decide([cand({ uid: 'u1' })], lead, c);
    expect(d.chosenUid).toBeNull();
    expect(d.bufferReason).toBe('team_not_allowed');
  });

  it('sans campagne (saisie manuelle, import), le critère équipe ne s\'applique pas', () => {
    expect(decide([cand({ uid: 'u1', teamIds: [] })], lead, null).chosenUid).toBe('u1');
  });

  it('équipe de secours : utilisée seulement si personne n\'est éligible dans l\'équipe principale', () => {
    const c = { ...campaign, fallbackTeamId: 'secours' };
    const d = decide(
      [cand({ uid: 'principal', newLeads: 10 }), cand({ uid: 'renfort', teamIds: ['secours'] })],
      lead,
      c
    );
    expect(d.chosenUid).toBe('renfort');
    expect(d.stage).toBe('fallback');
    expect(d.ruleApplied.startsWith('fallback_team:')).toBe(true);
  });

  it('équipe de secours ignorée si l\'équipe principale a un candidat', () => {
    const c = { ...campaign, fallbackTeamId: 'secours' };
    const d = decide([cand({ uid: 'principal' }), cand({ uid: 'renfort', teamIds: ['secours'] })], lead, c);
    expect(d.chosenUid).toBe('principal');
    expect(d.stage).toBe('primary');
  });

  it('équipe de secours vide aussi : file tampon, motif du premier essai', () => {
    const c = { ...campaign, fallbackTeamId: 'secours' };
    const d = decide([cand({ uid: 'principal', newLeads: 10 })], lead, c);
    expect(d.chosenUid).toBeNull();
    expect(d.stage).toBeNull();
    expect(d.bufferReason).toBe('capacity_reached');
  });
});

describe('classement : charge active → nouveaux leads → ancienneté → départage stable', () => {
  it('la charge active la plus faible gagne (fig. 17 : Sarah 4/10 devant Mehdi 8/10)', () => {
    const d = decide([
      cand({ uid: 'mehdi', activeLoad: 8, newLeads: 8 }),
      cand({ uid: 'sarah', activeLoad: 4, newLeads: 4 }),
    ]);
    expect(d.chosenUid).toBe('sarah');
    expect(d.decidedBy).toBe('lowest_active_load');
    expect(d.ranking).toEqual(['sarah', 'mehdi']);
  });

  it('à charge égale, le moins de nouveaux leads gagne', () => {
    const d = decide([
      cand({ uid: 'a', activeLoad: 5, newLeads: 4 }),
      cand({ uid: 'b', activeLoad: 5, newLeads: 2 }),
    ]);
    expect(d.chosenUid).toBe('b');
    expect(d.decidedBy).toBe('fewest_new_leads');
  });

  it('à égalité, l\'attribution la plus ancienne gagne ; jamais attribué = le plus ancien', () => {
    const d = decide([
      cand({ uid: 'recent', lastAssignedAtMs: NOW - 1000 }),
      cand({ uid: 'ancien', lastAssignedAtMs: NOW - 99999 }),
      cand({ uid: 'jamais', lastAssignedAtMs: null }),
    ]);
    expect(d.ranking).toEqual(['jamais', 'ancien', 'recent']);
    expect(d.decidedBy).toBe('oldest_last_assignment');
  });

  it('égalité parfaite : départage par hash stable, identique à chaque exécution', () => {
    const cs = [cand({ uid: 'a' }), cand({ uid: 'b' }), cand({ uid: 'c' })];
    const first = decide(cs);
    expect(first.decidedBy).toBe('stable_hash');
    for (let i = 0; i < 20; i++) expect(decide(cs).chosenUid).toBe(first.chosenUid);
  });

  it('le départage ne dépend pas de l\'ordre des candidats en entrée', () => {
    const cs = [cand({ uid: 'a' }), cand({ uid: 'b' }), cand({ uid: 'c' }), cand({ uid: 'd' })];
    const expected = decide(cs).ranking;
    expect(decide([...cs].reverse()).ranking).toEqual(expected);
    expect(decide([cs[2], cs[0], cs[3], cs[1]]).ranking).toEqual(expected);
  });

  it('le départage varie selon le lead : pas toujours le même télépro à égalité', () => {
    const cs = [cand({ uid: 'a' }), cand({ uid: 'b' }), cand({ uid: 'c' }), cand({ uid: 'd' })];
    const winners = new Set<string | null>();
    for (let i = 0; i < 40; i++) winners.add(decide(cs, { ...lead, id: `LEAD-${i}` }).chosenUid);
    expect(winners.size).toBeGreaterThan(1);
  });

  it('un seul éligible : decidedBy = only_candidate', () => {
    const d = decide([cand({ uid: 'a' }), cand({ uid: 'b', newLeads: 10 })]);
    expect(d.chosenUid).toBe('a');
    expect(d.decidedBy).toBe('only_candidate');
  });

  it('l\'ordre des critères est configurable (fig. 17, glisser-déposer)', () => {
    const cs = [
      cand({ uid: 'a', activeLoad: 2, newLeads: 5 }),
      cand({ uid: 'b', activeLoad: 6, newLeads: 1 }),
    ];
    expect(decide(cs).chosenUid).toBe('a');
    const reordered = decideAssignment(lead, campaign, cs, NOW, {
      ...DEFAULT_ASSIGNMENT_CONFIG,
      rankingOrder: ['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment'],
    });
    expect(reordered.chosenUid).toBe('b');
  });
});

describe('simulation = attribution réelle (§19.7)', () => {
  it('mêmes données → décision strictement identique', () => {
    const cs = [
      cand({ uid: 'sarah', activeLoad: 4 }),
      cand({ uid: 'mehdi', activeLoad: 8 }),
      cand({ uid: 'laura', operationalStatus: 'in_meeting' }),
    ];
    expect(decide(cs)).toEqual(decide(cs));
  });

  it('ne modifie pas les candidats passés en entrée', () => {
    const cs = [cand({ uid: 'a', newLeads: 3 }), cand({ uid: 'b', newLeads: 1 })];
    const snapshot = JSON.parse(JSON.stringify(cs));
    decide(cs);
    expect(cs).toEqual(snapshot);
  });
});

describe('critères désactivables (fig. 17, cases à cocher)', () => {
  const off = (criteria: Record<string, boolean>) => ({ ...DEFAULT_ASSIGNMENT_CONFIG, criteria });

  it('« Exclure En rendez-vous » décoché : un télépro en rendez-vous redevient éligible', () => {
    const c = cand({ uid: 'u1', operationalStatus: 'in_meeting' });
    expect(decide([c]).chosenUid).toBeNull();
    expect(decideAssignment(lead, campaign, [c], NOW, off({ exclude_in_meeting: false })).chosenUid).toBe('u1');
  });

  it('« Horaires de travail » décoché', () => {
    const c = cand({ uid: 'u1', withinSchedule: false });
    expect(decideAssignment(lead, campaign, [c], NOW, off({ working_hours: false })).chosenUid).toBe('u1');
  });

  it('les blocages de sécurité ne sont pas désactivables : pause, absence, suspension', () => {
    const everythingOff = off({
      active_connected: false, product: false, zone: false, team: false,
      working_hours: false, capacity: false, exclude_in_meeting: false,
    });
    for (const over of [
      { operationalStatus: 'paused' as const },
      { operationalStatus: 'absent' as const },
      { distributionSuspended: true },
      { absent: true },
    ]) {
      expect(decideAssignment(lead, campaign, [cand({ uid: 'u1', ...over })], NOW, everythingOff).chosenUid).toBeNull();
    }
  });
});

describe('file tampon (§24.4)', () => {
  it('aucun candidat : motif no_candidate', () => {
    const d = decide([]);
    expect(d.chosenUid).toBeNull();
    expect(d.bufferReason).toBe('no_candidate');
  });

  it('le motif est l\'exclusion la plus fréquente', () => {
    const d = decide([
      cand({ uid: 'a', newLeads: 10 }),
      cand({ uid: 'b', newLeads: 10 }),
      cand({ uid: 'c', operationalStatus: 'paused' }),
    ]);
    expect(d.bufferReason).toBe('capacity_reached');
  });

  it('toutes les évaluations sont conservées pour le journal, avec les charges figées', () => {
    const d = decide([cand({ uid: 'a', newLeads: 10, activeLoad: 12 }), cand({ uid: 'b', operationalStatus: 'paused' })]);
    expect(d.evaluations).toHaveLength(2);
    expect(d.evaluations[0]).toMatchObject({ uid: 'a', newLeads: 10, activeLoad: 12, effectiveCap: 10 });
  });
});

describe('stableHash', () => {
  it('est déterministe et réparti', () => {
    expect(stableHash('x')).toBe(stableHash('x'));
    expect(stableHash('x')).not.toBe(stableHash('y'));
    expect(stableHash('')).toBe(0x811c9dc5);
  });
});
