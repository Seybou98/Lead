import { describe, expect, it } from 'vitest';

// Le module importe Firebase : on ne teste que la fonction pure, en la chargeant sans initialiser l'application.
import { vi } from 'vitest';
vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ collection: () => ({}), limit: () => ({}), onSnapshot: () => () => undefined, query: () => ({}), where: () => ({}) }));

import { countDoneSince } from './useQualifiedToday';

const T = (ms: number) => ({ toMillis: () => ms });
const SINCE = 1_000_000;

describe('countDoneSince', () => {
  it('compte les actions terminées depuis minuit, pas celles d’hier ni les ouvertes', () => {
    const docs = [
      { state: 'done', completedAt: T(SINCE + 5) },
      { state: 'done', completedAt: T(SINCE) },
      { state: 'done', completedAt: T(SINCE - 1) },
      { state: 'open', completedAt: null },
      { state: 'cancelled', completedAt: T(SINCE + 9) },
    ];
    expect(countDoneSince(docs, SINCE)).toBe(2);
  });
  it('ignore une action terminée sans date plutôt que de la compter', () => {
    expect(countDoneSince([{ state: 'done', completedAt: null }, { state: 'done' }], SINCE)).toBe(0);
  });
  it('liste vide : zéro', () => {
    expect(countDoneSince([], SINCE)).toBe(0);
  });
});
