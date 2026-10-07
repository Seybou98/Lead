import { describe, expect, it } from 'vitest';
import { toProfileInput } from './profileInput';

const toMs = (v: unknown) => (typeof v === 'number' ? v : null);

describe('toProfileInput', () => {
  it('document vide : valeurs sûres (aucun périmètre, plafond non défini, disponible)', () => {
    const p = toProfileInput('u1', {}, toMs);
    expect(p.scope).toEqual({ productCodes: [], zones: [] });
    expect(Number.isNaN(p.capacity.newLeadsCap)).toBe(true);
    expect(p.operationalStatus).toBe('available');
    expect(p.distributionSuspended).toBe(false);
    expect(p.schedule).toEqual({ timezone: 'Europe/Paris', weekly: [], breaks: [] });
  });
  it('ignore les valeurs de mauvais type au lieu de planter', () => {
    const p = toProfileInput('u1', { teamIds: 'x', scope: 'y', load: { newLeads: 'beaucoup' }, schedule: { weekly: 'lundi' } }, toMs);
    expect(p.teamIds).toEqual([]);
    expect(p.load.newLeads).toBe(0);
    expect(p.schedule.weekly).toEqual([]);
  });
  it('dérogation : ignorée si une de ses dates est illisible', () => {
    const base = { capacity: { newLeadsCap: 10 } };
    expect(toProfileInput('u', { capacity: { ...base.capacity, override: { value: 15, from: 1, until: 'bientôt' } } }, toMs).capacity.override).toBeNull();
    expect(toProfileInput('u', { capacity: { ...base.capacity, override: { value: 15, from: 1, until: 2 } } }, toMs).capacity.override).toEqual({ value: 15, fromMs: 1, untilMs: 2 });
  });
  it('relit tout ce qu\'un profil complet contient', () => {
    const p = toProfileInput(
      'u1',
      {
        primaryTeamId: 't1', teamIds: ['t1'], managerIds: ['m1'],
        scope: { productCodes: ['pac'], zones: ['idf'] },
        capacity: { newLeadsCap: 8 }, operationalStatus: 'on_call', distributionSuspended: true,
        accessEndsAt: 99, lastAssignedAt: 50, load: { newLeads: 3 },
      },
      toMs
    );
    expect(p).toMatchObject({ primaryTeamId: 't1', managerIds: ['m1'], operationalStatus: 'on_call', distributionSuspended: true, accessEndsAtMs: 99, lastAssignedAtMs: 50 });
    expect(p.capacity.newLeadsCap).toBe(8);
    expect(p.load.newLeads).toBe(3);
  });
});
