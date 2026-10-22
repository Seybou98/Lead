// Exports à la demande (§22.10, fig. 34, onglet « Exports »). Fonctions pures : à partir des MÊMES données et des
// MÊMES calculs que les écrans de rapport, elles produisent les lignes d'un fichier. Un export restitue les filtres, les
// colonnes et le mode de date qui l'ont créé (§22.12) : ils figurent en tête du fichier.
//
// Données personnelles : le détail des leads peut être anonymisé (nom remplacé par un identifiant stable, coordonnées et
// adresse retirées). L'export de données directement identifiantes demande une permission distincte, réservée à
// l'administrateur (§22.10, §22.11). Pas de planification ni de diffusion automatique : le CRM n'a aucun canal d'envoi en V1.

import { computeCampaignStats, type CampaignView, type LeadStatView } from '../admin/campaignStats';
import { LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from '../labels';
import { MAIN_STAGE_LABELS, type MainStage } from '../mainSync/mainStatus';
import { outcomeOf, toOutcomeInput } from '../sales/outcome';
import type { Role } from '../enums';
import type { LeadListItem } from '../leads/leadList';
import { buildDirectionReport, DATE_MODE_LABELS, directionRows, scopeLeads, type ReportCampaign, type ReportFilters, type ReportSpend } from './direction';
import { buildDocumentsReport, documentsRows } from './documents';
import { buildProfitReport, PROFIT_DIMS, profitabilityRows } from './profitability';
import { buildQualityReport, QUALITY_DIMS, QUALITY_DIM_LABELS, qualityRows, type QualityDim } from './quality';
import { buildTeleproReport, teleproRows } from './telepros';

export const EXPORT_KINDS = ['direction', 'campaigns', 'telepros', 'documents', 'quality', 'profitability', 'leads'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_KIND_LABELS: Record<ExportKind, string> = {
  direction: 'Rapport Direction',
  campaigns: 'Performance des campagnes',
  telepros: 'Comparaison des télépros',
  documents: 'Performance documentaire',
  quality: 'Qualité des leads',
  profitability: 'Rentabilité (retour sur dépenses)',
  leads: 'Liste des leads',
};

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { csv: 'CSV (ouvre dans Excel)', pdf: 'PDF (impression)' };

// ── Détail des leads ─────────────────────────────────────────────────────────

export interface ExportContext {
  campaignName: (id: string | null) => string;
  sourceName: (campaignId: string | null) => string;
  userName: (id: string | null) => string;
}

export interface LeadColumn {
  key: string;
  label: string;
  /** Donnée directement identifiante : réservée à l'administrateur, retirée d'un export anonymisé. */
  identifying: boolean;
  get: (l: LeadListItem, c: ExportContext) => string | number;
}

// Fuseau de l'entreprise explicite : un export généré par le serveur (UTC) doit afficher les mêmes jours que dans le navigateur.
const TZ = 'Europe/Paris';
const dateOf = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleDateString('fr-FR', { timeZone: TZ }) : '');
const yesNo = (b: boolean): string => (b ? 'oui' : '');

export const LEAD_COLUMNS: readonly LeadColumn[] = [
  { key: 'id', label: 'Identifiant', identifying: false, get: (l) => l.id },
  { key: 'received', label: 'Reçu le', identifying: false, get: (l) => dateOf(l.receivedAtMs) },
  { key: 'campaign', label: 'Campagne', identifying: false, get: (l, c) => c.campaignName(l.campaignId) },
  { key: 'source', label: 'Source', identifying: false, get: (l, c) => c.sourceName(l.campaignId) },
  { key: 'product', label: 'Produit', identifying: false, get: (l) => l.productCode ?? '' },
  { key: 'owner', label: 'Télépro', identifying: false, get: (l, c) => c.userName(l.ownerId) },
  { key: 'status', label: 'Statut', identifying: false, get: (l) => LEAD_STATUS_LABELS[l.status] ?? l.status },
  { key: 'temperature', label: 'Température', identifying: false, get: (l) => (l.temperature ? TEMPERATURE_LABELS[l.temperature] : '') },
  { key: 'documents', label: 'Documents', identifying: false, get: (l) => (l.docs ? `${l.docs.mandatoryConform}/${l.docs.mandatory} obligatoires conformes` : '') },
  { key: 'sale', label: 'Vente', identifying: false, get: (l) => { const o = outcomeOf(toOutcomeInput(l)); return o.cancelled ? 'annulée' : o.net ? 'oui' : ''; } },
  { key: 'mainStage', label: 'Étape du dossier (CRM principal)', identifying: false, get: (l) => (l.mainStatus ? (MAIN_STAGE_LABELS[l.mainStatus.stage as MainStage] ?? l.mainStatus.label) : '') },
  { key: 'closure', label: 'Motif de clôture', identifying: false, get: (l) => l.closure?.label ?? '' },
  { key: 'duplicate', label: 'Doublon', identifying: false, get: (l) => yesNo(l.duplicate) },
  { key: 'excluded', label: 'Exclu', identifying: false, get: (l) => yesNo(l.excluded || l.status === 'fake_lead') },
  { key: 'name', label: 'Nom', identifying: true, get: (l) => l.fullName },
  { key: 'phone', label: 'Téléphone', identifying: true, get: (l) => l.phone ?? '' },
  { key: 'email', label: 'Email', identifying: true, get: (l) => l.email ?? '' },
  { key: 'city', label: 'Ville', identifying: true, get: (l) => l.city },
  { key: 'postalCode', label: 'Code postal', identifying: true, get: (l) => l.postalCode },
];

/** Colonnes cochées par défaut : tout ce qui n'identifie personne. */
export const DEFAULT_LEAD_COLUMNS: readonly string[] = LEAD_COLUMNS.filter((c) => !c.identifying).map((c) => c.key);

/** Identifiant stable et non réversible d'un lead anonymisé (même lead, même identifiant, d'un export à l'autre). */
export function pseudonym(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `Lead-${h.toString(16).toUpperCase().padStart(8, '0').slice(0, 6)}`;
}

/** Peut-on demander des données directement identifiantes ? Permission distincte : administrateur seulement. */
export const canExportIdentifying = (role: Role | null | undefined): boolean => role === 'admin';

export interface ColumnChoice {
  /** Colonnes réellement exportées, dans l'ordre du catalogue. */
  columns: LeadColumn[];
  /** Colonnes demandées mais retirées (anonymisation ou permission), pour le dire à l'utilisateur. */
  dropped: string[];
  /** Le nom est remplacé par un identifiant : l'export est anonymisé. */
  pseudonymize: boolean;
}

export function resolveColumns(selected: readonly string[], opts: { anonymize: boolean; role: Role | null | undefined }): ColumnChoice {
  const allowIdentifying = !opts.anonymize && canExportIdentifying(opts.role);
  const wanted = LEAD_COLUMNS.filter((c) => selected.includes(c.key));
  const columns = wanted.filter((c) => !c.identifying || allowIdentifying);
  const dropped = wanted.filter((c) => !columns.includes(c)).map((c) => c.label);
  // Anonymisé : un identifiant stable remplace le nom, pour pouvoir recouper deux exports sans exposer la personne.
  return { columns, dropped, pseudonymize: opts.anonymize || !canExportIdentifying(opts.role) };
}

/** Leads du détail : reçus pendant la période, dans le périmètre des filtres ; en lecture corrigée, hors doublons, faux leads et exclus. */
export function detailLeads(leads: readonly LeadListItem[], campaigns: readonly ReportCampaign[], f: ReportFilters, raw: boolean): LeadListItem[] {
  return scopeLeads(leads, f, campaigns)
    .filter((l) => l.receivedAtMs >= f.fromMs && l.receivedAtMs < f.toMs)
    .filter((l) => raw || (!l.duplicate && !l.excluded && l.status !== 'fake_lead'))
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.id.localeCompare(b.id));
}

