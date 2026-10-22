import { describe, expect, it } from 'vitest';
import { buildExport, canExportIdentifying, DEFAULT_LEAD_COLUMNS, detailLeads, EXPORT_KINDS, filterSummary, LEAD_COLUMNS, printableHtml, pseudonym, resolveColumns, sectionsOf, type ExportInput, type ExportOptions } from './exports';
import { buildDirectionReport, directionRows } from './direction';
import { buildTeleproReport, teleproRows } from './telepros';
import { camps, docs, F, lead, NOW, sold, T } from './reportsFixtures';
import type { CampaignView } from '../admin/campaignStats';

const names = { users: new Map([['u1', 'Sarah Cohen'], ['u2', 'Mehdi Benali']]), campaigns: new Map([['c1', 'PAC IDF']]), sources: new Map([['meta', 'Meta']]) };
const campaignViews = [{ id: 'c1', name: 'PAC IDF', sourceId: 'meta', productCode: 'PAC', status: 'active', budgetCents: null }] as unknown as CampaignView[];
const people = (id: string, over = {}) => lead(id, { fullName: `Nom ${id}`, phone: '+33612345678', email: `${id}@x.fr`, city: 'Lyon', postalCode: '69003', ...over });
const LEADS = [sold('s1', { fullName: 'Jean Dupont', phone: '+33611111111', email: 'jean@x.fr', city: 'Lyon', postalCode: '69003' }), people('n1', { status: 'nr', ownerId: 'u2' }), people('d1', { duplicate: true }), people('f1', { status: 'fake_lead', excluded: true }), people('old', { receivedAtMs: T(2026, 6, 1) })];
const input = (over: Partial<ExportInput> = {}): ExportInput => ({ leads: LEADS, reportCampaigns: camps, campaigns: campaignViews, spends: [{ campaignId: 'c1', amountCents: 100_000, atMs: T(2026, 9, 3) }], filters: F, nowMs: NOW, slaMs: 5 * 60_000, names, ...over });
const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({ kind: 'leads', raw: false, detail: false, anonymize: true, columns: DEFAULT_LEAD_COLUMNS, role: 'admin', ...over });
const flat = (rows: (string | number)[][]) => rows.map((r) => r.join('|')).join('\n');

describe('pseudonyme', () => {
  it('stable, de forme fixe, distinct d’un lead à l’autre, sans l’identifiant', () => {
    expect(pseudonym('L1')).toBe(pseudonym('L1'));
    expect(pseudonym('L1')).toMatch(/^Lead-[0-9A-F]{6}$/);
    expect(pseudonym('L1')).not.toBe(pseudonym('L2'));
    expect(pseudonym('abc')).not.toContain('abc');
  });
});

describe('permission et colonnes', () => {
  it('données identifiantes : administrateur seulement', () => {
    expect(canExportIdentifying('admin')).toBe(true);
    expect(canExportIdentifying('manager')).toBe(false);
    expect(canExportIdentifying('telepro')).toBe(false);
    expect(canExportIdentifying(null)).toBe(false);
  });
  it('colonnes par défaut : aucune donnée identifiante', () => {
    expect(LEAD_COLUMNS.filter((c) => DEFAULT_LEAD_COLUMNS.includes(c.key)).some((c) => c.identifying)).toBe(false);
  });
  const all = LEAD_COLUMNS.map((c) => c.key);
  it('administrateur sans anonymisation : toutes les colonnes demandées, nom réel', () => {
    const c = resolveColumns(all, { anonymize: false, role: 'admin' });
    expect(c.columns).toHaveLength(all.length);
    expect(c.pseudonymize).toBe(false);
    expect(c.dropped).toEqual([]);
  });
  it('anonymisation : les colonnes identifiantes sont retirées et dites retirées', () => {
    const c = resolveColumns(all, { anonymize: true, role: 'admin' });
    expect(c.columns.some((x) => x.identifying)).toBe(false);
    expect(c.pseudonymize).toBe(true);
    expect(c.dropped).toEqual(['Nom', 'Téléphone', 'Email', 'Ville', 'Code postal']);
  });
  it('manager : jamais de données identifiantes, même sans anonymisation demandée', () => {
    const c = resolveColumns(all, { anonymize: false, role: 'manager' });
    expect(c.columns.some((x) => x.identifying)).toBe(false);
    expect(c.pseudonymize).toBe(true);
    expect(c.dropped.length).toBe(5);
  });
  it('ordre du catalogue, colonnes inconnues ignorées', () => {
    expect(resolveColumns(['status', 'id', 'inconnue'], { anonymize: true, role: 'admin' }).columns.map((c) => c.key)).toEqual(['id', 'status']);
  });
});

