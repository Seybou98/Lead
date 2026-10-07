import { describe, expect, it } from 'vitest';
import { capacityInfo, DISTRIBUTION_STOPPING, planStatusChange, SELECTABLE_STATUSES, statusAfterCall } from './status';
import { decideAssignment, DEFAULT_ASSIGNMENT_CONFIG, type Candidate } from '../engine/assignment';
import { OPERATIONAL_STATUSES } from '../enums';

const NOW = Date.UTC(2026, 9, 7, 12, 0);
const ts = (ms: number) => ({ toMillis: () => ms });

describe('planStatusChange', () => {
  it('accepte chaque statut du menu depuis un statut libre', () => {
    for (const s of SELECTABLE_STATUSES) {
      const r = planStatusChange('available', s);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe(s);
    }
  });

  it('accepte « En appel » (posé par le démarrage d’un appel)', () => {
    expect(planStatusChange('available', 'on_call')).toMatchObject({ ok: true, changed: true, status: 'on_call', before: 'available' });
  });

  it('un changement vers le même statut n’en est pas un', () => {
    expect(planStatusChange('paused', 'paused')).toMatchObject({ ok: true, changed: false });
  });

  it('refuse les statuts qui ne se choisissent pas soi-même', () => {
    for (const s of ['absent', 'unavailable', 'disconnected', 'in_meeting', 'processing']) {
      expect(planStatusChange('available', s)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('refuse les valeurs invalides ou hostiles', () => {
    for (const v of [undefined, null, '', 42, {}, [], 'constructor', '__proto__', 'PAUSED', ' paused']) {
      expect(planStatusChange('available', v)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('un statut posé par le manager (absent, indisponible) ne se change pas soi-même', () => {
    expect(planStatusChange('absent', 'available')).toMatchObject({ ok: false, code: 'locked' });
    expect(planStatusChange('unavailable', 'paused')).toMatchObject({ ok: false, code: 'locked' });
  });

  it('depuis « Déconnecté » ou « En pause », on peut revenir disponible', () => {
    expect(planStatusChange('disconnected', 'available')).toMatchObject({ ok: true, changed: true });
    expect(planStatusChange('paused', 'available')).toMatchObject({ ok: true, changed: true });
  });
});

describe('statusAfterCall', () => {
  it('revient au statut d’avant l’appel, sinon « Disponible »', () => {
    expect(statusAfterCall('paused')).toBe('paused');
    expect(statusAfterCall('doc_followup')).toBe('doc_followup');
    expect(statusAfterCall(undefined)).toBe('available');
    expect(statusAfterCall('on_call')).toBe('available'); // jamais « rester en appel »
    expect(statusAfterCall('absent')).toBe('available');
    expect(statusAfterCall('constructor')).toBe('available');
  });
});

describe('capacityInfo (§4.2 : plafond 10, sortie à 10, retour à 9)', () => {
  it('par défaut : plafond 10', () => {
    expect(capacityInfo(3, null, NOW)).toMatchObject({ used: 3, cap: 10, full: false, toFree: 0, percent: 30 });
  });
  it('9/10 : encore éligible ; 10/10 : plein', () => {
    expect(capacityInfo(9, { newLeadsCap: null, override: null }, NOW).full).toBe(false);
    const full = capacityInfo(10, { newLeadsCap: null, override: null }, NOW);
    expect(full).toMatchObject({ full: true, toFree: 1, percent: 100 });
  });
  it('au-delà du plafond : combien de leads à traiter pour redevenir éligible', () => {
    expect(capacityInfo(12, { newLeadsCap: null, override: null }, NOW)).toMatchObject({ full: true, toFree: 3, percent: 100 });
  });
  it('plafond individuel', () => {
    expect(capacityInfo(5, { newLeadsCap: 5, override: null }, NOW)).toMatchObject({ cap: 5, full: true });
    expect(capacityInfo(4, { newLeadsCap: 5, override: null }, NOW).full).toBe(false);
  });
  it('dérogation : seulement pendant sa période (retour automatique au plafond normal)', () => {
    const o = (from: number, until: number) => ({ newLeadsCap: null, override: { value: 15, from: ts(from), until: ts(until) } });
    expect(capacityInfo(12, o(NOW - 1000, NOW + 1000), NOW)).toMatchObject({ cap: 15, full: false });
    expect(capacityInfo(12, o(NOW - 5000, NOW - 1000), NOW)).toMatchObject({ cap: 10, full: true });
    expect(capacityInfo(12, o(NOW + 1000, NOW + 5000), NOW)).toMatchObject({ cap: 10, full: true });
  });
  it('un nombre négatif ou absurde ne produit pas de jauge négative', () => {
    expect(capacityInfo(-4, null, NOW)).toMatchObject({ used: 0, percent: 0 });
  });
});

describe('cohérence avec le moteur de distribution', () => {
  const base: Candidate = {
    uid: 'u1', name: 'T', accountActive: true, accessEndsAtMs: null, connected: true, operationalStatus: 'available', distributionSuspended: false,
    absent: false, withinSchedule: true, teamIds: ['t1'], scope: { productCodes: ['pac'], zones: ['idf'] }, newLeads: 0, activeLoad: 0,
    capacity: { newLeadsCap: Number.NaN, override: null }, lastAssignedAtMs: null,
  };
  const assign = (c: Partial<Candidate>) =>
    decideAssignment({ id: 'L', productCode: 'pac', zone: 'idf', campaignId: null }, null, [{ ...base, ...c }], NOW, DEFAULT_ASSIGNMENT_CONFIG);

  it('un télépro en pause ne reçoit rien ; disponible, il reçoit', () => {
    expect(assign({ operationalStatus: 'paused' }).chosenUid).toBeNull();
    expect(assign({ operationalStatus: 'available' }).chosenUid).toBe('u1');
  });

  it('à 10/10 il sort du pool, à 9/10 il revient', () => {
    expect(assign({ newLeads: 10 }).chosenUid).toBeNull();
    expect(assign({ newLeads: 9 }).chosenUid).toBe('u1');
  });

  it('les statuts de travail (appel, relance, montage) ne coupent pas la distribution', () => {
    for (const s of ['on_call', 'doc_followup', 'file_building', 'processing'] as const) {
      expect(DISTRIBUTION_STOPPING.includes(s)).toBe(false);
      expect(assign({ operationalStatus: s }).chosenUid).toBe('u1');
    }
  });

  it('les statuts qui coupent la distribution côté écran sont bien exclus par le moteur', () => {
    for (const s of OPERATIONAL_STATUSES.filter((x) => DISTRIBUTION_STOPPING.includes(x))) {
      expect(assign({ operationalStatus: s }).chosenUid).toBeNull();
    }
  });
});
