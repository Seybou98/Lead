import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, onSnapshot, query, Timestamp, where, type DocumentData } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { CampaignStatus, DocumentState, LeadStatus } from '../../domain/enums';
import type { CampaignView, LeadStatView, SpendView } from '../../domain/admin/campaignStats';
import type { MainUserView, TeamView } from '../../domain/admin/userRows';
import { ms, strs, toTeam, toUser } from '../../lib/firestoreViews';

/** Au-delà, les statistiques seraient incomplètes : l'écran le dit au lieu de se tromper en silence. */
export const LEAD_READ_LIMIT = 5000;

export interface CampaignRecord extends CampaignView {
  eligibleTeamIds: string[];
  eligibleUserIds: string[];
  fallbackTeamId: string | null;
  maxReassignments: number | null;
  startsAtMs: number | null;
  endsAtMs: number | null;
  /** Règles d'attribution propres à la campagne déjà enregistrées. */
  assignmentConfig: Record<string, unknown> | null;
  autoEligible: boolean;
  receptionSchedule: { timezone: string; weekly: { day: number; start: string; end: string }[] } | null;
}

export interface SourceRecord {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

export function toCampaign(id: string, d: DocumentData): CampaignRecord {
  return {
    id,
    name: d.name ?? id,
    sourceId: d.sourceId ?? '',
    externalId: d.externalId ?? null,
    productCode: d.productCode ?? null,
    zones: strs(d.zones),
    status: (d.status ?? 'draft') as CampaignStatus,
    budgetCents: typeof d.budgetCents === 'number' ? d.budgetCents : null,
    eligibleTeamIds: strs(d.eligibleTeamIds),
    eligibleUserIds: strs(d.eligibleUserIds),
    fallbackTeamId: d.fallbackTeamId ?? null,
    maxReassignments: typeof d.maxReassignments === 'number' ? d.maxReassignments : null,
    startsAtMs: ms(d.startsAt),
    endsAtMs: ms(d.endsAt),
    assignmentConfig: d.assignmentConfig && typeof d.assignmentConfig === 'object' ? (d.assignmentConfig as Record<string, unknown>) : null,
    autoEligible: d.autoEligible === true,
    receptionSchedule:
      d.receptionSchedule && Array.isArray(d.receptionSchedule.weekly)
        ? { timezone: d.receptionSchedule.timezone ?? 'Europe/Paris', weekly: d.receptionSchedule.weekly }
        : null,
  };
}

function toLead(d: DocumentData): LeadStatView | null {
  const receivedAtMs = ms(d.origin?.receivedAt);
  if (receivedAtMs === null) return null;
  return {
    campaignId: d.origin?.campaignId ?? null,
    status: (d.status ?? 'new') as LeadStatus,
    receivedAtMs,
    documentsState: (d.documents?.state ?? 'none') as DocumentState,
    duplicate: !!d.quality?.duplicateOf,
    excluded: d.quality?.excluded === true,
  };
}

export interface CampaignsData {
  loading: boolean;
  error: string | null;
  campaigns: CampaignRecord[];
  sources: SourceRecord[];
  teams: TeamView[];
  users: MainUserView[];
  leads: LeadStatView[];
  /** true si la limite de lecture est atteinte : les chiffres sont alors partiels. */
  leadsTruncated: boolean;
  spend: SpendView[];
  reloadUsers: () => void;
}

export function useCampaignsData(fromMs: number | null): CampaignsData {
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [users, setUsers] = useState<MainUserView[]>([]);
  const [leads, setLeads] = useState<LeadStatView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [spend, setSpend] = useState<SpendView[]>([]);
  const [pending, setPending] = useState({ campaigns: true, sources: true, teams: true, leads: true });
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const fail = () => setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
    const done = (k: keyof typeof pending) => setPending((p) => ({ ...p, [k]: false }));
    const unsubs = [
      onSnapshot(collection(db, COL.campaigns), (s) => { setCampaigns(s.docs.map((d) => toCampaign(d.id, d.data()))); done('campaigns'); }, fail),
      onSnapshot(collection(db, COL.sources), (s) => { setSources(s.docs.map((d) => ({ id: d.id, name: d.get('name') ?? d.id, kind: d.get('kind') ?? 'manual', enabled: d.get('enabled') !== false }))); done('sources'); }, fail),
      onSnapshot(collection(db, COL.teams), (s) => { setTeams(s.docs.map((d) => toTeam(d.id, d.data()))); done('teams'); }, fail),
      onSnapshot(
        collection(db, COL.adSpend),
        (s) =>
          setSpend(
            s.docs
              .map((d) => ({ id: d.id, note: (d.get('note') as string | null) ?? null, campaignId: String(d.get('campaignId') ?? ''), amountCents: Number(d.get('amountCents') ?? 0), atMs: ms(d.get('date')) ?? ms(d.get('at')) ?? 0 }))
              .filter((x) => x.campaignId && Number.isFinite(x.amountCents))
          ),
        () => undefined // les dépenses sont secondaires : sans elles, les coûts s'affichent « — »
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    getDocs(collection(db, 'users')).then((s) => setUsers(s.docs.map((d) => toUser(d.id, d.data())))).catch(() => undefined);
  }, [reloadKey]);

  // Leads : bornés par la période (borne basse côté serveur, le reste est filtré côté client).
  useEffect(() => {
    setPending((p) => ({ ...p, leads: true }));
    const base = collection(db, COL.leads);
    const q = fromMs === null ? query(base, limit(LEAD_READ_LIMIT)) : query(base, where('origin.receivedAt', '>=', Timestamp.fromMillis(fromMs)), limit(LEAD_READ_LIMIT));
    return onSnapshot(
      q,
      (s) => {
        setLeads(s.docs.map((d) => toLead(d.data())).filter((l): l is LeadStatView => l !== null));
        setTruncated(s.size >= LEAD_READ_LIMIT);
        setPending((p) => ({ ...p, leads: false }));
      },
      () => {
        setError('Lecture des leads refusée ou indisponible.');
        setPending((p) => ({ ...p, leads: false }));
      }
    );
  }, [fromMs]);

  return useMemo(
    () => ({
      loading: Object.values(pending).some(Boolean),
      error,
      campaigns,
      sources,
      teams,
      users,
      leads,
      leadsTruncated: truncated,
      spend,
      reloadUsers: () => setReloadKey((k) => k + 1),
    }),
    [pending, error, campaigns, sources, teams, users, leads, truncated, spend]
  );
}
