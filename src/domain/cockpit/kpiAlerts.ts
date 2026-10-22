// Alertes KPI dans le cockpit manager (§12.6, §22.8). Les règles sont celles réglées dans Paramètres → Objectifs et alertes,
// évaluées avec les MÊMES fonctions que le rapport Direction, sur le périmètre filtré du cockpit. Fonction pure.
//
// Fenêtre : les indicateurs statistiques (coût par vente, taux de contact…) n'ont pas de sens sur une seule journée ; le
// cockpit les évalue sur 7 jours glissants, ou 30 jours quand la période du cockpit est « 30 derniers jours ».
//
// Dépenses : une dépense se rattache à une campagne, pas à une équipe ni à une zone. Avec un filtre d'équipe ou de zone, les
// dépenses ne sont pas attribuables : les règles de coût ne se déclenchent pas (jamais de coût inventé).

import type { LeadListItem } from '../leads/leadList';
import { buildDirectionReport, type ReportCampaign, type ReportSpend } from '../reports/direction';
import { alertInputs, evaluateAlerts, type AlertRule, type KpiAlert } from '../reports/targets';
import type { CockpitFilters } from './filters';
import type { Period } from './cockpit';

const DAY = 86_400_000;

export const KPI_WINDOW_DAYS: Record<Period, number> = { today: 7, week: 7, month: 30 };

export interface CockpitKpiAlerts {
  alerts: KpiAlert[];
  windowDays: number;
  /** Les dépenses ne sont pas attribuables au périmètre (filtre d'équipe ou de zone) : les règles de coût sont muettes. */
  spendUnavailable: boolean;
}

export function cockpitKpiAlerts(args: {
  rules: readonly AlertRule[];
  /** Leads déjà filtrés par le cockpit (équipe, produit, campagne, zone). */
  leads: readonly LeadListItem[];
  spends: readonly ReportSpend[];
  campaigns: readonly ReportCampaign[];
  filters: CockpitFilters;
  period: Period;
  nowMs: number;
  slaMs: number;
  elapsed?: (fromMs: number, toMs: number) => number;
}): CockpitKpiAlerts {
  const windowDays = KPI_WINDOW_DAYS[args.period];
  const spendUnavailable = !!(args.filters.team || args.filters.zone);
  const f = { fromMs: args.nowMs - windowDays * DAY, toMs: args.nowMs, mode: 'event' as const, sourceId: '', campaignId: args.filters.campaign, product: args.filters.product, owner: '' };
  const spends = spendUnavailable ? [] : args.spends;
  const report = buildDirectionReport({ leads: args.leads, spends, campaigns: args.campaigns, filters: f, nowMs: args.nowMs });
  const all = evaluateAlerts(args.rules, alertInputs({ current: report.current, previous: report.previous, leads: args.leads, campaigns: args.campaigns, filters: f, nowMs: args.nowMs, slaMs: args.slaMs, elapsed: args.elapsed }));
  // « Aucune alerte » est une information de rapport, pas une alerte de cockpit.
  const alerts = all.filter((a) => a.level !== 'ok').sort((a, b) => Number(b.level === 'critical') - Number(a.level === 'critical'));
  return { alerts, windowDays, spendUnavailable };
}
