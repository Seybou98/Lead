import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, query, where, type Query } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { Role } from '../../domain/enums';
import { buildUserRows, type MainUserView, type PresenceView, type ProfileView, type TeamView, type UserRow } from '../../domain/admin/userRows';
import type { LeadListItem, LeadNames } from '../../domain/leads/leadList';
import { ms, toTeam, toUser } from '../../lib/firestoreViews';
import { parseStatusReturn, type StatusReturnTrace } from '../../domain/integrations/hub';
import type { ReportCampaign, ReportSpend } from '../../domain/reports/direction';
import type { AlertRule } from '../../domain/reports/targets';
import { useSettings } from '../settings/useSettings';
import { toProfile } from '../users/useUsersData';
import { useLeadsList, useNow } from '../leads/useLeadsData';

export interface CockpitData {
  loading: boolean;
  /** Lecture refusée ou indisponible (leads, équipe) : l'écran le dit au lieu d'afficher des zéros. */
  error: string | null;
  items: LeadListItem[];
  rows: UserRow[];
  users: MainUserView[];
  names: LeadNames;
  nowMs: number;
  /** Campagnes et dépenses, pour évaluer les alertes KPI (lecture secondaire : sans elles, les règles de coût sont muettes). */
  reportCampaigns: ReportCampaign[];
  spends: ReportSpend[];
  /** Règles d'alerte réglées dans Paramètres → Objectifs et alertes. */
  kpiRules: AlertRule[];
  /** Planificateur serveur : dernier passage (null = jamais ou illisible) et trace du retour des statuts du CRM principal. */
  scheduler: { lastRunAtMs: number | null; statusReturn: StatusReturnTrace | null };
  /** Dernière donnée reçue en temps réel. */
  syncedAtMs: number | null;
  /** Le navigateur est hors ligne : les chiffres affichés ne sont plus à jour. */
  offline: boolean;
}

/** Profils visibles : tous pour l'administrateur, ceux de son périmètre (`managerIds`) pour un manager. */
function profilesQuery(role: Role, uid: string): Query {
  const base = collection(db, COL.profiles);
  return role === 'admin' ? base : query(base, where('managerIds', 'array-contains', uid));
}

/**
 * Données du cockpit et de l'écran Équipe : leads du périmètre (même requête que la liste des leads), profils,
 * équipes, présence et comptes. Tout est en temps réel sauf les comptes (lus une fois). Aucune écriture.
 */
export function useCockpitData(role: Role, uid: string): CockpitData {
  const leads = useLeadsList(role, uid);
  const nowMs = useNow(15_000);
  const [users, setUsers] = useState<MainUserView[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileView>>(new Map());
  const [reportCampaigns, setReportCampaigns] = useState<ReportCampaign[]>([]);
  const [spends, setSpends] = useState<ReportSpend[]>([]);
  const [scheduler, setScheduler] = useState<CockpitData['scheduler']>({ lastRunAtMs: null, statusReturn: null });
  const { reports } = useSettings();
  const [presence, setPresence] = useState<Map<string, PresenceView>>(new Map());
  const [pending, setPending] = useState({ users: true, profiles: true, teams: true });
  const [error, setError] = useState<string | null>(null);
  const [syncedAtMs, setSyncedAtMs] = useState<number | null>(null);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!leads.loading) setSyncedAtMs(Date.now());
  }, [leads.items, leads.loading]);

  useEffect(() => {
    const fail = () => setError("Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.");
    const done = (k: keyof typeof pending) => setPending((p) => ({ ...p, [k]: false }));
    const unsubs = [
      onSnapshot(profilesQuery(role, uid), (s) => { setProfiles(new Map(s.docs.map((d) => [d.id, toProfile(d.id, d.data())]))); setSyncedAtMs(Date.now()); done('profiles'); }, () => { fail(); done('profiles'); }),
      onSnapshot(collection(db, COL.campaigns), (s) => setReportCampaigns(s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), sourceId: String(d.get('sourceId') ?? ''), productCode: (d.get('productCode') as string | null) ?? null }))), () => undefined),
      onSnapshot(collection(db, COL.adSpend), (s) => setSpends(s.docs.map((d) => ({ campaignId: String(d.get('campaignId') ?? ''), amountCents: Number(d.get('amountCents') ?? 0), atMs: ms(d.get('date')) ?? ms(d.get('at')) ?? 0 })).filter((x) => x.campaignId && Number.isFinite(x.amountCents))), () => undefined),
      // Lecture secondaire : sans elle, aucune alerte système n'est affichée (jamais une fausse alerte).
      onSnapshot(doc(db, COL.config, 'schedulerStatus'), (s) => setScheduler({ lastRunAtMs: s.exists() ? ms(s.get('lastRunAt')) : null, statusReturn: s.exists() ? parseStatusReturn(s.get('statusReturn')) : null }), () => undefined),
      onSnapshot(collection(db, COL.teams), (s) => { setTeams(s.docs.map((d) => toTeam(d.id, d.data()))); done('teams'); }, () => { fail(); done('teams'); }),
      onSnapshot(
        collection(db, COL.presence),
        (s) => setPresence(new Map(s.docs.map((d) => [d.id, { connected: d.get('connected') === true, lastSeenAtMs: ms(d.get('lastSeenAt')) }]))),
        // La présence est secondaire : sans elle, tout le monde apparaît déconnecté, ce qui est le comportement sûr.
        () => undefined
      ),
    ];
    getDocs(collection(db, 'users'))
      .then((s) => setUsers(s.docs.map((d) => toUser(d.id, d.data()))))
      .catch(() => setError('Impossible de lire la liste des utilisateurs.'))
      .finally(() => done('users'));
    return () => unsubs.forEach((u) => u());
  }, [role, uid]);

  const rows = useMemo(() => buildUserRows(users, profiles, teams, presence, nowMs), [users, profiles, teams, presence, nowMs]);

  return useMemo(
    () => ({ loading: leads.loading || pending.users || pending.profiles || pending.teams, error: leads.error ?? error, items: leads.items, rows, users, names: leads.names, nowMs, reportCampaigns, spends, kpiRules: reports.alerts, scheduler, syncedAtMs, offline }),
    [leads.loading, leads.error, leads.items, leads.names, pending, error, rows, users, nowMs, reportCampaigns, spends, reports.alerts, scheduler, syncedAtMs, offline]
  );
}
