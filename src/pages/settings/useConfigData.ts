import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { ms, strs } from '../../lib/firestoreViews';
import { buildConfigAlerts, productCoverage, type ConfigAlert, type CoverageInput, type ProductCoverage } from '../../domain/settings/center';
import type { AuditRow } from '../../domain/settings/versions';
import { useProductCatalog } from '../products/useProductCatalog';
import { useChecklists } from '../documents/useChecklists';
import { useSettings, type SettingsData } from './useSettings';

export interface ConfigData {
  loading: boolean;
  error: string | null;
  catalog: ReturnType<typeof useProductCatalog>;
  settings: SettingsData;
  checklistCount: number;
  checklistUpdatedAt: Record<string, number | null>;
  coverage: ProductCoverage[];
  alerts: ConfigAlert[];
  /** Journal des enregistrements de configuration (administrateur), du plus récent au plus ancien. */
  audit: AuditRow[];
  /** Nom d'affichage des comptes, pour « par Admin ». */
  userNames: Map<string, string>;
  campaigns: CoverageInput['campaigns'];
  counts: { teams: number; telepros: number; activeCampaigns: number };
}

/** Données du centre de paramétrage : lecture seule, aucune écriture. Réservé à l'administrateur. */
export function useConfigData(): ConfigData {
  const catalog = useProductCatalog();
  const checklists = useChecklists();
  const settings = useSettings();
  const [teams, setTeams] = useState<CoverageInput['teams']>([]);
  const [profiles, setProfiles] = useState<CoverageInput['profiles']>([]);
  const [campaigns, setCampaigns] = useState<CoverageInput['campaigns']>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState({ teams: true, profiles: true, campaigns: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const done = (k: keyof typeof pending) => setPending((p) => ({ ...p, [k]: false }));
    const fail = (k: keyof typeof pending) => () => {
      setError('Lecture refusée ou indisponible. Vérifiez vos droits et les règles Firestore.');
      done(k);
    };
    const unsubs = [
      onSnapshot(collection(db, COL.teams), (s) => { setTeams(s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), active: d.get('active') !== false, productCodes: strs(d.get('productCodes')) }))); done('teams'); }, fail('teams')),
      onSnapshot(collection(db, COL.profiles), (s) => { setProfiles(s.docs.map((d) => ({ uid: d.id, productCodes: strs(d.get('scope')?.productCodes) }))); done('profiles'); }, fail('profiles')),
      onSnapshot(collection(db, COL.campaigns), (s) => { setCampaigns(s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), status: String(d.get('status') ?? 'draft'), productCode: typeof d.get('productCode') === 'string' ? (d.get('productCode') as string) : null }))); done('campaigns'); }, fail('campaigns')),
      // Le journal est secondaire : sans lui, les versions et les modifications récentes sont vides, rien d'autre ne casse.
      onSnapshot(
        query(collection(db, COL.audit), orderBy('at', 'desc'), limit(300)),
        (s) =>
          setAudit(
            s.docs.map((d) => ({ id: d.id, atMs: ms(d.get('at')) ?? 0, actorId: String(d.get('actorId') ?? ''), action: String(d.get('action') ?? ''), entityType: String(d.get('entityType') ?? ''), entityId: String(d.get('entityId') ?? ''), before: d.get('before') ?? null, after: d.get('after') ?? null, reason: (d.get('reason') as string | null) ?? null }))
          ),
        () => undefined
      ),
    ];
    getDocs(collection(db, 'users'))
      .then((s) => setUserNames(new Map(s.docs.map((d) => [d.id, String(d.get('name') || d.get('displayName') || d.get('email') || d.id)]))))
      .catch(() => undefined);
    return () => unsubs.forEach((u) => u());
  }, []);

  const input: CoverageInput = useMemo(() => ({ categories: catalog.categories.map((c) => c.code), checklists: checklists.byKey, teams, profiles, campaigns }), [catalog.categories, checklists.byKey, teams, profiles, campaigns]);
  const coverage = useMemo(() => productCoverage(input), [input]);
  const alerts = useMemo(() => buildConfigAlerts(input, { sla: settings.sla, settingsSaved: settings.saved }), [input, settings.sla, settings.saved]);

  return {
    loading: catalog.loading || checklists.loading || settings.loading || pending.teams || pending.profiles || pending.campaigns,
    error: error ?? (catalog.error ? 'Le catalogue produits est illisible.' : null),
    catalog,
    settings,
    checklistCount: Object.keys(checklists.byKey).length,
    checklistUpdatedAt: checklists.updatedAt,
    coverage,
    alerts,
    audit,
    userNames,
    campaigns,
    counts: { teams: teams.filter((t) => t.active).length, telepros: profiles.length, activeCampaigns: campaigns.filter((c) => c.status === 'active').length },
  };
}
