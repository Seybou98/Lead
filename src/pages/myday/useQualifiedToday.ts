import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';

/** Nombre d'actions terminées depuis minuit (une qualification de fin d'appel clôt exactement une action). */
export function countDoneSince(docs: { state?: unknown; completedAt?: { toMillis?: () => number } | null }[], sinceMs: number): number {
  return docs.filter((d) => d.state === 'done' && typeof d.completedAt?.toMillis === 'function' && d.completedAt.toMillis() >= sinceMs).length;
}

/**
 * Appels qualifiés aujourd'hui par ce télépro. Requête cadrée sur son identifiant (exigé par les règles
 * Firestore) ; le tri par jour se fait ici pour ne pas imposer d'index composite.
 * null tant que la lecture n'a pas abouti ou si elle est refusée : l'écran affiche « — », jamais un faux zéro.
 */
export function useQualifiedToday(uid: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!uid) return;
    setCount(null);
    return onSnapshot(
      query(collection(db, COL.actions), where('ownerId', '==', uid), limit(1000)),
      (snap) => setCount(countDoneSince(snap.docs.map((d) => d.data()), new Date().setHours(0, 0, 0, 0))),
      () => setCount(null)
    );
  }, [uid]);

  return count;
}
