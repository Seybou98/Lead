import { describe, expect, it } from 'vitest';
import {
  AdminRuleError,
  campaignDependencies,
  defaultProfile,
  optionalId,
  parseAssignmentConfigInput,
  planAssignmentConfig,
  planCampaignSave,
  planChecklistSave,
  planProfileUpdate,
  planSourceSave,
  planSpendSave,
  planTeamSave,
  teamDependencies,
  type OtherTeam,
  type UserSnapshot,
} from './plans';

const NOW = Date.UTC(2026, 9, 6, 10, 0);
const DAY = 86_400_000;

const user = (role: string, status = 'active'): UserSnapshot => ({ exists: true, role, status });
const refusal = (fn: () => unknown): AdminRuleError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AdminRuleError) return e;
    throw e;
  }
  throw new Error('un refus était attendu');
};

describe('optionalId', () => {
  it('absent : null ; simple : accepté', () => {
    expect(optionalId(undefined)).toBeNull();
    expect(optionalId('')).toBeNull();
    expect(optionalId('abc_12-X')).toBe('abc_12-X');
  });
  it('refuse un chemin ou un caractère spécial (pas d\'écriture ailleurs dans la base)', () => {
    for (const bad of ['a/b', '../x', 'a b', 'é', 'x'.repeat(61), 12, {}]) expect(refusal(() => optionalId(bad)).code).toBe('invalid-argument');
  });
});

