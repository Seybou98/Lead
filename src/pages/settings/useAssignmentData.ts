import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, Timestamp, where, query } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL, CONFIG_VERSIONS } from '../../domain/collections';
import type { AbsenceInput, PresenceInput, ProfileInput, UserInput } from '../../domain/ingest/candidates';
import { toProfileInput } from '../../domain/ingest/profileInput';
import type { TeamView } from '../../domain/admin/userRows';
import { ms, toTeam } from '../../lib/firestoreViews';
import { toCampaign, type CampaignRecord } from '../campaigns/useCampaignsData';

export interface AssignmentData {
  loading: boolean;
  error: string | null;
  campaigns: CampaignRecord[];
  teams: TeamView[];
  profiles: ProfileInput[];
  users: Record<string, UserInput>;
  presence: Record<string, PresenceInput>;
  absences: AbsenceInput[];
  /** Configuration d'attribution globale publiée (cl_config/assignment), ou null : même lecture que le moteur serveur. */
  globalConfig: unknown;
}

/** Mêmes sources que l'ingestion réelle (functions/src/ingest.ts) : c'est ce qui rend la simulation fidèle. */
export function useAssignmentData(): AssignmentData {
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [profiles, setProfiles] = useState<ProfileInput[]>([]);
  const [users, setUsers] = useState<Record<string, UserInput>>({});
  const [presence, setPresence] = useState<Record<string, PresenceInput>>({});
  const [absences, setAbsences] = useState<AbsenceInput[]>([]);
  const [globalConfig, setGlobalConfig] = useState<unknown>(null);
  const [pending, setPending] = useState({ campaigns: true, profiles: true, users: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = () => setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
    const done = (k: keyof typeof pending) => setPending((p) => ({ ...p, [k]: false }));
    const unsubs = [
      onSnapshot(collection(db, COL.campaigns), (s) => { setCampaigns(s.docs.map((d) => toCampaign(d.id, d.data()))); done('campaigns'); }, fail),
      onSnapshot(collection(db, COL.teams), (s) => setTeams(s.docs.map((d) => toTeam(d.id, d.data()))), fail),
      onSnapshot(collection(db, COL.profiles), (s) => { setProfiles(s.docs.map((d) => toProfileInput(d.id, d.data(), ms))); done('profiles'); }, fail),
      onSnapshot(
        collection(db, COL.presence),
        (s) => setPresence(Object.fromEntries(s.docs.map((d) => [d.id, { connected: d.get('connected') === true, lastSeenAtMs: ms(d.get('lastSeenAt')) }]))),
        () => undefined // sans présence, tout le monde est « non connecté » : comportement sûr
      ),
      onSnapshot(
        query(collection(db, COL.absences), where('to', '>=', Timestamp.now())),
        (s) =>
          setAbsences(
            s.docs
              .map((d) => ({ userId: String(d.get('userId') ?? ''), fromMs: ms(d.get('from')), toMs: ms(d.get('to')) }))
              .filter((a): a is AbsenceInput => !!a.userId && a.fromMs !== null && a.toMs !== null)
          ),
        () => undefined
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Même chemin que readPublishedConfig() côté serveur : pointeur → version publiée → payload.
  useEffect(() => {
    let cancelled = false;
    const unsub = onSnapshot(
      doc(db, COL.config, 'assignment'),
      (pointer) => {
        const versionId = pointer.get('publishedVersionId');
        if (typeof versionId !== 'string') return void setGlobalConfig(null);
        getDoc(doc(db, COL.config, 'assignment', CONFIG_VERSIONS, versionId))
          .then((v) => !cancelled && setGlobalConfig(v.exists() ? v.get('payload') : null))
          .catch(() => !cancelled && setGlobalConfig(null));
      },
      () => setGlobalConfig(null)
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    getDocs(collection(db, 'users'))
      .then((s) => {
        const out: Record<string, UserInput> = {};
        s.docs.forEach((d) => {
          const x = d.data();
          out[d.id] = { uid: d.id, role: x.role ?? null, status: x.status ?? null, name: x.name || x.displayName || `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || x.email || d.id };
        });
        setUsers(out);
      })
      .catch(() => setError('Impossible de lire la liste des utilisateurs.'))
      .finally(() => setPending((p) => ({ ...p, users: false })));
  }, []);

  return useMemo(
    () => ({ loading: Object.values(pending).some(Boolean), error, campaigns, teams, profiles, users, presence, absences, globalConfig }),
    [pending, error, campaigns, teams, profiles, users, presence, absences, globalConfig]
  );
}
