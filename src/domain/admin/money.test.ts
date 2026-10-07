import { describe, expect, it } from 'vitest';
import { parseEuros } from './money';

describe('parseEuros', () => {
  it.each([
    ['1250', 125_000],
    ['1 250,50', 125_050],
    ['1\u00a0250,50', 125_050], // espace insécable (copié depuis un tableur)
    ['1250.5', 125_000 + 50],
    ['0', 0],
    ['0,01', 1],
    ['  12,3  ', 1230],
  ])('« %s » → %d centimes', (input, cents) => {
    expect(parseEuros(input)).toBe(cents);
  });

  it('arrondit au centime sans erreur de virgule flottante (19,99 € ne donne pas 1998)', () => {
    expect(parseEuros('19,99')).toBe(1999);
    expect(parseEuros('0,29')).toBe(29);
    expect(parseEuros('1,005')).toBe(101);
  });

  it.each([[''], ['   '], ['abc'], ['12abc'], ['-5'], ['1,2,3'], ['1e3'], ['€12'], ['Infinity']])('refuse « %s » (jamais 0 par défaut)', (input) => {
    expect(parseEuros(input)).toBeNull();
  });
});