describe('planTeamSave', () => {
  const baseInput = { name: 'Équipe PAC', managerId: 'mgr', memberIds: ['sarah', 'mehdi'] };
  const users = new Map<string, UserSnapshot>([
    ['mgr', user('Manager')],
    ['boss', user('Administrateur')],
    ['sarah', user('telepro commercial')],
    ['mehdi', user('telepro commercial')],
    ['tech', user('technicien')],
    ['off', user('telepro commercial', 'inactive')],
  ]);
  const profiles = new Map<string, { exists: boolean; primaryTeamId: string | null }>([['sarah', { exists: true, primaryTeamId: null }]]);
  const plan = (over: Partial<Parameters<typeof planTeamSave>[0]> = {}) =>
    planTeamSave({ input: baseInput, teamId: 't1', before: null, otherTeams: [], users, profiles, nowMs: NOW, ...over });

  it('création : équipe, audit et profils des membres (existant mis à jour, absent créé)', () => {
    const p = plan();
    expect(p.team).toMatchObject({ id: 't1', name: 'Équipe PAC', managerId: 'mgr', memberIds: ['sarah', 'mehdi'], active: true });
    expect(p.audit).toMatchObject({ action: 'team.create', entityType: 'team', entityId: 't1', before: null });
    const sarah = p.profileWrites.find((w) => w.uid === 'sarah')!;
    const mehdi = p.profileWrites.find((w) => w.uid === 'mehdi')!;
    expect(sarah).toMatchObject({ mode: 'update', data: { teamIds: ['t1'], managerIds: ['mgr'], primaryTeamId: 't1' } });
    expect(mehdi.mode).toBe('create');
    // Un profil créé n'a AUCUN périmètre : le nouveau télépro ne reçoit rien tant qu'on ne l'a pas configuré.
    expect(mehdi.data).toMatchObject({ scope: { productCodes: [], zones: [] }, teamIds: ['t1'], managerIds: ['mgr'] });
  });

  it('modification : conserve la date de création et journalise l\'avant', () => {
    const before = { createdAt: new Date(NOW - DAY), memberIds: ['sarah'] };
    const p = plan({ before });
    expect(p.team.createdAt).toEqual(new Date(NOW - DAY));
    expect(p.audit).toMatchObject({ action: 'team.update', before });
  });

  it('un membre retiré est recalculé : il perd cette équipe et ce manager', () => {
    const p = plan({ input: { ...baseInput, memberIds: ['mehdi'] }, before: { memberIds: ['sarah', 'mehdi'] }, profiles: new Map([['sarah', { exists: true, primaryTeamId: 't1' }], ['mehdi', { exists: true, primaryTeamId: 't1' }]]) });
    expect(p.profileWrites.find((w) => w.uid === 'sarah')).toMatchObject({ mode: 'update', data: { teamIds: [], managerIds: [], primaryTeamId: null } });
    expect(p.profileWrites.find((w) => w.uid === 'mehdi')?.data).toMatchObject({ teamIds: ['t1'] });
  });

  it('un membre déjà dans une autre équipe garde les deux, avec les managers des deux', () => {
    const other: OtherTeam = { id: 't0', managerId: 'boss', secondaryManagerId: null, memberIds: ['sarah'], active: true, fallbackTeamId: null };
    const p = plan({ otherTeams: [other], profiles: new Map([['sarah', { exists: true, primaryTeamId: 't0' }]]) });
    expect(p.profileWrites.find((w) => w.uid === 'sarah')?.data).toMatchObject({ teamIds: ['t0', 't1'], managerIds: ['boss', 'mgr'], primaryTeamId: 't0' });
  });

  it('équipe désactivée : ses membres perdent le manager', () => {
    const p = plan({ input: { ...baseInput, active: false } });
    expect(p.profileWrites.every((w) => (w.data.managerIds as string[]).length === 0)).toBe(true);
  });

  describe('refus', () => {
    it('manager qui n\'en est pas un (télépro, technicien), inactif ou inconnu', () => {
      for (const managerId of ['sarah', 'tech', 'inconnu']) {
        expect(refusal(() => plan({ input: { ...baseInput, managerId } })).code).toBe('failed-precondition');
      }
      expect(refusal(() => plan({ users: new Map([...users, ['mgr', user('Manager', 'inactive')]]) })).message).toMatch(/manager/);
    });
    it('un administrateur peut être manager', () => {
      expect(() => plan({ input: { ...baseInput, managerId: 'boss' } })).not.toThrow();
    });
    it('membre qui n\'est pas télépro, inactif ou inconnu', () => {
      for (const memberIds of [['tech'], ['mgr'], ['off'], ['inconnu']]) {
        expect(refusal(() => plan({ input: { ...baseInput, memberIds } })).message).toMatch(/télépro-commercial actif/);
      }
    });
    it('équipe de secours inexistante', () => {
      expect(refusal(() => plan({ input: { ...baseInput, fallbackTeamId: 'nope' } })).message).toMatch(/introuvable/);
    });
    it('boucle d\'équipes de secours (A → B → A)', () => {
      const b: OtherTeam = { id: 'tb', managerId: 'mgr', secondaryManagerId: null, memberIds: [], active: true, fallbackTeamId: 't1' };
      expect(refusal(() => plan({ input: { ...baseInput, fallbackTeamId: 'tb' }, otherTeams: [b] })).message).toMatch(/boucle/);
    });
    it('validation : nom manquant', () => {
      expect(refusal(() => plan({ input: { managerId: 'mgr' } })).code).toBe('invalid-argument');
    });
    it('entrée qui n\'est pas un objet', () => {
      expect(refusal(() => plan({ input: 'x' })).code).toBe('invalid-argument');
    });
  });

  it('teamDependencies : tout ce qu\'il faut lire avant de planifier (anciens ET nouveaux membres)', () => {
    const d = teamDependencies({ managerId: 'mgr', secondaryManagerId: 'boss', memberIds: ['b', 'c', 'c'] }, { memberIds: ['a', 'b'] });
    expect(d.userIds.sort()).toEqual(['a', 'b', 'boss', 'c', 'mgr']);
    expect(d.profileUids.sort()).toEqual(['a', 'b', 'c']);
    expect(teamDependencies(null, null)).toEqual({ userIds: [], profileUids: [] });
  });
});

