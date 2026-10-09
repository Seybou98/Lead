import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { catalogOf, DEFAULT_REASON_SETTINGS, parseReasonSettings, type ReasonCatalog, type ReasonSettings } from '../../domain/settings/reasons';
import { DEFAULT_CONVERSION_SETTINGS, DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS, parseConversionSettings, parseRulesSettings, parseSlaOverride, parseSlaSettings, type ConversionSettings, type RulesSettings, type SlaOverride, type SlaSettings } from '../../domain/settings/settings';
import { setSlaRuntime } from '../../domain/leads/leadList';
import { scheduleOf } from '../../domain/settings/runtime';
import { ms } from '../../lib/firestoreViews';

export interface SettingsData {
  loading: boolean;
  error: boolean;
  sla: SlaSettings;
  rules: RulesSettings;
  /** Verrous et exceptions de conversion (remise maximale, éligibilité, RGE, consentement). */
  conversion: ConversionSettings;
  /** Motifs et listes administrables, et le catalogue que lisent la qualification et le contrôle des pièces. */
  reasons: ReasonSettings;
  reasonCatalog: ReasonCatalog;
  /** Règle de réattribution propre à chaque campagne (cl_settings/sla_<campagne>). */
  overrides: Record<string, SlaOverride>;
  /** Un réglage a-t-il déjà été enregistré ? Sinon on montre les valeurs du cahier, non encore choisies. */
  saved: { sla: boolean; rules: boolean; conversion: boolean; reasons: boolean };
  updatedAtMs: { sla: number | null; rules: number | null; conversion: number | null; reasons: number | null };
}

const EMPTY: SettingsData = { loading: true, error: false, sla: DEFAULT_SLA_SETTINGS, rules: DEFAULT_RULES_SETTINGS, conversion: DEFAULT_CONVERSION_SETTINGS, reasons: DEFAULT_REASON_SETTINGS, reasonCatalog: catalogOf(DEFAULT_REASON_SETTINGS), overrides: {}, saved: { sla: false, rules: false, conversion: false, reasons: false }, updatedAtMs: { sla: null, rules: null, conversion: null, reasons: null } };

/** Réglages d'administration en temps réel (cl_settings), lisibles par tout le personnel. */
export function useSettings(): SettingsData {
  const [state, setState] = useState<SettingsData>(EMPTY);
  useEffect(
    () =>
      onSnapshot(
        collection(db, COL.settings),
        (s) => {
          const byId = new Map(s.docs.map((d) => [d.id, d]));
          const sla = byId.get('sla');
          const rules = byId.get('rules');
          const conversion = byId.get('conversion');
          const reasonsDoc = byId.get('reasons');
          const reasons = parseReasonSettings(reasonsDoc?.data());
          const overrides: Record<string, SlaOverride> = {};
          for (const d of s.docs) if (d.id.startsWith('sla_')) overrides[d.id.slice(4)] = parseSlaOverride(d.data());
          setState({
            loading: false,
            error: false,
            sla: parseSlaSettings(sla?.data()),
            rules: parseRulesSettings(rules?.data()),
            conversion: parseConversionSettings(conversion?.data()),
            reasons,
            reasonCatalog: catalogOf(reasons),
            overrides,
            saved: { sla: !!sla, rules: !!rules, conversion: !!conversion, reasons: !!reasonsDoc },
            updatedAtMs: { sla: ms(sla?.get('updatedAt')), rules: ms(rules?.get('updatedAt')), conversion: ms(conversion?.get('updatedAt')), reasons: ms(reasonsDoc?.get('updatedAt')) },
          });
        },
        // Sans lecture, les valeurs du cahier s'appliquent : rien ne se bloque.
        () => setState((p) => ({ ...p, loading: false, error: true }))
      ),
    []
  );
  return state;
}

/**
 * Applique les réglages généraux aux compteurs du navigateur (délai du SLA, SLA suspendu hors horaires). À monter une
 * fois, haut dans l'arbre : tous les écrans qui affichent un âge de lead lisent alors la même valeur.
 */
export function useSlaRuntimeSync(): void {
  const { sla, loading } = useSettings();
  const runtime = useMemo(() => ({ slaMs: sla.firstAlertMin * 60_000, suspendOutsideHours: sla.suspendOutsideHours, schedule: scheduleOf(sla) }), [sla]);
  useEffect(() => {
    if (!loading) setSlaRuntime(runtime);
  }, [runtime, loading]);
}
