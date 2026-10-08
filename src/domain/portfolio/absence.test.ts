import { describe, expect, it } from 'vitest';
import { isActiveAbsence, validateAbsence, type AbsenceInput } from './absence';
import { DEFAULT_HANDLING } from './portfolio';

const NOW = Date.parse('2026-10-07T08:00:00Z');
const DAY = 86_400_000;
const ok: AbsenceInput = { type: 'leave', fromMs: NOW + DAY, toMs: NOW + 3 * DAY, reason: 'Congé validé par le manager', restoreDistribution: true, handling: DEFAULT_HANDLING };
const errors = (over: Partial<AbsenceInput>) => {
  const r = validateAbsence({ ...ok, ...over }, NOW);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r.errors;
};

describe('validateAbsence', () => {
  it('saisie complète acceptée, motif nettoyé', () => {
    const r = validateAbsence({ ...ok, reason: '  Congé  ' }, NOW);
    expect(r).toMatchObject({ ok: true, draft: { type: 'leave', reason: 'Congé', restoreDistribution: true } });
  });
  it('une absence peut déjà avoir commencé (fin dans le futur)', () => expect(validateAbsence({ ...ok, fromMs: NOW - DAY }, NOW).ok).toBe(true));
  it('type inconnu ou propriété héritée refusés', () => {
    expect(errors({ type: 'vacances' }).type).toBeTruthy();
    expect(errors({ type: 'constructor' }).type).toBeTruthy();
    expect(errors({ type: undefined }).type).toBeTruthy();
  });
  it('période : début et fin obligatoires, fin après début, pas déjà terminée, 365 jours maximum', () => {
    expect(errors({ fromMs: null }).period).toBeTruthy();
    expect(errors({ toMs: 'demain' }).period).toBeTruthy();
    expect(errors({ toMs: NOW + DAY }).period).toMatch(/postérieure/);
    expect(errors({ fromMs: NOW - 5 * DAY, toMs: NOW - DAY }).period).toMatch(/terminée/);
    expect(errors({ toMs: NOW + 400 * DAY }).period).toMatch(/365/);
    expect(errors({ fromMs: Number.NaN }).period).toBeTruthy();
  });
  it('motif obligatoire', () => {
    for (const reason of [undefined, '', '  ', 'ab', 12]) expect(errors({ reason }).reason).toBeTruthy();
  });
  it('traitement du portefeuille incomplet ou invalide refusé', () => {
    expect(errors({ handling: { ...DEFAULT_HANDLING, callbacks: 'supprimer' } }).handling).toBeTruthy();
    expect(errors({ handling: undefined }).handling).toBeTruthy();
  });
  it('retour automatique de la distribution : activé sauf refus explicite', () => {
    const r = (v: unknown) => validateAbsence({ ...ok, restoreDistribution: v }, NOW);
    expect(r(undefined)).toMatchObject({ draft: { restoreDistribution: true } });
    expect(r(false)).toMatchObject({ draft: { restoreDistribution: false } });
  });
  it('plusieurs erreurs remontées ensemble', () => expect(Object.keys(errors({ type: 'x', reason: '', handling: null })).sort()).toEqual(['handling', 'reason', 'type']));
});

describe('isActiveAbsence', () => {
  it('début inclus, fin exclue', () => {
    const a = { fromMs: NOW, toMs: NOW + DAY };
    expect(isActiveAbsence(a, NOW - 1)).toBe(false);
    expect(isActiveAbsence(a, NOW)).toBe(true);
    expect(isActiveAbsence(a, NOW + DAY - 1)).toBe(true);
    expect(isActiveAbsence(a, NOW + DAY)).toBe(false);
  });
});