describe('planProfileUpdate', () => {
  const run = (input: unknown, over: Partial<Parameters<typeof planProfileUpdate>[0]> = {}) =>
    planProfileUpdate({ uid: 'sarah', input, user: user('telepro commercial'), before: null, actorId: 'admin1', nowMs: NOW, ...over });

  it('un profil absent est créé avec les valeurs sûres, puis modifié', () => {
    const p = run({ uid: 'sarah', newLeadsCap: 12, distributionSuspended: true });
    expect(p.next).toMatchObject({ uid: 'sarah', distributionSuspended: true, capacity: { newLeadsCap: 12, override: null }, scope: { productCodes: [], zones: [] } });
    expect(p.audit).toMatchObject({ action: 'profile.update', entityId: 'sarah', before: null });
  });
  it('ne touche qu\'aux champs demandés : les compteurs de charge sont conservés', () => {
    const before = { ...defaultProfile('sarah', new Date(NOW)), load: { newLeads: 7, callbacks: 1, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } };
    const p = run({ uid: 'sarah', distributionSuspended: true }, { before });
    expect((p.next.load as { newLeads: number }).newLeads).toBe(7);
  });
  it('dérogation : enregistre qui l\'a accordée ; null la retire', () => {
    const o = run({ uid: 'sarah', capacityOverride: { value: 15, fromMs: NOW, untilMs: NOW + DAY, reason: 'Pic' } });
    expect((o.next.capacity as { override: { grantedBy: string } }).override.grantedBy).toBe('admin1');
    const removed = run({ uid: 'sarah', capacityOverride: null }, { before: o.next });
    expect((removed.next.capacity as { override: unknown }).override).toBeNull();
  });
  it('le plafond null revient à la valeur par défaut', () => {
    const p = run({ uid: 'sarah', newLeadsCap: null }, { before: { ...defaultProfile('sarah', new Date(NOW)), capacity: { newLeadsCap: 12, override: null } } });
    expect((p.next.capacity as { newLeadsCap: unknown }).newLeadsCap).toBeNull();
  });
  it('fin d\'accès programmée', () => {
    expect(run({ uid: 'sarah', accessEndsAtMs: NOW + DAY }).next.accessEndsAt).toEqual(new Date(NOW + DAY));
  });
  it('refuse un manager, un compte inconnu, un technicien : seuls les télépros ont un profil', () => {
    expect(refusal(() => run({ uid: 'x', newLeadsCap: 5 }, { user: user('Manager') })).code).toBe('failed-precondition');
    expect(refusal(() => run({ uid: 'x', newLeadsCap: 5 }, { user: { exists: false, role: null, status: null } })).code).toBe('failed-precondition');
    expect(refusal(() => run({ uid: 'x', newLeadsCap: 5 }, { user: user('technicien') })).code).toBe('failed-precondition');
  });
  it('refuse une dérogation sans date de fin', () => {
    expect(refusal(() => run({ uid: 'sarah', capacityOverride: { value: 15, fromMs: NOW, reason: 'x' } })).code).toBe('invalid-argument');
  });
});

describe('planSourceSave', () => {
  it('création puis modification : conserve la correspondance de champs et la date de création', () => {
    const created = planSourceSave({ input: { name: 'Meta', kind: 'meta' }, sourceId: 's1', before: null, nowMs: NOW });
    expect(created.doc).toMatchObject({ id: 's1', name: 'Meta', kind: 'meta', enabled: true, fieldMapping: {} });
    expect(created.audit.action).toBe('source.create');
    const before = { fieldMapping: { Prénom: 'firstName' }, createdAt: new Date(NOW - DAY) };
    const updated = planSourceSave({ input: { name: 'Meta 2', kind: 'meta', enabled: false }, sourceId: 's1', before, nowMs: NOW });
    expect(updated.doc).toMatchObject({ fieldMapping: { Prénom: 'firstName' }, createdAt: new Date(NOW - DAY), enabled: false });
    expect(updated.audit.action).toBe('source.update');
  });
  it('refuse un type inconnu', () => {
    expect(refusal(() => planSourceSave({ input: { name: 'X', kind: 'tiktok' }, sourceId: 's', before: null, nowMs: NOW })).code).toBe('invalid-argument');
  });
});

describe('planCampaignSave', () => {
  const context = {
    sources: [{ id: 'meta', enabled: true }],
    teams: [{ id: 't1', active: true, memberCount: 2 }],
    profileUsers: [{ uid: 'sarah', role: 'telepro commercial', status: 'active' }],
    externalIdTaken: false,
  };
  const draft = { name: 'PAC IDF', sourceId: 'meta' };
  const active = { ...draft, status: 'active', externalId: 'c-1', productCode: 'pac', zones: ['idf'], eligibleTeamIds: ['t1'] };
  const plan = (input: unknown, over: Partial<Parameters<typeof planCampaignSave>[0]> = {}) =>
    planCampaignSave({ input, campaignId: 'c1', before: null, context, nowMs: NOW, ...over });

  it('brouillon puis activation : l\'audit distingue le changement de statut', () => {
    expect(plan(draft).audit.action).toBe('campaign.create');
    expect(plan(active, { before: { status: 'draft' } }).audit.action).toBe('campaign.status.active');
    expect(plan({ ...active, name: 'Autre' }, { before: { status: 'active' } }).audit.action).toBe('campaign.update');
  });
  it('conserve les règles propres au moteur lors d\'une édition de formulaire', () => {
    const before = { assignmentConfig: { autoDistribution: false }, slaOverride: { x: 1 }, createdAt: new Date(NOW - DAY) };
    const p = plan(draft, { before });
    expect(p.doc).toMatchObject({ assignmentConfig: { autoDistribution: false }, slaOverride: { x: 1 }, createdAt: new Date(NOW - DAY) });
  });
  it('dates converties en Date, nulles conservées', () => {
    const p = plan({ ...draft, startsAtMs: NOW });
    expect(p.doc.startsAt).toEqual(new Date(NOW));
    expect(p.doc.endsAt).toBeNull();
  });
  it('activation refusée sans télépro éligible (un télépro inactif ne compte pas)', () => {
    const inactive = { ...context, profileUsers: [{ uid: 'sarah', role: 'telepro commercial', status: 'inactive' }] };
    expect(refusal(() => plan({ ...active, eligibleTeamIds: [], eligibleUserIds: ['sarah'] }, { context: inactive })).message).toMatch(/profil de distribution, ou son compte n.est pas actif/);
  });
  it('un télépro actif nommément éligible suffit', () => {
    expect(() => plan({ ...active, eligibleTeamIds: [], eligibleUserIds: ['sarah'] })).not.toThrow();
  });
  it('refuse un identifiant externe déjà pris', () => {
    expect(refusal(() => plan({ ...draft, externalId: 'c-1' }, { context: { ...context, externalIdTaken: true } })).message).toMatch(/déjà utilisé/);
  });
});

