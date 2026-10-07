import { describe, expect, it } from 'vitest';
import {
  affectedUserIds,
  deriveMembership,
  fallbackCreatesLoop,
  validateCampaign,
  validateProfilePatch,
  validateSource,
  validateSpend,
  validateTeam,
  type CampaignContext,
  type TeamMembership,
} from './validate';

const errorsOf = (r: { ok: boolean; errors?: string[] }) => (r.ok ? [] : (r.errors ?? []));
const NOW = Date.UTC(2026, 9, 6, 10, 0);
const DAY = 24 * 3600 * 1000;

describe('validateTeam', () => {
  const base = { name: 'Équipe PAC', managerId: 'm1', memberIds: ['a', 'b'] };

  it('accepte une équipe minimale et nettoie les listes', () => {
    const r = validateTeam({ ...base, memberIds: [' a ', 'a', '', 'b'], zones: ['idf', 'idf'] }, null);
    expect(r.ok && r.value.memberIds).toEqual(['a', 'b']);
    expect(r.ok && r.value.zones).toEqual(['idf']);
    expect(r.ok && r.value.active).toBe(true);
  });
  it('exige un nom et un manager, et les signale ensemble', () => {
    expect(errorsOf(validateTeam({}, null))).toHaveLength(2);
  });
  it('manager secondaire différent du principal', () => {
    expect(errorsOf(validateTeam({ ...base, secondaryManagerId: 'm1' }, null))[0]).toMatch(/différent/);
  });
  it('une équipe ne peut pas être son propre secours', () => {
    expect(errorsOf(validateTeam({ ...base, fallbackTeamId: 't1' }, 't1'))[0]).toMatch(/propre/);
  });
  it('équipe active sans membre : avertissement, pas un refus (§20.4 : anomalie remontée)', () => {
    const r = validateTeam({ ...base, memberIds: [] }, null);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings).toHaveLength(1);
  });
  it('refuse une entrée qui n\'est pas un objet', () => {
    expect(validateTeam(null, null).ok).toBe(false);
    expect(validateTeam('x', null).ok).toBe(false);
    expect(validateTeam([], null).ok).toBe(false);
  });
});

describe('fallbackCreatesLoop', () => {
  it('détecte A → B → A et A → B → C → B', () => {
    expect(fallbackCreatesLoop('A', new Map([['A', 'B'], ['B', 'A']]))).toBe(true);
    expect(fallbackCreatesLoop('A', new Map([['A', 'B'], ['B', 'C'], ['C', 'B']]))).toBe(true);
  });
  it('accepte une chaîne qui se termine', () => {
    expect(fallbackCreatesLoop('A', new Map([['A', 'B'], ['B', 'C'], ['C', null]]))).toBe(false);
    expect(fallbackCreatesLoop('A', new Map([['A', null]]))).toBe(false);
  });
});

describe('deriveMembership', () => {
  const teams: TeamMembership[] = [
    { id: 't1', managerId: 'm1', secondaryManagerId: 'm2', memberIds: ['u1', 'u2'], active: true },
    { id: 't2', managerId: 'm3', secondaryManagerId: null, memberIds: ['u1'], active: true },
    { id: 't3', managerId: 'm4', secondaryManagerId: null, memberIds: ['u1'], active: false },
  ];
  it('réunit les managers de toutes les équipes actives, sans doublon', () => {
    const r = deriveMembership('u1', teams, null);
    expect(r.teamIds).toEqual(['t1', 't2']);
    expect(r.managerIds).toEqual(['m1', 'm2', 'm3']);
  });
  it('une équipe inactive ne donne pas de manager', () => {
    expect(deriveMembership('u1', teams, null).managerIds).not.toContain('m4');
  });
  it('conserve l\'équipe principale si elle existe encore, sinon prend la première', () => {
    expect(deriveMembership('u1', teams, 't2').primaryTeamId).toBe('t2');
    expect(deriveMembership('u1', teams, 't3').primaryTeamId).toBe('t1');
    expect(deriveMembership('u1', teams, null).primaryTeamId).toBe('t1');
  });
  it('un utilisateur sans équipe n\'a ni manager ni équipe principale', () => {
    expect(deriveMembership('zz', teams, 't1')).toEqual({ teamIds: [], managerIds: [], primaryTeamId: null });
  });
  it('affectedUserIds : anciens ET nouveaux membres (celui qui sort doit être recalculé)', () => {
    expect(affectedUserIds({ memberIds: ['a', 'b'] }, { memberIds: ['b', 'c'] }).sort()).toEqual(['a', 'b', 'c']);
    expect(affectedUserIds(null, { memberIds: ['a'] })).toEqual(['a']);
  });
});

