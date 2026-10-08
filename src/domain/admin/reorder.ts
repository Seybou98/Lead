// Réordonnancement d'une liste (ordre de priorité des règles d'attribution, fig. 17). Fonction pure : le
// glisser-déposer et les flèches du clavier passent par la même règle.

/** Déplace l'élément `from` à la position `to`. Hors bornes ou même place : la liste est rendue inchangée. */
export function reorderList<T>(list: readonly T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [...list];
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