export function leadDetailRows(leads: readonly LeadListItem[], choice: ColumnChoice, ctx: ExportContext): (string | number)[][] {
  const head = choice.pseudonymize ? ['Pseudonyme', ...choice.columns.map((c) => c.label)] : choice.columns.map((c) => c.label);
  return [head, ...leads.map((l) => (choice.pseudonymize ? [pseudonym(l.id), ...choice.columns.map((c) => c.get(l, ctx))] : choice.columns.map((c) => c.get(l, ctx))))];
}

/** Lecture de campagne utilisée par le tableau des campagnes (même mapping que l'écran). */
export const toStatView = (l: LeadListItem): LeadStatView => ({ campaignId: l.campaignId, status: l.status, receivedAtMs: l.receivedAtMs, documentsState: l.documentsState, duplicate: l.duplicate, excluded: l.excluded, commercialState: l.commercialState ?? null, financialState: l.financialState ?? null, mainStage: l.mainStatus?.stage ?? null });

// ── Construction ─────────────────────────────────────────────────────────────

export interface ExportOptions {
  kind: ExportKind;
  /** Données brutes (tous les événements) au lieu des données corrigées. Sans effet sur les rapports qui montrent les deux. */
  raw: boolean;
  /** Joindre le détail des leads au rapport (pour « Liste des leads », le détail est le rapport). */
  detail: boolean;
  anonymize: boolean;
  columns: readonly string[];
  role: Role | null | undefined;
}

