import { useCallback, useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { JournalEntry } from '../../domain/integrations/hub';
import { fetchJournal } from '../../lib/hubApi';
import { ms } from '../../lib/firestoreViews';

export interface JournalState {
  loading: boolean;
  error: string | null;
  entries: JournalEntry[];
  truncated: boolean;
  fetchedAtMs: number | null;
  refresh: () => Promise<void>;
}

/** Journal des échanges (lecture serveur, administrateur) : chargé à l'ouverture, actualisé à la demande. */
export function useJournal(): JournalState {
  const [state, setState] = useState<Omit<JournalState, 'refresh'>>({ loading: true, error: null, entries: [], truncated: false, fetchedAtMs: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = await fetchJournal();
    if (r.ok) setState({ loading: false, error: null, entries: r.entries, truncated: r.truncated, fetchedAtMs: Date.now() });
    else setState((s) => ({ ...s, loading: false, error: r.message }));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, refresh: load };
}

/** Dernier passage du planificateur serveur (null : jamais passé ou illisible). */
export function useSchedulerLastRun(): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(
    () =>
      onSnapshot(
        doc(db, COL.config, 'schedulerStatus'),
        (s) => setAt(s.exists() ? ms(s.get('lastRunAt')) : null),
        () => setAt(null)
      ),
    []
  );
  return at;
}

export const fmtDateTime = (atMs: number): string => new Date(atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtShort = (atMs: number | null): string => (atMs === null ? '—' : new Date(atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