describe('validateProfilePatch', () => {
  it('refuse une demande vide', () => {
    expect(errorsOf(validateProfilePatch({}, NOW))[0]).toMatch(/Aucune/);
  });
  it('plafond : entier entre 0 et 100, ou null pour revenir à la valeur par défaut', () => {
    expect(validateProfilePatch({ newLeadsCap: 10 }, NOW).ok).toBe(true);
    for (const bad of [-1, 101, 2.5, '10']) expect(validateProfilePatch({ newLeadsCap: bad }, NOW).ok).toBe(false);
    const reset = validateProfilePatch({ newLeadsCap: null }, NOW);
    expect(reset.ok && reset.value.newLeadsCap).toBeNull();
  });

  describe('dérogation de capacité (§20.7)', () => {
    const ok = { value: 15, fromMs: NOW, untilMs: NOW + 2 * DAY, reason: 'Pic de campagne' };
    it('valide : valeur, période, motif', () => {
      expect(validateProfilePatch({ capacityOverride: ok }, NOW).ok).toBe(true);
    });
    it('sans date de fin : refusée', () => {
      expect(errorsOf(validateProfilePatch({ capacityOverride: { ...ok, untilMs: undefined } }, NOW))[0]).toMatch(/date de fin/);
    });
    it('sans motif : refusée', () => {
      expect(errorsOf(validateProfilePatch({ capacityOverride: { ...ok, reason: '  ' } }, NOW))[0]).toMatch(/motif/);
    });
    it('fin avant début, ou déjà passée : refusée', () => {
      expect(validateProfilePatch({ capacityOverride: { ...ok, untilMs: NOW - 1 } }, NOW).ok).toBe(false);
      expect(validateProfilePatch({ capacityOverride: { ...ok, fromMs: NOW - 5 * DAY, untilMs: NOW - DAY } }, NOW).ok).toBe(false);
    });
    it('null retire la dérogation', () => {
      const r = validateProfilePatch({ capacityOverride: null }, NOW);
      expect(r.ok && r.value.capacityOverride).toBeNull();
    });
  });

  describe('horaires', () => {
    it('valide', () => {
      const r = validateProfilePatch({ schedule: { timezone: 'Europe/Paris', weekly: [{ day: 1, start: '09:00', end: '18:00' }] } }, NOW);
      expect(r.ok).toBe(true);
    });
    it('fuseau inconnu, jour hors plage, heure mal formée, fin avant début', () => {
      const bad = (s: unknown) => validateProfilePatch({ schedule: s }, NOW).ok;
      expect(bad({ timezone: 'Mars/Olympus', weekly: [] })).toBe(false);
      expect(bad({ weekly: [{ day: 7, start: '09:00', end: '18:00' }] })).toBe(false);
      expect(bad({ weekly: [{ day: 1, start: '9h', end: '18:00' }] })).toBe(false);
      expect(bad({ weekly: [{ day: 1, start: '18:00', end: '09:00' }] })).toBe(false);
      expect(bad({ weekly: [{ day: 1, start: '24:00', end: '25:00' }] })).toBe(false);
    });
    it('sans plage : accepté mais signalé (toujours hors horaires)', () => {
      const r = validateProfilePatch({ schedule: { weekly: [] } }, NOW);
      expect(r.ok && r.warnings[0]).toMatch(/hors horaires/);
    });
  });

  it('périmètre vide : avertissement explicite', () => {
    const r = validateProfilePatch({ scope: { productCodes: [], zones: ['*'] } }, NOW);
    expect(r.ok && r.warnings[0]).toMatch(/aucun lead/);
  });
  it('distribution suspendue : booléen strict', () => {
    expect(validateProfilePatch({ distributionSuspended: true }, NOW).ok).toBe(true);
    expect(validateProfilePatch({ distributionSuspended: 'oui' }, NOW).ok).toBe(false);
  });
  it('fin d\'accès : nombre ou null', () => {
    expect(validateProfilePatch({ accessEndsAtMs: NOW + DAY }, NOW).ok).toBe(true);
    expect(validateProfilePatch({ accessEndsAtMs: null }, NOW).ok).toBe(true);
    expect(validateProfilePatch({ accessEndsAtMs: 'demain' }, NOW).ok).toBe(false);
  });
});

describe('validateSource', () => {
  it('valide', () => expect(validateSource({ name: 'Meta', kind: 'meta' }).ok).toBe(true));
  it('type inconnu ou nom absent', () => {
    expect(errorsOf(validateSource({ name: 'X', kind: 'tiktok' }))).toHaveLength(1);
    expect(errorsOf(validateSource({}))).toHaveLength(2);
  });
});