export interface ExportInput {
  leads: readonly LeadListItem[];
  reportCampaigns: readonly ReportCampaign[];
  campaigns: readonly CampaignView[];
  spends: readonly ReportSpend[];
  filters: ReportFilters;
  nowMs: number;
  slaMs: number;
  elapsed?: (fromMs: number, toMs: number) => number;
  names: { users: ReadonlyMap<string, string>; campaigns: ReadonlyMap<string, string>; sources: ReadonlyMap<string, string> };
}

export interface BuiltExport {
  kind: ExportKind;
  title: string;
  filename: string;
  /** Lignes du fichier : en-tête des filtres, puis les sections séparées par une ligne vide. */
  rows: (string | number)[][];
  /** Nombre de leads détaillés (0 sans détail). */
  detailCount: number;
  /** Données directement identifiantes incluses ? */
  identifying: boolean;
  /** Colonnes retirées parce que l'export est anonymisé ou que la permission manque. */
  dropped: string[];
  /** Filtres restitués (libellé, valeur), pour l'historique. */
  summary: { label: string; value: string }[];
}

const dayText = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: TZ });

export function filterSummary(f: ReportFilters, input: Pick<ExportInput, 'names' | 'reportCampaigns'>, raw: boolean): { label: string; value: string }[] {
  return [
    { label: 'Période', value: `${dayText(f.fromMs)} au ${dayText(f.toMs - 1)}` },
    { label: 'Mode de date', value: DATE_MODE_LABELS[f.mode] },
    { label: 'Source', value: f.sourceId ? (input.names.sources.get(f.sourceId) ?? f.sourceId) : 'Toutes' },
    { label: 'Produit', value: f.product || 'Tous' },
    { label: 'Télépro', value: f.owner ? (input.names.users.get(f.owner) ?? f.owner) : 'Tous' },
    { label: 'Lecture', value: raw ? 'Données brutes' : 'Données corrigées (hors doublons, faux leads et exclus)' },
  ];
}

