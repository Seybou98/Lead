import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, where, type Query } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL, SUB } from '../../domain/collections';
import type { Role } from '../../domain/enums';
import type { LeadListItem, LeadNames } from '../../domain/leads/leadList';
import type { EventInput, LeadFileData } from '../../domain/leads/leadFile';
import { toEventInput, toFileData, toListItem } from './mapLead';

/** Au-delà, la liste serait incomplète : l'écran le dit au lieu de se tromper en silence. */
export const LEAD_LIST_LIMIT = 1000;

/**
 * Requête de liste imposée par les règles Firestore : Firestore rejette en bloc toute requête dont les
 * filtres ne prouvent pas la règle. Télépro → ses leads ; manager → son périmètre (`managerIds`) ;
 * administrateur → tout. Le tri se fait côté client (pas d'index composite à créer).
 */
function scopedQuery(role: Role, uid: string): Query {
  const base = collection(db, COL.leads);
  if (role === 'telepro') return query(base, where('ownerId', '==', uid), limit(LEAD_LIST_LIMIT));
  if (role === 'manager') return query(base, where('managerIds', 'array-contains', uid), limit(LEAD_LIST_LIMIT));
  return query(base, orderBy('origin.receivedAt', 'desc'), limit(LEAD_LIST_LIMIT));
}

function useNames(): LeadNames {
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [campaigns, setCampaigns] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    // Les noms sont un confort d'affichage : sans eux, on montre les identifiants.
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
      .catch(() => undefined);
  }, []);

  return useMemo(() => ({ users, campaigns }), [users, campaigns]);
}

export interface LeadsListData {
  loading: boolean;
  error: string | null;
  items: LeadListItem[];
  truncated: boolean;
  names: LeadNames;
}

export function useLeadsList(role: Role, uid: string): LeadsListData {
  const [items, setItems] = useState<LeadListItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const names = useNames();

  useEffect(() => {
    setLoading(true);
    setError(null);
    return onSnapshot(
      scopedQuery(role, uid),
      (s) => {
        setItems(s.docs.map((d) => toListItem(d.id, d.data())).filter((x): x is LeadListItem => x !== null));
        setTruncated(s.size >= LEAD_LIST_LIMIT);
        setLoading(false);
      },
      () => {
        setError('Lecture des leads refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
        setLoading(false);
      }
    );
  }, [role, uid]);

  return useMemo(() => ({ loading, error, items, truncated, names }), [loading, error, items, truncated, names]);
}

export interface LeadFileState {
  loading: boolean;
  /** 'forbidden' : introuvable OU hors du périmètre — Firestore ne distingue pas, et ne doit pas le faire. */
  error: 'forbidden' | 'unavailable' | null;
  lead: LeadListItem | null;
  file: LeadFileData | null;
  events: EventInput[];
  names: LeadNames;
}

export function useLeadFile(leadId: string): LeadFileState {
  const [lead, setLead] = useState<LeadListItem | null>(null);
  const [file, setFile] = useState<LeadFileData | null>(null);
  const [events, setEvents] = useState<EventInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LeadFileState['error']>(null);
  const names = useNames();

  useEffect(() => {
    setLoading(true);
    setError(null);
    setLead(null);
    setFile(null);
    setEvents([]);

    const unsubLead = onSnapshot(
      doc(db, COL.leads, leadId),
      (snap) => {
        if (!snap.exists()) {
          setError('forbidden');
        } else {
          setLead(toListItem(snap.id, snap.data()));
          setFile(toFileData(snap.id, snap.data()));
        }
        setLoading(false);
      },
      (e) => {
        setError((e as { code?: string }).code === 'permission-denied' ? 'forbidden' : 'unavailable');
        setLoading(false);
      }
    );

    const unsubEvents = onSnapshot(
      query(collection(db, COL.leads, leadId, SUB.events), orderBy('at', 'desc'), limit(200)),
      (s) => setEvents(s.docs.map((d) => toEventInput(d.id, d.data())).filter((x): x is EventInput => x !== null)),
      () => undefined // l'erreur de droits est déjà portée par la lecture du lead lui-même
    );

    return () => {
      unsubLead();
      unsubEvents();
    };
  }, [leadId]);

  return useMemo(() => ({ loading, error, lead, file, events, names }), [loading, error, lead, file, events, names]);
}

/** Heure courante rafraîchie chaque seconde : fait vivre les compteurs SLA sans nouvelle donnée. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