describe('validateCampaign', () => {
  const ctx = (over: Partial<CampaignContext> = {}): CampaignContext => ({
    sources: new Map([['meta', { enabled: true }]]),
    teams: new Map([
      ['t1', { active: true, memberCount: 3 }],
      ['empty', { active: true, memberCount: 0 }],
      ['off', { active: false, memberCount: 3 }],
    ]),
    eligibleUsers: new Set(['u1']),
    externalIdTaken: false,
    ...over,
  });
  const draft = { name: 'PAC IDF', sourceId: 'meta' };
  const complete = {
    ...draft,
    status: 'active',
    externalId: 'camp-1',
    productCode: 'pac_air_eau',
    zones: ['idf'],
    eligibleTeamIds: ['t1'],
  };

  it('un brouillon n\'exige que le nom et la source', () => {
    const r = validateCampaign(draft, ctx());
    expect(r.ok && r.value.status).toBe('draft');
  });
  it('nom et source obligatoires, source existante', () => {
    expect(errorsOf(validateCampaign({}, ctx()))).toHaveLength(2);
    expect(errorsOf(validateCampaign({ name: 'X', sourceId: 'inconnue' }, ctx()))[0]).toMatch(/Source inconnue/);
  });

  describe('activation (§19.2, §19.7)', () => {
    it('campagne complète : activable', () => {
      expect(validateCampaign(complete, ctx()).ok).toBe(true);
    });
    it('chaque donnée manquante est signalée en une fois', () => {
      const r = validateCampaign({ ...draft, status: 'active' }, ctx());
      expect(errorsOf(r).length).toBeGreaterThanOrEqual(4);
    });
    it('aucun télépro ni équipe éligible : bloquée', () => {
      const r = validateCampaign({ ...complete, eligibleTeamIds: [] }, ctx());
      expect(errorsOf(r).join(' ')).toMatch(/aucun télépro/);
    });
    it('équipe vide ou inactive ne compte pas comme éligible', () => {
      expect(validateCampaign({ ...complete, eligibleTeamIds: ['empty'] }, ctx()).ok).toBe(false);
      expect(validateCampaign({ ...complete, eligibleTeamIds: ['off'] }, ctx()).ok).toBe(false);
    });
    it('une équipe de secours utilisable suffit à débloquer', () => {
      expect(validateCampaign({ ...complete, eligibleTeamIds: [], fallbackTeamId: 't1' }, ctx()).ok).toBe(true);
    });
    it('un télépro nommé suffit', () => {
      expect(validateCampaign({ ...complete, eligibleTeamIds: [], eligibleUserIds: ['u1'] }, ctx()).ok).toBe(true);
    });
    it('sans équipe de secours : activable mais avec avertissement', () => {
      const r = validateCampaign(complete, ctx());
      expect(r.ok && r.warnings[0]).toMatch(/file tampon/);
    });
    it('source désactivée : bloquée', () => {
      const c = ctx({ sources: new Map([['meta', { enabled: false }]]) });
      expect(errorsOf(validateCampaign(complete, c)).join(' ')).toMatch(/désactivée/);
    });
  });

  it('identifiant externe déjà pris : refusé', () => {
    expect(errorsOf(validateCampaign({ ...draft, externalId: 'camp-1' }, ctx({ externalIdTaken: true })))[0]).toMatch(/déjà utilisé/);
  });
  it('équipe ou utilisateur inconnu : refusé', () => {
    expect(validateCampaign({ ...draft, eligibleTeamIds: ['nope'] }, ctx()).ok).toBe(false);
    expect(validateCampaign({ ...draft, eligibleUserIds: ['nope'] }, ctx()).ok).toBe(false);
  });
  it('budget et dates', () => {
    expect(validateCampaign({ ...draft, budgetCents: -5 }, ctx()).ok).toBe(false);
    expect(validateCampaign({ ...draft, budgetCents: 12.5 }, ctx()).ok).toBe(false);
    expect(validateCampaign({ ...draft, budgetCents: 1_000_000 }, ctx()).ok).toBe(true);
    expect(validateCampaign({ ...draft, startsAtMs: 10, endsAtMs: 5 }, ctx()).ok).toBe(false);
  });
  describe("éligibilité automatique et horaires de réception (fig. 16)", () => {
    const base = { name: "X", sourceId: "meta", status: "active", externalId: "e", productCode: "pac", zones: ["idf"] };
    it("« tous les télépros autorisés » suffit à activer, sans équipe ni télépro nommé", () => {
      const r = validateCampaign({ ...base, autoEligible: true }, ctx());
      expect(r.ok && r.value.autoEligible).toBe(true);
    });
    it("sans cela, activation refusée si personne n'est éligible", () => {
      expect(validateCampaign(base, ctx()).ok).toBe(false);
    });
    it("valeur non booléenne refusée ; absente = faux", () => {
      expect(validateCampaign({ ...draft, autoEligible: "oui" }, ctx()).ok).toBe(false);
      const r = validateCampaign(draft, ctx());
      expect(r.ok && r.value.autoEligible).toBe(false);
    });
    it("horaires de réception valides", () => {
      const weekly = [{ day: 1, start: "08:00", end: "20:00" }];
      const r = validateCampaign({ ...draft, receptionSchedule: { timezone: "Europe/Paris", weekly } }, ctx());
      expect(r.ok && r.value.receptionSchedule).toEqual({ timezone: "Europe/Paris", weekly });
    });
    it("horaires absents, nuls ou sans plage : aucun horaire (null)", () => {
      for (const receptionSchedule of [undefined, null, { weekly: [] }]) {
        const r = validateCampaign({ ...draft, receptionSchedule }, ctx());
        expect(r.ok && r.value.receptionSchedule).toBeNull();
      }
    });
    it("horaires invalides : fin avant début, heure mal formée, fuseau inconnu", () => {
      const bad = (s: unknown) => validateCampaign({ ...draft, receptionSchedule: s }, ctx()).ok;
      expect(bad({ weekly: [{ day: 1, start: "20:00", end: "08:00" }] })).toBe(false);
      expect(bad({ weekly: [{ day: 1, start: "8h", end: "20:00" }] })).toBe(false);
      expect(bad({ timezone: "Mars/Olympus", weekly: [{ day: 1, start: "08:00", end: "20:00" }] })).toBe(false);
    });
  });

  it('statut inconnu : refusé', () => {
    expect(validateCampaign({ ...draft, status: 'archived' }, ctx()).ok).toBe(false);
  });
});

