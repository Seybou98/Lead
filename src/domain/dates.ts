import type { Timestamp } from 'firebase/firestore';

/**
 * Même forme qu'un modèle Firestore, mais avec des `Date` à la place des `Timestamp`.
 * Les Cloud Functions construisent leurs documents avec des Date (le SDK Admin les convertit en
 * Timestamp à l'écriture), ce qui permet de tester la logique sans dépendre de Firebase.
 */
export type DeepDate<T> = T extends Timestamp
  ? Date
  : T extends (infer U)[]
    ? DeepDate<U>[]
    : T extends object
      ? { [K in keyof T]: DeepDate<T[K]> }
      : T;