describe('parseAssignmentConfigInput / planAssignmentConfig', () => {
  it('config valide', () => {
    expect(parseAssignmentConfigInput({ autoDistribution: false, defaultNewLeadsCap: 8, criteria: { zone: false }, rankingOrder: ['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment'] })).toEqual({
      autoDistribution: false,
      defaultNewLeadsCap: 8,
      criteria: { zone: false },
      rankingOrder: ['fewest_new_leads', 'lowest_active_load', 'oldest_last_assignment'],
    });
  });
  it.each([
    [{}, /Aucune règle/],
    [{ defaultNewLeadsCap: 101 }, /Plafond/],
    [{ defaultNewLeadsCap: 2.5 }, /Plafond/],
    [{ autoDistribution: 'oui' }, /Distribution automatique/],
    [{ criteria: { inconnu: true } }, /inconnu/],
    [{ criteria: { zone: 'oui' } }, /vrai ou faux/],
    [{ rankingOrder: ['lowest_active_load'] }, /exactement une fois/],
    [{ rankingOrder: ['lowest_active_load', 'lowest_active_load', 'fewest_new_leads'] }, /exactement une fois/],
    [{ rankingOrder: ['a', 'b', 'c'] }, /exactement une fois/],
  ])('refuse %j', (input, message) => {
    expect(refusal(() => parseAssignmentConfigInput(input)).message).toMatch(message);
  });
  it('campagne absente : introuvable ; sinon audit avec l\'ancienne règle', () => {
    expect(refusal(() => planAssignmentConfig({ input: { config: { autoDistribution: true } }, campaignId: 'c', before: null })).code).toBe('not-found');
    const p = planAssignmentConfig({ input: { config: { autoDistribution: false }, reason: 'Test' }, campaignId: 'c', before: { assignmentConfig: { autoDistribution: true } } });
    expect(p.audit).toMatchObject({ action: 'campaign.assignmentConfig', before: { autoDistribution: true }, after: { autoDistribution: false }, reason: 'Test' });
  });
});

describe('planSpendSave', () => {
  const run = (input: unknown, over: Partial<Parameters<typeof planSpendSave>[0]> = {}) =>
    planSpendSave({ input, spendId: 'd1', isCorrectionRequest: false, before: null, campaignExists: true, actorId: 'admin1', nowMs: NOW, ...over });
  const ok = { campaignId: 'c1', amountCents: 125_000, dateMs: NOW - DAY, note: 'Meta' };

  it('première saisie : auteur et dates posés, audit « create »', () => {
    const p = run(ok);
    expect(p.doc).toMatchObject({ id: 'd1', campaignId: 'c1', amountCents: 125_000, kind: 'manual', createdBy: 'admin1', updatedBy: 'admin1' });
    expect(p.audit).toMatchObject({ action: 'adSpend.create', before: null });
  });
  it('correction : motif obligatoire, auteur d\'origine conservé, ancienne valeur dans l\'audit', () => {
    const before = { campaignId: 'c1', amountCents: 125_000, createdBy: 'autre', createdAt: new Date(NOW - 5 * DAY) };
    expect(refusal(() => run({ ...ok, amountCents: 100_000 }, { isCorrectionRequest: true, before })).message).toMatch(/motif/);
    const p = run({ ...ok, amountCents: 100_000, reason: 'Facture rectifiée' }, { isCorrectionRequest: true, before });
    expect(p.doc).toMatchObject({ amountCents: 100_000, createdBy: 'autre', updatedBy: 'admin1' });
    expect(p.audit).toMatchObject({ action: 'adSpend.correct', before, reason: 'Facture rectifiée' });
  });
  it('corriger à 0 est autorisé (annulation)', () => {
    expect(run({ ...ok, amountCents: 0, reason: 'Annulée' }, { isCorrectionRequest: true, before: { campaignId: 'c1', amountCents: 5 } }).doc.amountCents).toBe(0);
  });
  it('dépense introuvable ; changement de campagne refusé ; campagne inexistante refusée', () => {
    expect(refusal(() => run(ok, { isCorrectionRequest: true, before: null })).code).toBe('not-found');
    expect(refusal(() => run({ ...ok, campaignId: 'c2', reason: 'x' }, { isCorrectionRequest: true, before: { campaignId: 'c1' } })).message).toMatch(/changer de campagne/);
    expect(refusal(() => run(ok, { campaignExists: false })).message).toMatch(/introuvable/);
  });
});

