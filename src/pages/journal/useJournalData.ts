import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, onSnapshot, orderBy, query, Timestamp, where, type DocumentData } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { JournalEntry, JournalNames } from '../../domain/admin/journal';
import { ms, strs } from '../../lib/firestoreViews';

/** Au-delà, la liste est tronquée : l'écran le signale. */
export const JOURNAL_READ_LIMIT = 1000;

function toEntry(id: string, d: DocumentData): JournalEntry | null {
  const atMs = ms(d.at);
  if (atMs === null) return null;
  return {
    id,
    atMs,
    leadId: String(d.leadId ?? ''),
    leadName: typeof d.leadName === 'string' && d.leadName ? d.leadName : null,
    campaignId: d.campaignId ?? null,
    event: String(d.event ?? ''),
    mode: d.mode === 'simulation' ? 'simulation' : 'real',
    chosenOwnerId: d.chosenOwnerId ?? null,
    previousOwnerId: d.previousOwnerId ?? null,
    actorId: String(d.actorId ?? ''),
    reason: d.reason ?? null,
    ruleApplied: String(d.ruleApplied ?? ''),
    candidates: (Array.isArray(d.candidates) ? d.candidates : []).map((c: DocumentData) => ({
      uid: String(c.uid ?? ''),
      eligible: c.eligible === true,
      exclusions: strs(c.exclusions),
      activeLoad: Number(c.activeLoad ?? 0),
      newLeads: Number(c.newLeads ?? 0),
      cap: typeof c.cap === 'number' ? c.cap : null,
    })),
  };
}

export interface JournalData {
  loading: boolean;
  error: string | null;
  entries: JournalEntry[];
  truncated: boolean;
  names: JournalNames;
}

export function useJournalData(fromMs: number | null): JournalData {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [campaigns, setCampaigns] = useState<Map<string, string>>(new Map());
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const base = collection(db, COL.distributionLog);
    const q =
      fromMs === null
        ? query(base, orderBy('at', 'desc'), limit(JOURNAL_READ_LIMIT))
        : query(base, where('at', '>=', Timestamp.fromMillis(fromMs)), orderBy('at', 'desc'), limit(JOURNAL_READ_LIMIT));
    setLoadingEntries(true);
    return onSnapshot(
      q,
      (s) => {
        setEntries(s.docs.map((d) => toEntry(d.id, d.data())).filter((e): e is JournalEntry => e !== null));
        setTruncated(s.size >= JOURNAL_READ_LIMIT);
        setLoadingEntries(false);
      },
      () => {
        setError('Lecture du journal refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
        setLoadingEntries(false);
      }
    );
  }, [fromMs]);

  useEffect(() => {
    return onSnapshot(collection(db, COL.campaigns), (s) => setCampaigns(new Map(s.docs.map((d) => [d.id, String(d.get('name') ?? d.id)]))), () => undefined);
  }, []);

  useEffect(() => {
    getDocs(collection(db, 'users'))
      .then((s) =>
        setUsers(
          new Map(
            s.docs.map((d) => {
              const x = d.data();
              return [d.id, String(x.name || x.displayName || `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || x.email || d.id)];
            })
          )
        )
      )
      .catch(() => undefined); // sans noms, le journal affiche les identifiants
  }, []);

  return useMemo(
    () => ({ loading: loadingEntries, error, entries, truncated, names: { users, campaigns } }),
    [loadingEntries, error, entries, truncated, users, campaigns]
  );
}
