import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { MainUserView, TeamView } from '../../domain/admin/userRows';
import { toTeam, toUser } from '../../lib/firestoreViews';
import { toCampaign, type CampaignRecord, type SourceRecord } from './useCampaignsData';

export interface CampaignFormData {
  loading: boolean;
  error: string | null;
  campaigns: CampaignRecord[];
  sources: SourceRecord[];
  teams: TeamView[];
  users: MainUserView[];
  /** Télépros disposant d'un profil de distribution : seuls ceux-là peuvent être nommément éligibles. */
  profileUids: ReadonlySet<string>;
}

/** Données du formulaire de campagne : tout en lecture seule, aucune lecture de leads. */
export function useCampaignFormData(): CampaignFormData {
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [users, setUsers] = useState<MainUserView[]>([]);
  const [profileUids, setProfileUids] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState({ campaigns: true, sources: true, teams: true, users: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = () => setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
    const done = (k: keyof typeof pending) => setPending((p) => ({ ...p, [k]: false }));
    const unsubs = [
      onSnapshot(collection(db, COL.campaigns), (s) => { setCampaigns(s.docs.map((d) => toCampaign(d.id, d.data()))); done('campaigns'); }, fail),
      onSnapshot(collection(db, COL.sources), (s) => { setSources(s.docs.map((d) => ({ id: d.id, name: d.get('name') ?? d.id, kind: d.get('kind') ?? 'manual', enabled: d.get('enabled') !== false }))); done('sources'); }, fail),
      onSnapshot(collection(db, COL.teams), (s) => { setTeams(s.docs.map((d) => toTeam(d.id, d.data()))); done('teams'); }, fail),
      onSnapshot(collection(db, COL.profiles), (s) => setProfileUids(new Set(s.docs.map((d) => d.id))), () => undefined),
    ];
    getDocs(collection(db, 'users'))
      .then((s) => setUsers(s.docs.map((d) => toUser(d.id, d.data()))))
      .catch(() => setError('Impossible de lire la liste des utilisateurs.'))
      .finally(() => done('users'));
    return () => unsubs.forEach((u) => u());
  }, []);

  return useMemo(
    () => ({ loading: Object.values(pending).some(Boolean), error, campaigns, sources, teams, users, profileUids }),
    [pending, error, campaigns, sources, teams, users, profileUids]
  );
}
