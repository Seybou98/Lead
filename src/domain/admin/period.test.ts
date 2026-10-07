import { describe, expect, it } from 'vitest';
import { periodLabel, periodRange } from './period';

const NOW = new Date(2026, 9, 6, 15, 30).getTime(); // mardi 6 octobre 2026, 15h30 (heure locale)
const d = (y: number, m: number, day: number) => new Date(y, m, day).getTime();

describe('periodRange', () => {
  it("aujourd'hui : de minuit inclus à minuit exclu", () => {
    expect(periodRange('today', NOW)).toEqual({ fromMs: d(2026, 9, 6), toMs: d(2026, 9, 7) });
  });
  it("7 jours = aujourd'hui et les 6 jours précédents ; 30 jours = 30 jours calendaires", () => {
    expect(periodRange('7d', NOW)).toEqual({ fromMs: d(2026, 9, 0), toMs: d(2026, 9, 7) }); // du 30 sept. au 6 oct. inclus
    expect(periodRange('30d', NOW)).toEqual({ fromMs: d(2026, 8, 7), toMs: d(2026, 9, 7) });
  });
  it("à cheval sur le changement d'heure (25 oct. 2026) : la borne reste à minuit local", () => {
    const after = new Date(2026, 9, 27, 12, 0).getTime();
    expect(periodRange('7d', after).fromMs).toBe(d(2026, 9, 21));
    expect(new Date(periodRange('7d', after).fromMs!).getHours()).toBe(0);
  });
  it('ce mois-ci et le mois dernier', () => {
    expect(periodRange('this_month', NOW)).toEqual({ fromMs: d(2026, 9, 1), toMs: d(2026, 10, 1) });
    expect(periodRange('last_month', NOW)).toEqual({ fromMs: d(2026, 8, 1), toMs: d(2026, 9, 1) });
  });
  it('janvier : le mois dernier est décembre de l\'année précédente', () => {
    const jan = new Date(2026, 0, 15).getTime();
    expect(periodRange('last_month', jan)).toEqual({ fromMs: d(2025, 11, 1), toMs: d(2026, 0, 1) });
  });
  it('toute la période : sans borne', () => {
    expect(periodRange('all', NOW)).toEqual({ fromMs: null, toMs: null });
  });
});

describe('periodLabel', () => {
  it('mois courant et mois dernier : nom du mois et année, comme la maquette', () => {
    expect(periodLabel('this_month', NOW)).toBe('Octobre 2026');
    expect(periodLabel('last_month', NOW)).toBe('Septembre 2026');
  });
  it('en janvier, le mois dernier est décembre de l\'année précédente', () => {
    expect(periodLabel('last_month', new Date(2026, 0, 15).getTime())).toBe('Décembre 2025');
  });
  it('autres périodes : libellé fixe', () => {
    expect(periodLabel('today', NOW)).toBe("Aujourd'hui");
    expect(periodLabel('all', NOW)).toBe('Toute la période');
  });
});