describe('détail des leads', () => {
  it('lecture corrigée : reçus dans la période, hors doublons, faux leads et exclus', () => {
    expect(detailLeads(LEADS, camps, F, false).map((l) => l.id).sort()).toEqual(['n1', 's1']);
  });
  it('lecture brute : tout ce qui a été reçu dans la période', () => {
    expect(detailLeads(LEADS, camps, F, true).map((l) => l.id).sort()).toEqual(['d1', 'f1', 'n1', 's1']);
  });
  it('filtres de périmètre respectés', () => {
    expect(detailLeads(LEADS, camps, { ...F, owner: 'u2' }, true).map((l) => l.id)).toEqual(['n1']);
  });
  it('ordre chronologique puis identifiant', () => {
    const a = people('b', { receivedAtMs: T(2026, 9, 7) });
    const b = people('a', { receivedAtMs: T(2026, 9, 7) });
    const c = people('c', { receivedAtMs: T(2026, 9, 2) });
    expect(detailLeads([a, b, c], camps, F, true).map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('un export restitue ses filtres et son mode de date (§22.12)', () => {
  it('en-tête : rapport, période, mode, source, produit, télépro, lecture, date', () => {
    const e = buildExport(input({ filters: { ...F, mode: 'cohort', sourceId: 'meta', product: 'PAC', owner: 'u1' } }), opts({ kind: 'direction', raw: true }));
    const text = flat(e.rows);
    expect(text).toContain('Rapport|Rapport Direction');
    expect(text).toContain('Mode de date|Cohorte d’acquisition');
    expect(text).toContain('Source|Meta');
    expect(text).toContain('Produit|PAC');
    expect(text).toContain('Télépro|Sarah Cohen');
    expect(text).toContain('Lecture|Données brutes');
    expect(text).toContain('Période|01/09/2026 au 30/09/2026');
    expect(e.summary.map((s) => s.label)).toEqual(['Période', 'Mode de date', 'Source', 'Produit', 'Télépro', 'Lecture']);
  });
  it('sans filtre : « Toutes », « Tous »', () => {
    const s = filterSummary(F, input(), false);
    expect(s.find((x) => x.label === 'Source')?.value).toBe('Toutes');
    expect(s.find((x) => x.label === 'Produit')?.value).toBe('Tous');
    expect(s.find((x) => x.label === 'Télépro')?.value).toBe('Tous');
  });
});

describe('cohérence avec les écrans (§22.12)', () => {
  it('Direction : les lignes de l’écran, telles quelles', () => {
    const screen = directionRows(buildDirectionReport({ leads: LEADS, spends: input().spends, campaigns: camps, filters: F, nowMs: NOW }), F.mode);
    const e = buildExport(input(), opts({ kind: 'direction' }));
    expect(flat(e.rows)).toContain(flat(screen));
  });
  it('Télépros : mêmes lignes que l’écran', () => {
    const screen = teleproRows(buildTeleproReport({ leads: LEADS, campaigns: camps, filters: F, nowMs: NOW, slaMs: 5 * 60_000 }), (id) => names.users.get(id) ?? id, 'Date d’événement');
    expect(flat(buildExport(input(), opts({ kind: 'telepros' })).rows)).toContain(flat(screen));
  });
  it('Campagnes : lecture corrigée ou brute annoncée dans chaque ligne', () => {
    expect(flat(buildExport(input(), opts({ kind: 'campaigns', raw: false })).rows)).toContain('PAC IDF|Corrigées');
    expect(flat(buildExport(input(), opts({ kind: 'campaigns', raw: true })).rows)).toContain('PAC IDF|Brutes');
  });
  it('Documents : contient les étapes et les goulots', () => {
    const t = flat(buildExport(input(), opts({ kind: 'documents' })).rows);
    expect(t).toContain('Documents demandés');
    expect(t).toContain('Dossiers complets');
  });
  it('Qualité : les cinq analyses, noms lisibles', () => {
    const t = flat(buildExport(input(), opts({ kind: 'quality' })).rows);
    for (const dim of ['source', 'campagne', 'produit', 'zone', 'télépro']) expect(t).toContain(`Analyse par ${dim}`);
    expect(t).toContain('Meta');
    expect(t).toContain('Sarah Cohen');
  });
  it('Rentabilité : les quatre découpages, noms lisibles, dépenses en euros', () => {
    const t = flat(buildExport(input(), opts({ kind: 'profitability' })).rows);
    for (const dim of ['campagne', 'source', 'produit', 'télépro']) expect(t).toContain(`Rentabilité par ${dim}`);
    expect(t).toContain('PAC IDF');
    expect(t).toContain('Ensemble');
    expect(t).toContain('1000');
  });
  it('tous les types d’export se construisent', () => {
    for (const kind of EXPORT_KINDS) expect(() => buildExport(input(), opts({ kind }))).not.toThrow();
  });
});

describe('détail et données personnelles', () => {
  it('« Liste des leads » : le détail EST le rapport, nombre de leads annoncé', () => {
    const e = buildExport(input(), opts({ kind: 'leads' }));
    expect(e.detailCount).toBe(2);
    expect(flat(e.rows)).toContain('Détail des leads|2');
  });
  it('un rapport avec détail : le détail suit, séparé par une ligne vide', () => {
    const e = buildExport(input(), opts({ kind: 'documents', detail: true }));
    expect(e.detailCount).toBe(2);
    expect(e.rows.some((r) => r[0] === 'Détail des leads' && r[1] === 2)).toBe(true);
  });
  it('sans détail : aucune ligne de lead', () => {
    const e = buildExport(input(), opts({ kind: 'direction', detail: false }));
    expect(e.detailCount).toBe(0);
    expect(flat(e.rows)).not.toContain('Pseudonyme');
  });
  it('anonymisé : ni nom, ni téléphone, ni email, ni ville ; pseudonyme à la place', () => {
    const e = buildExport(input(), opts({ columns: LEAD_COLUMNS.map((c) => c.key), anonymize: true }));
    const t = flat(e.rows);
    for (const secret of ['Jean Dupont', '+33611111111', 'jean@x.fr', 'Lyon', '69003']) expect(t).not.toContain(secret);
    expect(t).toContain(pseudonym('s1'));
    expect(e.identifying).toBe(false);
    expect(e.dropped).toContain('Téléphone');
  });
  it('administrateur sans anonymisation : données réelles et export signalé « identifiant »', () => {
    const e = buildExport(input(), opts({ columns: LEAD_COLUMNS.map((c) => c.key), anonymize: false }));
    const t = flat(e.rows);
    expect(t).toContain('Jean Dupont');
    expect(t).toContain('+33611111111');
    expect(e.identifying).toBe(true);
    expect(flat(e.rows)).toContain('Détail des leads|Avec données personnelles');
  });
  it('manager qui demande les données réelles : refusées, anonymisé quand même', () => {
    const e = buildExport(input(), opts({ columns: LEAD_COLUMNS.map((c) => c.key), anonymize: false, role: 'manager' }));
    const t = flat(e.rows);
    expect(t).not.toContain('Jean Dupont');
    expect(t).not.toContain('+33611111111');
    expect(e.identifying).toBe(false);
    expect(e.dropped.length).toBe(5);
  });
  it('vente et motif de clôture dans le détail', () => {
    const closed = people('cl', { status: 'not_interested', closure: { kind: 'not_interested', code: 'price', label: 'Prix' } });
    const e = buildExport(input({ leads: [sold('s1'), closed] }), opts({ columns: ['id', 'sale', 'closure', 'status'] }));
    const t = flat(e.rows);
    expect(t).toContain('|s1|Converti|oui|');
    expect(t).toContain('|cl|Non intéressé||Prix');
  });
  it('dossier incomplet : documents conformes / obligatoires', () => {
    const l = lead('dd', { documentsState: 'partial', docs: docs({ mandatory: 4, mandatoryConform: 2 }) });
    expect(flat(buildExport(input({ leads: [l] }), opts({ columns: ['id', 'documents'] })).rows)).toContain("|dd|2/4 obligatoires conformes");
  });
});

describe('rendu imprimable', () => {
  it('sections séparées par une ligne vide', () => {
    expect(sectionsOf([['a', 1], ['b', 2], [], ['c', 3], [], []])).toEqual([[['a', 1], ['b', 2]], [['c', 3]]]);
  });
  it('un tableau par section, en-têtes pour les sections de données, HTML échappé', () => {
    const html = printableHtml('Rapport <test>', [['Rapport', 'A & B'], [], ['Col 1', 'Col 2'], ['x<script>', 2]]);
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html).toContain('<th>Col 1</th>');
    expect(html).toContain('x&lt;script&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<title>Rapport &lt;test&gt;</title>');
  });
  it('lignes de longueurs différentes : cellules vides, pas d’erreur', () => {
    expect(() => printableHtml('t', [['a'], ['b', 'c', 'd']])).not.toThrow();
  });
});
