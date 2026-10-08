import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { resolveChecklist, type ResolvedChecklist } from '../../domain/documents/checklist';
import { ms } from '../../lib/firestoreViews';

export interface ChecklistsData {
  loading: boolean;
  error: boolean;
  /** Documents bruts par clé de famille (« default » pour la checklist par défaut). */
  byKey: Record<string, unknown>;
  /** Dernière modification de chaque checklist, pour l'affichage. */
  updatedAt: Record<string, number | null>;
}

/** Checklists documentaires enregistrées (cl_checklists), en temps réel. Lisible par tout le personnel. */
export function useChecklists(): ChecklistsData {
  const [state, setState] = useState<ChecklistsData>({ loading: true, error: false, byKey: {}, updatedAt: {} });
  useEffect(
    () =>
      onSnapshot(
        collection(db, COL.checklists),
        (s) =>
          setState({
            loading: false,
            error: false,
            byKey: Object.fromEntries(s.docs.map((d) => [d.id, d.data()])),
            updatedAt: Object.fromEntries(s.docs.map((d) => [d.id, ms(d.get('updatedAt'))])),
          }),
        // Sans la liste, on retombe sur la checklist d'origine : l'appel n'est jamais bloqué.
        () => setState({ loading: false, error: true, byKey: {}, updatedAt: {} })
      ),
    []
  );
  return state;
}

/** Checklist qui s'applique à un produit : la sienne, sinon celle par défaut, sinon la liste d'origine. */
export function useChecklistFor(productCode: string | null): ResolvedChecklist {
  const { byKey } = useChecklists();
  return useMemo(() => resolveChecklist(productCode, byKey), [productCode, byKey]);
}