/** Le fichier d'un export. Les calculs sont ceux des écrans : un même jeu de filtres donne les mêmes chiffres (§22.12). */
export function buildExport(input: ExportInput, o: ExportOptions): BuiltExport {
  const { filters: f } = input;
  const ctx: ExportContext = {
    campaignName: (id) => (id ? (input.names.campaigns.get(id) ?? id) : 'Sans campagne'),
    sourceName: (id) => {
      const c = id ? input.reportCampaigns.find((x) => x.id === id) : undefined;
      return c ? (input.names.sources.get(c.sourceId) ?? c.sourceId) : '';
    },
    userName: (id) => (id ? (input.names.users.get(id) ?? id) : ''),
  };
  const title = EXPORT_KIND_LABELS[o.kind];
  const summary = filterSummary(f, input, o.raw);
  const modeLabel = DATE_MODE_LABELS[f.mode];

  let body: (string | number)[][] = [];
  switch (o.kind) {
    case 'direction':
      body = directionRows(buildDirectionReport({ leads: input.leads, spends: input.spends, campaigns: input.reportCampaigns, filters: f, nowMs: input.nowMs }), f.mode);
      break;
    case 'campaigns': {
      const campaigns = input.campaigns.filter((c) => (!f.sourceId || c.sourceId === f.sourceId) && (!f.product || c.productCode === f.product));
      const stats = input.leads.filter((l) => (!f.owner || l.ownerId === f.owner) && (!f.product || l.productCode === f.product)).map(toStatView);
      const rows = computeCampaignStats(campaigns, stats, input.spends, { fromMs: f.fromMs, toMs: f.toMs }, o.raw ? 'raw' : 'corrected');
      body = [
        ['Campagne', 'Lecture', 'Dépenses (€)', 'Leads bruts', 'Leads de la lecture', 'CPL (€)', 'Contactés', 'Taux de contact (%)', 'Dossiers complets', 'Ventes nettes', 'Ventes annulées', 'Installées', 'Facturées', 'Coût par vente (€)'],
        ...rows.map((r) => [r.campaign.name, o.raw ? 'Brutes' : 'Corrigées', r.spendCents === null ? '' : r.spendCents / 100, r.gross, r.leads, r.cplCents === null ? '' : r.cplCents / 100, r.contacted, r.contactRate ?? '', r.docsComplete, r.sales, r.cancelled, r.installed, r.invoiced, r.costPerSaleCents === null ? '' : r.costPerSaleCents / 100]),
      ];
      break;
    }
    case 'telepros':
      body = teleproRows(buildTeleproReport({ leads: input.leads, campaigns: input.reportCampaigns, filters: f, nowMs: input.nowMs, slaMs: input.slaMs, elapsed: input.elapsed }), (id) => ctx.userName(id), modeLabel);
      break;
    case 'documents':
      body = documentsRows(buildDocumentsReport({ leads: input.leads, campaigns: input.reportCampaigns, filters: f, nowMs: input.nowMs }), modeLabel);
      break;
    case 'quality': {
      // Les cinq analyses à la suite : un export ne dépend pas de l'onglet qui était ouvert.
      const parts = QUALITY_DIMS.map((dim: QualityDim) => {
        const r = buildQualityReport({ leads: input.leads, campaigns: input.reportCampaigns, filters: f, dim });
        const nameOf = (key: string) => (key === '—' ? 'Non renseigné' : dim === 'source' ? (input.names.sources.get(key) ?? key) : dim === 'campaign' ? (input.names.campaigns.get(key) ?? key) : dim === 'owner' ? (input.names.users.get(key) ?? key) : key);
        return [[`Analyse par ${QUALITY_DIM_LABELS[dim].toLowerCase()}`], ...qualityRows(r, nameOf).slice(2)];
      });
      body = parts.flatMap((p, i) => (i === 0 ? p : [[], ...p]));
      break;
    }
    case 'profitability': {
      // Les quatre découpages à la suite, comme la qualité : un export ne dépend pas de l'onglet ouvert.
      const parts = PROFIT_DIMS.map((dim) => {
        const nameOf = (key: string) => (key === '—' ? 'Non renseigné' : dim === 'source' ? (input.names.sources.get(key) ?? key) : dim === 'campaign' ? (input.names.campaigns.get(key) ?? key) : dim === 'owner' ? (input.names.users.get(key) ?? key) : key);
        return profitabilityRows(buildProfitReport({ leads: input.leads, spends: input.spends, campaigns: input.reportCampaigns, filters: f, dim }), nameOf);
      });
      body = parts.flatMap((p, i) => (i === 0 ? p : [[], ...p]));
      break;
    }
    case 'leads':
      break;
  }

  // Détail des leads : demandé, ou c'est le rapport lui-même.
  const wantDetail = o.detail || o.kind === 'leads';
  const choice = resolveColumns(o.columns, { anonymize: o.anonymize, role: o.role });
  const leads = wantDetail ? detailLeads(input.leads, input.reportCampaigns, f, o.raw) : [];
  const detail = wantDetail ? leadDetailRows(leads, choice, ctx) : [];

  const head: (string | number)[][] = [
    ['Rapport', title],
    ...summary.map((s) => [s.label, s.value]),
    ['Généré le', new Date(input.nowMs).toLocaleString('fr-FR', { timeZone: TZ })],
    ...(wantDetail ? [['Détail des leads', choice.pseudonymize ? 'Anonymisé (pseudonyme, sans coordonnées)' : 'Avec données personnelles'], ['Colonnes', choice.columns.map((c) => c.label).join(', ')]] : []),
    [],
  ];
  const rows = [...head, ...body, ...(wantDetail && body.length > 0 ? [[]] : []), ...(wantDetail ? [['Détail des leads', leads.length], ...detail] : [])];
  const day = new Date(input.nowMs).toISOString().slice(0, 10);
  return {
    kind: o.kind,
    title,
    filename: `export-${o.kind}-${day}`,
    rows,
    detailCount: leads.length,
    identifying: wantDetail && !choice.pseudonymize && choice.columns.some((c) => c.identifying),
    dropped: wantDetail ? choice.dropped : [],
    summary,
  };
}

