import { describe, expect, it } from 'vitest';
import { applyOutsideHours } from './outsideHours';
import { DEFAULT_SLA_SETTINGS, type SlaSettings } from './settings';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../engine/assignment';
import type { CampaignInfo } from '../ingest/plan';

const OPEN = Date.parse('2026-10-07T09:00:00Z'); // mercredi 11:00 Paris
const CLOSED = Date.parse('2026-10-07T19:00:00Z'); // mercredi 21:00 Paris
const SUNDAY = Date.parse('2026-10-11T09:00:00Z');
const campaign: CampaignInfo = { id: 'c1', name: 'PAC', status: 'active', productCode: 'PAC', eligibleUserIds: ['u1'], eligibleTeamIds: ['t1'], fallbackTeamId: 't9', autoEligible: false };
const sla = (over: Partial<SlaSettings> = {}): SlaSettings => ({ ...DEFAULT_SLA_SETTINGS, ...over });
const run = (s: SlaSettings, nowMs: number, c: CampaignInfo | null = campaign) => applyOutsideHours({ config: DEFAULT_ASSIGNMENT_CONFIG, campaign: c, sla: s, nowMs });

describe('applyOutsideHours', () => {
  it('« mettre en attente » (défaut) ou entreprise ouverte : rien ne change', () => {
    expect(run(sla({ outsideHours: 'hold' }), CLOSED)).toEqual({ config: DEFAULT_ASSIGNMENT_CONFIG, campaign, applied: null });
    expect(run(sla({ outsideHours: 'immediate' }), OPEN).applied).toBeNull();
    expect(run(sla({ outsideHours: 'duty_team', fallbackTeamId: 't9' }), OPEN).campaign).toBe(campaign);
  });
  it('« attribuer immédiatement » hors horaires : les horaires des télépros ne bloquent plus', () => {
    const r = run(sla({ outsideHours: 'immediate' }), CLOSED);
    expect(r.applied).toBe('immediate');
    expect(r.config.criteria.working_hours).toBe(false);
    expect(r.campaign).toBe(campaign);
    expect(DEFAULT_ASSIGNMENT_CONFIG.criteria.working_hours).toBeUndefined(); // la configuration d'origine n'est pas modifiée
  });
  it('le week-end et les jours fermés comptent comme fermés', () => {
    expect(run(sla({ outsideHours: 'immediate' }), SUNDAY).applied).toBe('immediate');
    const closed = sla({ outsideHours: 'immediate', schedule: { ...DEFAULT_SLA_SETTINGS.schedule, closedDates: ['2026-10-07'] } });
    expect(run(closed, OPEN).applied).toBe('immediate');
  });
  it('« équipe de garde » : seule l\'équipe de secours est éligible, sans autre restriction d\'horaires', () => {
    const r = run(sla({ outsideHours: 'duty_team', fallbackTeamId: 't9' }), CLOSED);
    expect(r.applied).toBe('duty_team');
    expect(r.campaign).toMatchObject({ id: 'c1', eligibleUserIds: [], eligibleTeamIds: ['t9'], fallbackTeamId: null, autoEligible: false });
    expect(r.config.criteria.working_hours).toBe(false);
    expect(campaign.eligibleTeamIds).toEqual(['t1']); // la campagne d'origine n'est pas modifiée
  });
  it('équipe de garde sans équipe de secours, ou lead sans campagne : comportement d\'origine', () => {
    expect(run(sla({ outsideHours: 'duty_team', fallbackTeamId: null }), CLOSED).applied).toBeNull();
    expect(run(sla({ outsideHours: 'duty_team', fallbackTeamId: 't9' }), CLOSED, null).applied).toBeNull();
  });
});
