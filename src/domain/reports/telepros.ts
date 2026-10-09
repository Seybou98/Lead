// Comparaison des télépros (§22.6, fig. 32). Fonctions pures, sans Firestore. Chaque télépro est évalué sur toute sa
// chaîne, avec les MÊMES règles de comptage que le rapport Direction (étapes, modes événement / cohorte, ventes nettes).
//
// Ratios (§22.6) : contact = contactés / valides attribués ; contact → documents = demandés / contactés ;
// documents → complet = complets / demandés ; complet → vente = ventes / complets ; lead → vente = ventes / valides.
// Un dénominateur nul donne « — » (jamais 0 %), et chaque taux porte son volume de référence.
//
// Non couvert, faute de donnée : « jours travaillés » (pas de planning), objectifs (étape suivante), absences
// individuelles. Le SLA ne compte pas les heures hors horaires quand le réglage le demande.

import type { LeadListItem } from '../leads/leadList';
import { ratePct } from '../sales/outcome';
import { countPeriod, MIN_ALERT_VOLUME, scopeLeads, stagePopulation, STAGES, type ReportCampaign, type ReportFilters, type Stage } from './direction';

export interface TeleproRatios {
  contact: number | null;
  contactToDocs: number | null;
  docsToComplete: number | null;
  completeToSale: number | null;
  leadToSale: number | null;
}

export interface TeleproRow {
  ownerId: string;
  /** Leads valides attribués (hors doublons, faux leads, exclus), selon le mode de date. */
  attributed: number;
  counts: Record<Stage, number>;
  /** Leads dont le délai de réaction est connu, et parmi eux ceux traités dans le délai. */
  slaMeasured: number;
  slaRespected: number;
  slaRate: number | null;
  ratios: TeleproRatios;
  /** Volume trop faible pour comparer équitablement (§22.6, §22.8). */
  lowVolume: boolean;
}

export interface TeleproReport {
  rows: TeleproRow[];
  total: TeleproRow;
  minVolume: number;
}

/** Définitions affichées en infobulle (§22.11). */
export const RATIO_DEFINITIONS: Record<keyof TeleproRatios, { label: string; formula: string }> = {
  contact: { label: 'Contact', formula: 'Leads contactés / leads valides attribués.' },
  contactToDocs: { label: 'Contact → documents', formula: 'Documents demandés / leads contactés.' },
  docsToComplete: { label: 'Documents → complet', formula: 'Dossiers complets / demandes documentaires.' },
  completeToSale: { label: 'Complet → vente', formula: 'Ventes nettes / dossiers documentaires complets.' },
  leadToSale: { label: 'Lead → vente', formula: 'Ventes nettes / leads valides attribués.' },
};

export const SLA_DEFINITION = 'Part des leads valides reçus sur la période dont la première prise en charge est intervenue dans le délai du SLA. Un lead non traité compte comme manqué seulement une fois le délai dépassé.';


export function ratiosOf(c: Record<Stage, number>): TeleproRatios {
  return {
    contact: ratePct(c.contacted, c.valid),
    contactToDocs: ratePct(c.docsRequested, c.contacted),
    docsToComplete: ratePct(c.docsComplete, c.docsRequested),
    completeToSale: ratePct(c.sales, c.docsComplete),
    leadToSale: ratePct(c.sales, c.valid),
  };
}

interface SlaTally {
  measured: number;
  respected: number;
}

function slaTally(leads: readonly LeadListItem[], f: ReportFilters, nowMs: number, slaMs: number, elapsed: (fromMs: number, toMs: number) => number): SlaTally {
  const t = { measured: 0, respected: 0 };
  for (const l of leads) {
    if (l.duplicate || l.excluded || l.status === 'fake_lead') continue;
    if (l.receivedAtMs < f.fromMs || l.receivedAtMs >= f.toMs || l.slaStartedAtMs === null) continue;
    if (l.slaStoppedAtMs !== null) {
      t.measured += 1;
      if (elapsed(l.slaStartedAtMs, l.slaStoppedAtMs) <= slaMs) t.respected += 1;
    } else if (elapsed(l.slaStartedAtMs, nowMs) > slaMs) {
      t.measured += 1;
    }
  }
  return t;
}

