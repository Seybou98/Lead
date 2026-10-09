import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('export CSV', () => {
  it('une cellule de texte qui ressemble à une formule est neutralisée', () => {
    for (const t of ['=SOMME(A1)', '+33', '-1', '@x']) expect(csvCell(t).startsWith("'")).toBe(true);
  });
  it('un nombre négatif reste un nombre', () => {
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(0)).toBe('0');
  });
  it('point-virgule et guillemets protégés', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
  });
  it('BOM, séparateur point-virgule, lignes séparées', () => {
    expect(toCsv(['A', 'B'], [[1, 'x'], [-2, 'y']])).toBe('﻿A;B\r\n1;x\r\n-2;y');
  });
});
