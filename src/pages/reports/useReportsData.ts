import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import type { Role } from '../../domain/enums';
import type { LeadListItem, LeadNames } from '../../domain/leads/leadList';
import type { ReportCampaign, ReportSpend } from '../../domain/reports/direction';
import { ms } from '../../lib/firestoreViews';
import { toCampaign, type CampaignRecord } from '../campaigns/useCampaignsData';
import { useLeadsList } from '../leads/useLeadsData';

export interface ReportsData {
  loading: boolean;
  error: string | null;
  /** Leads du périmètre de l'utilisateur (administrateur : tous ; manager : son équipe), jamais plus que ce que les règles autorisent. */
  leads: LeadListItem[];
  truncated: boolean;
  names: LeadNames;
  campaigns: CampaignRecord[];
  reportCampaigns: ReportCampaign[];
  sources: { id: string; name: string }[];
  spends: ReportSpend[];
}

/** Données des rapports (§22) : lecture seule, rien n'est modifié. Les dépenses et campagnes ne sont lisibles que par le pilotage. */
export function useReportsData(role: Role, uid: string): ReportsData {
  const list = useLeadsList(role, uid);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [spends, setSpends] = useState<ReportSpend[]>([]);
  const [pending, setPending] = useState({ campaigns: true, sources: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = () => setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
    const done = (k: 'campaigns' | 'sources') => setPending((p) => ({ ...p, [k]: false }));
    const unsubs = [
      onSnapshot(collection(db, COL.campaigns), (s) => { setCampaigns(s.docs.map((d) => toCampaign(d.id, d.data()))); done('campaigns'); }, fail),
      onSnapshot(collection(db, COL.sources), (s) => { setSources(s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id) }))); done('sources'); }, fail),
      // Les dépenses sont secondaires : sans elles, les coûts s'affichent « — ».
      onSnapshot(
        collection(db, COL.adSpend),
        (s) => setSpends(s.docs.map((d) => ({ campaignId: String(d.get('campaignId') ?? ''), amountCents: Number(d.get('amountCents') ?? 0), atMs: ms(d.get('date')) ?? ms(d.get('at')) ?? 0 })).filter((x) => x.campaignId && Number.isFinite(x.amountCents))),
        () => undefined
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const reportCampaigns = useMemo<ReportCampaign[]>(() => campaigns.map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId, productCode: c.productCode })), [campaigns]);
  return useMemo(
    () => ({ loading: list.loading || pending.campaigns || pending.sources, error: error ?? list.error, leads: list.items, truncated: list.truncated, names: list.names, campaigns, reportCampaigns, sources, spends }),
    [list, pending, error, campaigns, reportCampaigns, sources, spends]
  );
}
