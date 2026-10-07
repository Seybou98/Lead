import { describe, expect, it } from 'vitest';
import { buildCallSession, callbackPresets, callDurationSeconds, formatDuration, fromLocalFields, parseSession, SESSION_MAX_AGE_MS, toLocalFields } from './callSession';

const NOW = new Date(2026, 9, 7, 14, 40).getTime();
const good = { leadId: 'L1', startedAtMs: NOW - 60_000, phase: 'calling', endedAtMs: null, requestId: 'q12345678' };

describe('parseSession', () => {
  it('relit une session valide', () => {
    expect(parseSession(JSON.stringify(good), NOW)).toEqual(good);
  });
  it('refuse le vide, le non-JSON et les formes incomplètes', () => {
    expect(parseSession(null, NOW)).toBeNull();
    expect(parseSession('', NOW)).toBeNull();
    expect(parseSession('{', NOW)).toBeNull();
    expect(parseSession('null', NOW)).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, leadId: '' }), NOW)).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, requestId: 'court' }), NOW)).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, phase: 'dormant' }), NOW)).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, startedAtMs: 'hier' }), NOW)).toBeNull();
  });
  it('abandonne une session trop ancienne ou datée du futur', () => {
    expect(parseSession(JSON.stringify({ ...good, startedAtMs: NOW - SESSION_MAX_AGE_MS - 1 }), NOW)).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, startedAtMs: NOW + 10 * 60_000 }), NOW)).toBeNull();
  });
  it('une fin d’appel invalide devient null', () => {
    expect(parseSession(JSON.stringify({ ...good, endedAtMs: 'x' }), NOW)?.endedAtMs).toBeNull();
  });
});

describe('durées', () => {
  it('durée jusqu’à la fin déclarée, sinon jusqu’à maintenant', () => {
    expect(callDurationSeconds({ startedAtMs: NOW - 95_000, endedAtMs: null }, NOW)).toBe(95);
    expect(callDurationSeconds({ startedAtMs: NOW - 95_000, endedAtMs: NOW - 35_000 }, NOW)).toBe(60);
    expect(callDurationSeconds({ startedAtMs: NOW + 5000, endedAtMs: null }, NOW)).toBe(0);
  });
  it('formatDuration', () => {
    expect(formatDuration(378)).toBe('06:18');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(-4)).toBe('00:00');
  });
});

describe('champs date/heure', () => {
  it('aller-retour', () => {
    const f = toLocalFields(NOW);
    expect(f).toEqual({ date: '2026-10-07', time: '14:40' });
    expect(fromLocalFields(f.date, f.time)).toBe(NOW);
  });
  it('refuse l’incomplet et les dates qui débordent', () => {
    expect(fromLocalFields('', '14:40')).toBeNaN();
    expect(fromLocalFields('2026-10-07', '')).toBeNaN();
    expect(fromLocalFields('2026-02-31', '10:00')).toBeNaN();
    expect(fromLocalFields('07/10/2026', '10:00')).toBeNaN();
  });
});

describe('callbackPresets', () => {
  it('propose 30 min, cet après-midi (si à venir) et demain matin', () => {
    const p = callbackPresets(new Date(2026, 9, 7, 10, 0).getTime());
    expect(p.map((x) => x.key)).toEqual(['30', 'pm', 'tomorrow']);
    expect(toLocalFields(p[1].atMs).time).toBe('15:00');
    expect(toLocalFields(p[2].atMs)).toEqual({ date: '2026-10-08', time: '09:00' });
  });
  it('ne propose pas « cet après-midi » quand il est déjà tard', () => {
    expect(callbackPresets(NOW).map((x) => x.key)).toEqual(['30', 'tomorrow']);
  });
  it('tous les créneaux proposés sont dans le futur', () => {
    for (const x of callbackPresets(NOW)) expect(x.atMs).toBeGreaterThan(NOW);
  });
});

describe('statut d’avant l’appel (menu Disponible / Pause)', () => {
  it('buildCallSession retient le statut en cours, jamais « En appel »', () => {
    expect(buildCallSession('L1', NOW, 'q12345678', 'paused')).toMatchObject({ phase: 'calling', resumeStatus: 'paused', endedAtMs: null });
    expect(buildCallSession('L1', NOW, 'q12345678', 'doc_followup').resumeStatus).toBe('doc_followup');
    expect(buildCallSession('L1', NOW, 'q12345678', 'on_call').resumeStatus).toBe('available');
    expect(buildCallSession('L1', NOW, 'q12345678', undefined).resumeStatus).toBe('available');
    expect(buildCallSession('L1', NOW, 'q12345678', 'absent').resumeStatus).toBe('available');
  });
  it('parseSession relit un statut valide et ignore un statut inconnu ou hostile', () => {
    expect(parseSession(JSON.stringify({ ...good, resumeStatus: 'paused' }), NOW)?.resumeStatus).toBe('paused');
    for (const bad of ['dormir', 'constructor', 42, null]) {
      expect(parseSession(JSON.stringify({ ...good, resumeStatus: bad }), NOW)).not.toHaveProperty('resumeStatus');
    }
    expect(parseSession(JSON.stringify(good), NOW)).not.toHaveProperty('resumeStatus');
  });
});
