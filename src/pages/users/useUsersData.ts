import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, onSnapshot, type DocumentData } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { ms, strs, toTeam, toUser } from '../../lib/firestoreViews';
import { COL } from '../../domain/collections';
import type { OperationalStatus } from '../../domain/enums';
import type { MainUserView, PresenceView, ProfileView, TeamView } from '../../domain/admin/userRows';

export function toProfile(id: string, d: DocumentData): ProfileView {
  const o = d.capacity?.override;
  const from = ms(o?.from);
  const until = ms(o?.until);
  return {
    uid: id,
    primaryTeamId: d.primaryTeamId ?? null,
    teamIds: strs(d.teamIds),
    scope: { productCodes: strs(d.scope?.productCodes), zones: strs(d.scope?.zones) },
    capacity: {
      newLeadsCap: typeof d.capacity?.newLeadsCap === 'number' ? d.capacity.newLeadsCap : Number.NaN,
      override: o && from !== null && until !== null ? { value: Number(o.value), fromMs: from, untilMs: until } : null,
    },
    operationalStatus: (d.operationalStatus ?? 'available') as OperationalStatus,
    distributionSuspended: d.distributionSuspended === true,
    newLeads: Number(d.load?.newLeads ?? 0),
    accessEndsAtMs: ms(d.accessEndsAt),
  };
}

export interface SlotRaw {
  day: number;
  start: string;
  end: string;
}

/** Données brutes en plus, pour préremplir les formulaires sans relire la base. */
export interface RawProfile {
  scope: { productCodes: string[]; zones: string[]; campaignIds: string[]; sourceIds: string[] };
  schedule: { timezone: string; weekly: SlotRaw[]; breaks: SlotRaw[] };
  /** null = valeur par défaut. */
  newLeadsCap: number | null;
}
export interface RawTeam {
  productCodes: string[];
  zones: string[];
  fallbackTeamId: string | null;
}

export interface UsersData {
  loading: boolean;
  error: string | null;
  users: MainUserView[];
  profiles: Map<string, ProfileView>;
  rawProfiles: Map<string, RawProfile>;
  teams: TeamView[];
  rawTeams: Map<string, RawTeam>;
  presence: Map<string, PresenceView>;
  /** Heure de référence, rafraîchie toutes les 15 s : les « connecté » expirent sans nouvelle donnée. */
  nowMs: number;
  reloadUsers: () => void;
}

export function useUsersData(): UsersData {
  const [users, setUsers] = useState<MainUserView[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileView>>(new Map());
  const [rawProfiles, setRawProfiles] = useState<Map<string, RawProfile>>(new Map());
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [rawTeams, setRawTeams] = useState<Map<string, RawTeam>>(new Map());
  const [presence, setPresence] = useState<Map<string, PresenceView>>(new Map());
  const [pending, setPending] = useState({ users: true, profiles: true, teams: true });
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  // Comptes du CRM principal : lus une fois (la collection peut être grande), relus sur demande.
  useEffect(() => {
    let cancelled = false;
    getDocs(collection(db, 'users'))
      .then((snap) => {
        if (cancelled) return;
        setUsers(snap.docs.map((d) => toUser(d.id, d.data())));
        setPending((p) => ({ ...p, users: false }));
      })
      .catch(() => {
        if (cancelled) return;
        setError('Impossible de lire la liste des utilisateurs.');
        setPending((p) => ({ ...p, users: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    const fail = () => setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
    const unsubs = [
      onSnapshot(
        collection(db, COL.profiles),
        (snap) => {
          const p = new Map<string, ProfileView>();
          const raw = new Map<string, RawProfile>();
          snap.docs.forEach((d) => {
            const x = d.data();
            p.set(d.id, toProfile(d.id, x));
            raw.set(d.id, {
              scope: {
                productCodes: strs(x.scope?.productCodes),
                zones: strs(x.scope?.zones),
                campaignIds: strs(x.scope?.campaignIds),
                sourceIds: strs(x.scope?.sourceIds),
              },
              schedule: {
                timezone: x.schedule?.timezone ?? 'Europe/Paris',
                weekly: Array.isArray(x.schedule?.weekly) ? x.schedule.weekly : [],
                breaks: Array.isArray(x.schedule?.breaks) ? x.schedule.breaks : [],
              },
              newLeadsCap: typeof x.capacity?.newLeadsCap === 'number' ? x.capacity.newLeadsCap : null,
            });
          });
          setProfiles(p);
          setRawProfiles(raw);
          setPending((s) => ({ ...s, profiles: false }));
        },
        fail
      ),
      onSnapshot(
        collection(db, COL.teams),
        (snap) => {
          setTeams(snap.docs.map((d) => toTeam(d.id, d.data())));
          setRawTeams(
            new Map(
              snap.docs.map((d) => [
                d.id,
                { productCodes: strs(d.get('productCodes')), zones: strs(d.get('zones')), fallbackTeamId: d.get('fallbackTeamId') ?? null },
              ])
            )
          );
          setPending((s) => ({ ...s, teams: false }));
        },
        fail
      ),
      onSnapshot(
        collection(db, COL.presence),
        (snap) =>
          setPresence(new Map(snap.docs.map((d) => [d.id, { connected: d.get('connected') === true, lastSeenAtMs: ms(d.get('lastSeenAt')) }]))),
        () => {
          // La présence est secondaire : sans elle, tout le monde apparaît déconnecté, ce qui est le comportement sûr.
        }
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return useMemo(
    () => ({
      loading: pending.users || pending.profiles || pending.teams,
      error,
      users,
      profiles,
      rawProfiles,
      teams,
      rawTeams,
      presence,
      nowMs,
      reloadUsers: () => setReloadKey((k) => k + 1),
    }),
    [pending, error, users, profiles, rawProfiles, teams, rawTeams, presence, nowMs]
  );
}