describe('validateSpend (§22.4)', () => {
  const NOW_ = Date.UTC(2026, 9, 6, 10, 0);
  const ctx = (over: Partial<Parameters<typeof validateSpend>[1]> = {}) => ({ campaignExists: true, isCorrection: false, nowMs: NOW_, ...over });
  const ok = { campaignId: 'c1', amountCents: 125_000, dateMs: NOW_ - 86_400_000, note: 'Meta, semaine 40' };

  it('saisie valide', () => {
    const r = validateSpend(ok, ctx());
    expect(r.ok && r.value).toMatchObject({ campaignId: 'c1', amountCents: 125_000, note: 'Meta, semaine 40' });
  });
  it('montant : entier positif en centimes, zéro autorisé (annulation d\'une dépense)', () => {
    expect(validateSpend({ ...ok, amountCents: 0 }, ctx()).ok).toBe(true);
    for (const bad of [-1, 12.5, '100', null, undefined]) expect(validateSpend({ ...ok, amountCents: bad }, ctx()).ok).toBe(false);
  });
  it('date obligatoire et pas dans le futur', () => {
    expect(validateSpend({ ...ok, dateMs: undefined }, ctx()).ok).toBe(false);
    expect(validateSpend({ ...ok, dateMs: NOW_ + 3 * 86_400_000 }, ctx()).ok).toBe(false);
    expect(validateSpend({ ...ok, dateMs: NOW_ + 3_600_000 }, ctx()).ok).toBe(true); // décalage de fuseau toléré
  });
  it('campagne obligatoire et existante', () => {
    expect(validateSpend({ ...ok, campaignId: '' }, ctx()).ok).toBe(false);
    expect(errorsOf(validateSpend(ok, ctx({ campaignExists: false })))[0]).toMatch(/introuvable/);
  });
  it('une correction exige un motif ; une première saisie non', () => {
    expect(validateSpend(ok, ctx()).ok).toBe(true);
    expect(errorsOf(validateSpend(ok, ctx({ isCorrection: true })))[0]).toMatch(/motif/);
    expect(validateSpend({ ...ok, reason: '  ' }, ctx({ isCorrection: true })).ok).toBe(false);
    expect(validateSpend({ ...ok, reason: 'Facture rectifiée' }, ctx({ isCorrection: true })).ok).toBe(true);
  });
  it('toutes les erreurs sont renvoyées ensemble', () => {
    expect(errorsOf(validateSpend({}, ctx())).length).toBeGreaterThanOrEqual(3);
  });
});