describe('campaignDependencies : seulement ce que la campagne référence (lu dans la transaction)', () => {
  it('source, équipes éligibles et de secours (sans doublon), télépros nommés', () => {
    expect(campaignDependencies({ sourceId: ' meta ', eligibleTeamIds: ['t1', 't2', 't1'], fallbackTeamId: 't2', eligibleUserIds: ['u1', '', 'u1', 'u2'] })).toEqual({
      sourceId: 'meta',
      teamIds: ['t1', 't2'],
      userIds: ['u1', 'u2'],
    });
  });
  it('équipe de secours seule, ou rien du tout', () => {
    expect(campaignDependencies({ sourceId: 's', fallbackTeamId: 'tf' })).toEqual({ sourceId: 's', teamIds: ['tf'], userIds: [] });
    expect(campaignDependencies({})).toEqual({ sourceId: null, teamIds: [], userIds: [] });
    expect(campaignDependencies(null)).toEqual({ sourceId: null, teamIds: [], userIds: [] });
  });
});

describe('planChecklistSave', () => {
  const input = { productCode: 'PAC', items: [{ code: 'identity', label: "Pièce d'identité", mandatory: true }, { label: 'Attestation de ramonage', mandatory: false }] };
  it('une famille = un document ; une nouvelle pièce reçoit un code tiré de son nom, les existantes gardent le leur', () => {
    const p = planChecklistSave({ input, before: null, actorId: 'adm', nowMs: NOW });
    expect(p.key).toBe('pac');
    expect(p.doc).toMatchObject({ id: 'pac', productCode: 'PAC', updatedBy: 'adm', items: [{ code: 'identity', mandatory: true }, { code: 'attestation-de-ramonage', label: 'Attestation de ramonage', mandatory: false }] });
    expect(p.audit).toMatchObject({ action: 'checklist.create', entityType: 'checklist', entityId: 'pac', before: null });
  });
  it("la checklist « par défaut » n'a pas de famille", () => {
    const p = planChecklistSave({ input: { productCode: null, items: [{ label: 'RIB', mandatory: true }] }, before: null, actorId: 'adm', nowMs: NOW });
    expect(p).toMatchObject({ key: 'default', doc: { id: 'default', productCode: null } });
  });
  it('une modification garde la date de création et est tracée', () => {
    const before = { id: 'pac', createdAt: new Date(1), items: [] };
    const p = planChecklistSave({ input, before, actorId: 'adm', nowMs: NOW });
    expect(p.doc.createdAt).toEqual(new Date(1));
    expect(p.audit).toMatchObject({ action: 'checklist.update', before });
  });
  it('codes fournis invalides ou en double : remplacés, jamais acceptés tels quels', () => {
    const p = planChecklistSave({ input: { productCode: 'SSC', items: [{ code: '../x', label: 'A' }, { code: 'dup', label: 'B' }, { code: 'dup', label: 'C' }] }, before: null, actorId: 'adm', nowMs: NOW });
    const codes = (p.doc.items as { code: string }[]).map((i) => i.code);
    expect(new Set(codes).size).toBe(3);
    expect(codes.every((c) => /^[a-z0-9][a-z0-9_-]*$/.test(c))).toBe(true);
  });
  it('refus : liste vide, nom vide, doublon de nom, trop de pièces', () => {
    for (const items of [[], [{ label: ' ' }], [{ label: 'RIB' }, { label: 'rib' }], Array.from({ length: 21 }, (_, i) => ({ label: `P${i}` }))]) {
      expect(refusal(() => planChecklistSave({ input: { productCode: 'PAC', items }, before: null, actorId: 'adm', nowMs: NOW })).code).toBe('invalid-argument');
    }
  });
});