/** Sections d'un fichier (séparées par une ligne vide) : pour un rendu imprimable. */
export function sectionsOf(rows: readonly (readonly (string | number)[])[]): (readonly (string | number)[])[][] {
  const out: (readonly (string | number)[])[][] = [];
  let cur: (readonly (string | number)[])[] = [];
  for (const r of rows) {
    if (r.length === 0) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

const esc = (v: string | number): string => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** Document HTML imprimable (« Enregistrer au format PDF » du navigateur) : un tableau par section. */
export function printableHtml(title: string, rows: readonly (readonly (string | number)[])[]): string {
  const sections = sectionsOf(rows);
  const table = (sec: (readonly (string | number)[])[], i: number) => {
    const cols = Math.max(...sec.map((r) => r.length));
    const cell = (v: string | number | undefined, tag: 'td' | 'th') => `<${tag}>${v === undefined ? '' : esc(v)}</${tag}>`;
    const head = i > 0 && sec.length > 1 ? `<thead><tr>${Array.from({ length: cols }, (_, c) => cell(sec[0][c], 'th')).join('')}</tr></thead>` : '';
    const body = (i > 0 && sec.length > 1 ? sec.slice(1) : sec).map((r) => `<tr>${Array.from({ length: cols }, (_, c) => cell(r[c], 'td')).join('')}</tr>`).join('');
    return `<table>${head}<tbody>${body}</tbody></table>`;
  };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:12px/1.4 system-ui,sans-serif;color:#0f172a;margin:24px}h1{font-size:18px;margin:0 0 12px}
table{border-collapse:collapse;width:100%;margin:0 0 18px;page-break-inside:auto}tr{page-break-inside:avoid}
th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}
@media print{body{margin:8mm}}</style></head><body><h1>${esc(title)}</h1>${sections.map(table).join('')}</body></html>`;
}