function rowOf(ownerId: string, leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, nowMs: number, slaMs: number, elapsed: (a: number, b: number) => number): TeleproRow {
  const counts = countPeriod(leads, [], campaigns, f, f.fromMs, f.toMs).counts;
  const sla = slaTally(leads, f, nowMs, slaMs, elapsed);
  return { ownerId, attributed: counts.valid, counts, slaMeasured: sla.measured, slaRespected: sla.respected, slaRate: ratePct(sla.respected, sla.measured), ratios: ratiosOf(counts), lowVolume: counts.valid < MIN_ALERT_VOLUME };
}

export function buildTeleproReport(args: {
  leads: readonly LeadListItem[];
  campaigns: readonly ReportCampaign[];
  filters: ReportFilters;
  nowMs: number;
  slaMs: number;
  /** Temps écoulé entre deux instants (hors horaires non compté si le réglage le demande) ; par défaut, l'écart brut. */
  elapsed?: (fromMs: number, toMs: number) => number;
}): TeleproReport {
  const elapsed = args.elapsed ?? ((a, b) => Math.max(0, b - a));
  const scoped = scopeLeads(args.leads, args.filters, args.campaigns);
  const byOwner = new Map<string, LeadListItem[]>();
  for (const l of scoped) {
    if (!l.ownerId) continue;
    const list = byOwner.get(l.ownerId);
    if (list) list.push(l);
    else byOwner.set(l.ownerId, [l]);
  }
  const rows = [...byOwner.entries()]
    .map(([id, ls]) => rowOf(id, ls, args.campaigns, args.filters, args.nowMs, args.slaMs, elapsed))
    // Un télépro sans aucune activité sur la période n'encombre pas le tableau.
    .filter((r) => STAGES.some((s) => r.counts[s] > 0) || r.slaMeasured > 0)
    .sort((a, b) => b.counts.sales - a.counts.sales || (b.ratios.leadToSale ?? -1) - (a.ratios.leadToSale ?? -1) || b.attributed - a.attributed || a.ownerId.localeCompare(b.ownerId));

  const owned = scoped.filter((l) => l.ownerId && rows.some((r) => r.ownerId === l.ownerId));
  const total = rowOf('', owned, args.campaigns, args.filters, args.nowMs, args.slaMs, elapsed);
  return { rows, total, minVolume: MIN_ALERT_VOLUME };
}

/** Leads qui composent un chiffre d'un télépro : même règle de comptage, donc même total (§22.12). */
export function teleproPopulation(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, ownerId: string, stage: Stage): LeadListItem[] {
  return stagePopulation(leads, campaigns, { ...f, owner: ownerId }, stage);
}

/** CSV : une ligne par télépro, volumes et taux, avec le mode de date. */
export function teleproRows(r: TeleproReport, nameOf: (id: string) => string, modeLabel: string): (string | number)[][] {
  const v = (n: number | null) => (n === null ? '' : n);
  const line = (name: string, x: TeleproRow) => [name, x.attributed, x.slaRate === null ? '' : x.slaRate, x.counts.contacted, x.counts.docsRequested, x.counts.docsComplete, x.counts.sales, v(x.ratios.contact), v(x.ratios.contactToDocs), v(x.ratios.docsToComplete), v(x.ratios.completeToSale), v(x.ratios.leadToSale), x.lowVolume ? 'oui' : ''];
  return [
    ['Mode de date', modeLabel],
    [],
    ['Télépro', 'Leads valides attribués', 'SLA respecté (%)', 'Contactés', 'Documents demandés', 'Dossiers complets', 'Ventes nettes', 'Contact (%)', 'Contact → documents (%)', 'Documents → complet (%)', 'Complet → vente (%)', 'Lead → vente (%)', 'Volume insuffisant'],
    ...r.rows.map((x) => line(nameOf(x.ownerId), x)),
    line('Ensemble', r.total),
  ];
}
