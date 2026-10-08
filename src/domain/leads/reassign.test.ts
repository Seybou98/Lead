import { describe, expect, it } from 'vitest';
import { planReassign, type ReassignContext, type ReassignLead, type ReassignPlan, type ReassignTarget } from './reassign';

const lead: ReassignLead = { id: 'L1', fullName: 'Jean Dupont', status: 'callback', ownerId: 'u1', teamId: 't1', managerIds: ['m1'], nextActionId: 'act1', reassignCount: 0 };
const target: ReassignTarget = { uid: 'u2', name: 'Sarah Martin', accountActive: true, isTelepro: true, hasProfile: true, primaryTeamId: 't2', managerIds: ['m1', 'm2'] };

const ctx = (over: Partial<Omit<ReassignContext, 'lead' | 'target'>> & { lead?: Partial<ReassignLead>; target?: Partial<ReassignTarget> } = {}): ReassignContext => ({
  lead: { ...lead, ...over.lead },
  target: { ...target, ...over.target },
  actorId: over.actorId ?? 'm1',
  actorRole: over.actorRole ?? 'manager',
  reason: 'reason' in over ? over.reason : 'Propriétaire absent',
  nowMs: 1,
  requestId: 'req-00000001',
});
const ok = (c: ReassignContext): ReassignPlan => {
  const r = planReassign(c);
  if (!r.ok) throw new Error(r.message);
  return r.plan;
};
const refused = (c: ReassignContext) => {
  const r = planReassign(c);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r;
};

describe('planReassign', () => {
  it('change propriétaire, équipe et managers (union : le manager qui agit garde la vue), compte la réattribution', () => {
    const p = ok(ctx());
    expect(p).toMatchObject({ ownerId: 'u2', previousOwnerId: 'u1', teamId: 't2', reassignCount: 1, reason: 'Propriétaire absent', moveActionId: 'act1', createTakeAction: null });
    expect(p.managerIds.sort()).toEqual(['m1', 'm2']);
  });
  it('déplace la charge d\'un profil à l\'autre selon le statut du lead', () => {
    expect(ok(ctx()).loadFrom).toEqual({ callbacks: -1 });
    expect(ok(ctx()).loadTo).toEqual({ callbacks: 1 });
    const docs = ok(ctx({ lead: { status: 'awaiting_documents' } }));
    expect([docs.loadFrom, docs.loadTo]).toEqual([{ documents: -1 }, { documents: 1 }]);
  });
  it('statut sans compteur (montage) : aucune charge déplacée', () => {
    const p = ok(ctx({ lead: { status: 'file_building' } }));
    expect([p.loadFrom, p.loadTo]).toEqual([{}, {}]);
  });
  it('sortie de la file tampon : action « prendre en charge » créée, charge ajoutée au seul nouveau propriétaire', () => {
    const p = ok(ctx({ lead: { status: 'new', ownerId: null, nextActionId: null } }));
    expect(p.createTakeAction).toEqual({ id: 'L1_take_new_lead_req-00000001' });
    expect(p.loadFrom).toEqual({});
    expect(p.loadTo).toEqual({ newLeads: 1 });
    expect(p.notifications).toHaveLength(1);
    expect(p.notifications[0]).toMatchObject({ recipientId: 'u2', sound: 'new_lead' });
    expect(p.message).toMatch(/attribué/);
  });
  it('réattribution d\'un lead en cours : les deux télépros sont prévenus, sans sonnerie', () => {
    const p = ok(ctx());
    expect(p.notifications.map((n) => [n.recipientId, n.sound])).toEqual([['u2', null], ['u1', null]]);
  });
  it('motif obligatoire', () => {
    for (const reason of [undefined, '', '  ', 'ab', 42]) expect(refused(ctx({ reason })).code).toBe('invalid');
  });
  it('motif tronqué à 500 caractères', () => expect(ok(ctx({ reason: 'x'.repeat(900) })).reason).toHaveLength(500));
  it('cible : télépro actif avec profil, différent du propriétaire', () => {
    expect(refused(ctx({ target: { isTelepro: false } })).code).toBe('invalid');
    expect(refused(ctx({ target: { accountActive: false } })).code).toBe('invalid');
    expect(refused(ctx({ target: { hasProfile: false } })).code).toBe('invalid');
    expect(refused(ctx({ target: { uid: 'u1' } })).message).toMatch(/déjà propriétaire/);
  });
  it('droits : manager du lead ou admin ; autre manager refusé ; un manager reste dans son périmètre', () => {
    expect(refused(ctx({ actorId: 'm9' })).code).toBe('forbidden');
    expect(refused(ctx({ actorRole: 'telepro', actorId: 'u1' })).code).toBe('forbidden');
    expect(ok(ctx({ actorRole: 'admin', actorId: 'root', target: { managerIds: [] } })).ownerId).toBe('u2');
    expect(refused(ctx({ target: { managerIds: ['m2'] } })).code).toBe('forbidden');
  });
  it('lead clôturé ou en transmission : refusé', () => {
    for (const status of ['converted', 'not_interested', 'fake_lead', 'transmitting'] as const) expect(refused(ctx({ lead: { status } })).code).toBe('lead_closed');
  });
});
