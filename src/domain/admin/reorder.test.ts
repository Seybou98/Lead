import { describe, expect, it } from 'vitest';
import { reorderList } from './reorder';

const L = ['a', 'b', 'c', 'd'];

describe('reorderList', () => {
  it('descend un élément', () => expect(reorderList(L, 0, 2)).toEqual(['b', 'c', 'a', 'd']));
  it('remonte un élément', () => expect(reorderList(L, 3, 0)).toEqual(['d', 'a', 'b', 'c']));
  it('échange deux voisins (flèches)', () => {
    expect(reorderList(L, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(reorderList(L, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
  });
  it('même place ou hors bornes : liste inchangée', () => {
    for (const [f, t] of [[1, 1], [-1, 2], [2, -1], [4, 0], [0, 4], [0.5, 1], [Number.NaN, 1]]) expect(reorderList(L, f, t)).toEqual(L);
  });
  it('ne modifie jamais la liste reçue et garde tous les éléments', () => {
    const copy = [...L];
    const out = reorderList(L, 0, 3);
    expect(L).toEqual(copy);
    expect([...out].sort()).toEqual([...L].sort());
    expect(out).not.toBe(L);
  });
  it('liste vide ou à un élément', () => {
    expect(reorderList([], 0, 0)).toEqual([]);
    expect(reorderList(['x'], 0, 1)).toEqual(['x']);
  });
});
