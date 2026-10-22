import { describe, expect, it } from 'vitest';
import { alertInputs, coerceReportInput, DEFAULT_ALERT_RULES, DEFAULT_REPORT_SETTINGS, evaluateAlerts, monthKey, monthRange, objectiveProgress, objectivesFor, parseReportSettings, ruleText, singleMonthOf, toStoredReports, validateReportSettings, type AlertInputs, type AlertRule, type Objective, type ReportSettings } from './targets';
import type { PeriodCounts } from './direction';
import { camps, docs, F, lead, NOW, SEP, sold, T } from './reportsFixtures';

const counts = (over: Partial<PeriodCounts['counts']> = {}, extra: Partial<PeriodCounts> = {}): PeriodCounts => ({
  counts: { received: 0, valid: 0, contacted: 0, interested: 0, docsRequested: 0, docsComplete: 0, mounted: 0, sales: 0, ...over },
  cancelled: 0, installed: 0, invoiced: 0, spendCents: null, ...extra,
});
const rule = (over: Partial<AlertRule> = {}): AlertRule => ({ id: 'a_x', metric: 'costPerSale', mode: 'value', op: 'gt', threshold: 500, minVolume: 10, days: 7, level: 'warning', active: true, ...over });
const inputs = (cur: PeriodCounts, prev: PeriodCounts = counts(), over: Partial<AlertInputs> = {}): AlertInputs => ({ cur, prev, sla: { measured: 0, respected: 0 }, prevSla: { measured: 0, respected: 0 }, blocked: () => 0, ...over });
const obj = (over: Partial<Objective> = {}): Objective => ({ id: 'o_1', month: '2026-09', scope: 'global', scopeId: '', metric: 'sales', target: 10, active: true, ...over });

describe('réglages : lecture tolérante', () => {
  it('rien d’enregistré : alertes d’origine, aucun objectif', () => {
    expect(parseReportSettings(undefined)).toEqual(DEFAULT_REPORT_SETTINGS);
    expect(parseReportSettings({})).toEqual(DEFAULT_REPORT_SETTINGS);
    expect(DEFAULT_REPORT_SETTINGS.alerts.map((a) => a.id)).toEqual(DEFAULT_ALERT_RULES.map((a) => a.id));
  });
  it('document enregistré mais vide : plus aucune alerte (l’administrateur les a retirées)', () => {
    expect(parseReportSettings({ alerts: [], objectives: [] })).toEqual({ alerts: [], objectives: [] });
  });
  it('ignore ce qui est mal formé : indicateur inconnu, identifiant invalide, seuil absent, doublon', () => {
    const s = parseReportSettings({ alerts: [rule(), { ...rule(), id: 'a_x' }, { ...rule(), id: 'pas bon' }, { ...rule(), id: 'a_y', metric: 'inconnu' }, { ...rule(), id: 'a_z', threshold: 'x' }, 'texte', null], objectives: [obj(), { ...obj(), id: 'o_2', month: '2026-13' }, { ...obj(), id: 'o_3', scope: 'campaign', scopeId: '' }, { ...obj(), id: 'o_4', target: Number.NaN }] });
    expect(s.alerts.map((a) => a.id)).toEqual(['a_x']);
    expect(s.objectives.map((o) => o.id)).toEqual(['o_1']);
  });
  it('une variation n’est pas permise pour les dossiers bloqués : retombe sur la valeur', () => {
    expect(parseReportSettings({ alerts: [rule({ metric: 'blockedDossiers', mode: 'change' })] }).alerts[0].mode).toBe('value');
  });
  it('aller-retour sans perte', () => {
    const s: ReportSettings = { alerts: [rule(), rule({ id: 'a_y', metric: 'slaRate', op: 'lt', threshold: 85, minVolume: 20 })], objectives: [obj(), obj({ id: 'o_2', scope: 'owner', scopeId: 'u1', target: 30, metric: 'contacted' })] };
    expect(parseReportSettings(JSON.parse(JSON.stringify(toStoredReports(s))))).toEqual(s);
  });
});

describe('réglages : validation', () => {
  const ok = (): ReportSettings => ({ alerts: [rule()], objectives: [obj()] });
  it('réglage valide', () => expect(validateReportSettings(ok())).toEqual([]));
  it('la saisie n’est jamais corrigée en silence', () => {
    const c = coerceReportInput({ alerts: [{ id: 'a_x', metric: 'costPerSale', op: 'gt', threshold: 'x', minVolume: 5, active: 'oui' }], objectives: [{ id: 'o_1', month: '2026-09', scope: 'global', metric: 'sales', target: '12' }] });
    expect(c.alerts[0].active).toBe(false);
    expect(Number.isNaN(c.alerts[0].threshold)).toBe(true);
    expect(validateReportSettings(c).join(' ')).toMatch(/seuil doit être un nombre/);
    expect(validateReportSettings(c).join(' ')).toMatch(/cible doit être un nombre/);
  });
  it('alertes : volume minimum entier, taux entre 0 et 100, variation interdite pour un stock, attente de 1 à 60 jours', () => {
    const e = (a: Partial<AlertRule>) => validateReportSettings({ alerts: [rule(a)], objectives: [] }).join(' ');
    expect(e({ minVolume: -1 })).toMatch(/volume minimum/);
    expect(e({ minVolume: 2.5 })).toMatch(/volume minimum/);
    expect(e({ metric: 'contactRate', threshold: 140 })).toMatch(/entre 0 et 100/);
    expect(e({ metric: 'contactRate', mode: 'change', op: 'lte', threshold: -10 })).toBe('');
    expect(e({ metric: 'blockedDossiers', mode: 'change' })).toMatch(/variation/);
    expect(e({ metric: 'blockedDossiers', days: 0 })).toMatch(/1 à 60 jours/);
    expect(e({ id: 'mauvais' })).toMatch(/identifiant/);
  });
  it('alertes : identifiants en double refusés', () => {
    expect(validateReportSettings({ alerts: [rule(), rule()], objectives: [] }).join(' ')).toMatch(/en double/);
  });
  it('objectifs : cible positive et entière (sauf coût), mois valide, périmètre choisi, pas de doublon', () => {
    const e = (o: Partial<Objective>, more: Objective[] = []) => validateReportSettings({ alerts: [], objectives: [obj(o), ...more] }).join(' ');
    expect(e({ target: 0 })).toMatch(/supérieur à 0/);
    expect(e({ target: 2.5 })).toMatch(/nombre entier/);
    expect(e({ metric: 'costPerSale', target: 450.5 })).toBe('');
    expect(e({ month: '2026-9' })).toMatch(/AAAA-MM/);
    expect(e({ scope: 'campaign', scopeId: '' })).toMatch(/choisissez la campagne/);
    expect(e({}, [obj({ id: 'o_2' })])).toMatch(/existe déjà/);
  });
  it('coût par vente : pas d’objectif par télépro (une dépense ne s’y rattache pas)', () => {
    expect(validateReportSettings({ alerts: [], objectives: [obj({ metric: 'costPerSale', scope: 'owner', scopeId: 'u1', target: 400 })] }).join(' ')).toMatch(/ne se rattache pas à un télépro/);
  });
});

describe('mois', () => {
  it('clé et bornes d’un mois', () => {
    expect(monthKey(T(2026, 9, 15))).toBe('2026-09');
    const r = monthRange('2026-09');
    expect(r.fromMs).toBe(new Date(2026, 8, 1).getTime());
    expect(r.toMs).toBe(new Date(2026, 9, 1).getTime());
  });
  it('un rapport qui couvre exactement un mois renvoie sa clé, sinon null', () => {
    expect(singleMonthOf(SEP)).toBe('2026-09');
    expect(singleMonthOf({ fromMs: SEP.fromMs, toMs: SEP.toMs + 86_400_000 })).toBeNull();
    expect(singleMonthOf({ fromMs: SEP.fromMs + 86_400_000, toMs: SEP.toMs })).toBeNull();
  });
});

describe('avancement d’un objectif', () => {
  const leads = [sold('a'), sold('b'), sold('c'), lead('n1', { status: 'nr' })];
  const args = (nowMs: number, ls = leads) => ({ leads: ls, spends: [] as { campaignId: string; amountCents: number; atMs: number }[], campaigns: camps, nowMs });
  it('réalisé = ventes nettes du mois (même règle que les rapports)', () => {
    expect(objectiveProgress(obj({ target: 4 }), args(NOW)).actual).toBe(3);
  });
  it('atteint : statut, pourcentage, pas de projection', () => {
    const p = objectiveProgress(obj({ target: 3 }), args(NOW));
    expect(p).toMatchObject({ status: 'achieved', pct: 100, projected: null });
  });
  it('en cours : projection au rythme observé, statut selon l’écart', () => {
    // 3 ventes au 20 septembre (20 jours sur 30) → projection 5
    const p = objectiveProgress(obj({ target: 5 }), args(NOW));
    expect(p.projected).toBe(5);
    expect(p.status).toBe('on_track');
    expect(objectiveProgress(obj({ target: 6 }), args(NOW)).status).toBe('at_risk');
    expect(objectiveProgress(obj({ target: 20 }), args(NOW)).status).toBe('behind');
    expect(p.elapsedPct).toBeGreaterThan(60);
  });
  it('mois terminé et non atteint : « non atteint », sans projection', () => {
    const p = objectiveProgress(obj({ target: 10 }), args(T(2026, 10, 15)));
    expect(p).toMatchObject({ status: 'missed', projected: null, elapsedPct: 100 });
  });
  it('mois à venir : « à venir », aucun faux zéro', () => {
    expect(objectiveProgress(obj({ month: '2026-12' }), args(NOW))).toMatchObject({ status: 'upcoming', pct: null });
  });
  it('périmètre : télépro, produit, campagne', () => {
    const mixed = [sold('a', { ownerId: 'u1' }), sold('b', { ownerId: 'u2' }), sold('c', { ownerId: 'u2', productCode: 'SSC', campaignId: 'c1' })];
    expect(objectiveProgress(obj({ scope: 'owner', scopeId: 'u2' }), args(NOW, mixed)).actual).toBe(2);
    expect(objectiveProgress(obj({ scope: 'product', scopeId: 'SSC' }), args(NOW, mixed)).actual).toBe(1);
    expect(objectiveProgress(obj({ scope: 'campaign', scopeId: 'c1' }), args(NOW, mixed)).actual).toBe(3);
    expect(objectiveProgress(obj({ scope: 'campaign', scopeId: 'autre' }), args(NOW, mixed)).actual).toBe(0);
  });
  it('seules les ventes du mois comptent', () => {
    const old = sold('old', { receivedAtMs: T(2026, 8, 3), conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 8, 10) }, docs: docs({ received: 4, lastRequestAtMs: T(2026, 8, 4), completedAtMs: T(2026, 8, 8) }), montage: undefined });
    expect(objectiveProgress(obj(), args(NOW, [old])).actual).toBe(0);
  });
  it('coût par vente : objectif à ne pas dépasser', () => {
    const spends = [{ campaignId: 'c1', amountCents: 150_000, atMs: T(2026, 9, 5) }];
    const p = (target: number, now = NOW) => objectiveProgress(obj({ metric: 'costPerSale', target }), { ...args(now), spends });
    expect(p(600).actual).toBe(500);
    expect(p(600).status).toBe('on_track');
    expect(p(480).status).toBe('at_risk');
    expect(p(300).status).toBe('behind');
    expect(p(600, T(2026, 10, 3)).status).toBe('achieved');
    expect(p(300, T(2026, 10, 3)).status).toBe('missed');
  });
  it('coût par vente sans dépense ou sans vente : non calculable, jamais 0 €', () => {
    expect(objectiveProgress(obj({ metric: 'costPerSale' }), args(NOW))).toMatchObject({ actual: null, status: 'na' });
    expect(objectiveProgress(obj({ metric: 'costPerSale' }), { ...args(NOW), leads: [lead('x')], spends: [{ campaignId: 'c1', amountCents: 1000, atMs: T(2026, 9, 5) }] })).toMatchObject({ actual: null, status: 'na' });
  });
});

describe('objectifs d’un rapport', () => {
  const list = [obj(), obj({ id: 'o_2', scope: 'product', scopeId: 'PAC' }), obj({ id: 'o_3', scope: 'owner', scopeId: 'u1' }), obj({ id: 'o_4', active: false }), obj({ id: 'o_5', month: '2026-10' })];
  it('sans filtre : objectifs globaux du mois ; avec un filtre : ceux de ce périmètre', () => {
    expect(objectivesFor(list, '2026-09', {}).map((o) => o.id)).toEqual(['o_1']);
    expect(objectivesFor(list, '2026-09', { product: 'PAC' }).map((o) => o.id)).toEqual(['o_2']);
    expect(objectivesFor(list, '2026-09', { owner: 'u1' }).map((o) => o.id)).toEqual(['o_3']);
  });
  it('filtres croisés ou source : aucun objectif (pas de périmètre exact)', () => {
    expect(objectivesFor(list, '2026-09', { product: 'PAC', owner: 'u1' })).toEqual([]);
    expect(objectivesFor(list, '2026-09', { sourceId: 'meta' })).toEqual([]);
  });
});

describe('alertes (seuil ET volume minimum, §22.8)', () => {
  const ids = (a: { id: string }[]) => a.map((x) => x.id);
  const c = (sales: number, spend: number | null = sales * 10_000, over: Partial<PeriodCounts['counts']> = {}, extra: Partial<PeriodCounts> = {}) => counts({ valid: 50, received: 60, contacted: 30, sales, ...over }, { spendCents: spend, ...extra });
  it('rien d’actif : une seule ligne qui le dit', () => {
    const a = evaluateAlerts([], inputs(c(5)));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 'ok', level: 'ok' });
    expect(a[0].detail).toMatch(/Aucune alerte n’est activée/);
  });
  it('valeur au-delà du seuil avec assez de volume : alerte avec la valeur et le volume', () => {
    // 12 ventes pour 6 666 € = 555,5 € par vente
    const a = evaluateAlerts([rule()], inputs(c(12, 666_666)));
    expect(ids(a)).toEqual(['a_x']);
    expect(a[0]).toMatchObject({ level: 'warning', metric: 'costPerSale', volume: 12 });
    expect(a[0].title).toMatch(/555,5/);
  });
  it('volume minimum non atteint : pas d’alerte, même largement au-delà du seuil', () => {
    expect(ids(evaluateAlerts([rule()], inputs(c(5, 5_000_000))))).toEqual(['ok']);
  });
  it('valeur non calculable (aucune dépense) : jamais d’alerte', () => {
    expect(ids(evaluateAlerts([rule()], inputs(c(20, null))))).toEqual(['ok']);
  });
  it('règle désactivée : ignorée', () => {
    expect(ids(evaluateAlerts([rule({ active: false })], inputs(c(12, 666_666))))).toEqual(['ok']);
  });
  it('sens du seuil : > et <, ≥ et ≤ aux bornes', () => {
    const cur = c(10, 500_000); // 500 € exactement
    expect(ids(evaluateAlerts([rule({ op: 'gt' })], inputs(cur)))).toEqual(['ok']);
    expect(ids(evaluateAlerts([rule({ op: 'gte' })], inputs(cur)))).toEqual(['a_x']);
    expect(ids(evaluateAlerts([rule({ op: 'lte', threshold: 500 })], inputs(cur)))).toEqual(['a_x']);
    expect(ids(evaluateAlerts([rule({ op: 'lt', threshold: 500 })], inputs(cur)))).toEqual(['ok']);
  });
  it('variation d’un coût : relative, volume exigé sur les DEUX périodes', () => {
    const r = rule({ mode: 'change', op: 'gte', threshold: 20, minVolume: 3 });
    const a = evaluateAlerts([r], inputs(c(5, 600_000), c(5, 400_000)));
    expect(a[0].title).toBe('Coût par vente +50 %');
    expect(ids(evaluateAlerts([r], inputs(c(5, 600_000), c(2, 100_000))))).toEqual(['ok']);
    expect(ids(evaluateAlerts([r], inputs(c(5, 440_000), c(5, 400_000))))).toEqual(['ok']);
  });
  it('variation d’un taux : en points, jamais en pourcentage relatif', () => {
    const r = rule({ metric: 'contactRate', mode: 'change', op: 'lte', threshold: -10, minVolume: 10 });
    const a = evaluateAlerts([r], inputs(c(0, null, { contacted: 20 }), c(0, null, { contacted: 35 })));
    expect(a[0]).toMatchObject({ id: 'a_x', metric: 'contactRate' });
    expect(a[0].title).toBe('Taux de contact −30 pts');
    expect(ids(evaluateAlerts([r], inputs(c(0, null, { contacted: 30 }), c(0, null, { contacted: 32 }))))).toEqual(['ok']);
  });
  it('base nulle : pas de variation relative', () => {
    const r = rule({ mode: 'change', op: 'gte', threshold: 20, minVolume: 0 });
    expect(ids(evaluateAlerts([r], inputs(c(5, 100_000), c(5, 0))))).toEqual(['ok']);
  });
  it('taux de leads exclus', () => {
    const r = rule({ metric: 'excludedRate', op: 'gt', threshold: 12, minVolume: 50 });
    expect(ids(evaluateAlerts([r], inputs(counts({ received: 60, valid: 50 }))))).toEqual(['a_x']); // 16,7 %
    expect(ids(evaluateAlerts([r], inputs(counts({ received: 40, valid: 30 }))))).toEqual(['ok']); // 40 leads < 50
  });
  it('SLA respecté et ventes annulées', () => {
    const sla = rule({ metric: 'slaRate', op: 'lt', threshold: 90, minVolume: 20 });
    expect(ids(evaluateAlerts([sla], inputs(c(0), c(0), { sla: { measured: 30, respected: 24 } })))).toEqual(['a_x']);
    expect(ids(evaluateAlerts([sla], inputs(c(0), c(0), { sla: { measured: 10, respected: 2 } })))).toEqual(['ok']);
    const canc = rule({ metric: 'cancelledRate', op: 'gte', threshold: 20, minVolume: 5 });
    expect(ids(evaluateAlerts([canc], inputs(c(4, null, {}, { cancelled: 1 }))))).toEqual(['a_x']); // 1 sur 5 = 20 %
    expect(ids(evaluateAlerts([canc], inputs(c(3, null, {}, { cancelled: 1 }))))).toEqual(['ok']); // 4 ventes créées < 5
  });
  it('dossiers bloqués : photographie, seuil en nombre de dossiers', () => {
    const r = rule({ metric: 'blockedDossiers', op: 'gte', threshold: 3, days: 7, minVolume: 0 });
    expect(ids(evaluateAlerts([r], inputs(c(0), c(0), { blocked: (d) => (d === 7 ? 4 : 0) })))).toEqual(['a_x']);
    expect(ids(evaluateAlerts([r], inputs(c(0), c(0), { blocked: () => 2 })))).toEqual(['ok']);
  });
  it('alertes d’origine du rapport Direction : mêmes seuils qu’avant', () => {
    const rules = DEFAULT_ALERT_RULES as AlertRule[];
    // coût par vente +20 % avec 3 ventes de chaque côté
    expect(ids(evaluateAlerts(rules, inputs(c(3, 360_000), c(3, 300_000))))).toEqual(['a_cost_per_sale']);
    // trop peu de ventes : rien
    expect(ids(evaluateAlerts(rules, inputs(c(2, 800_000, { valid: 5 }), c(2, 300_000, { valid: 5 }))))).toEqual(['ok']);
    // coût par lead +25 % et contact −15 pts avec 20 leads valides
    const cur = counts({ valid: 20, received: 20, contacted: 5 }, { spendCents: 25_000 });
    const prev = counts({ valid: 20, received: 20, contacted: 8 }, { spendCents: 20_000 });
    expect(ids(evaluateAlerts(rules, inputs(cur, prev)))).toEqual(['a_cost_per_lead', 'a_contact_rate']);
    // documents → complets en baisse de 10 points avec 20 demandes
    const d1 = counts({ valid: 20, received: 20, docsRequested: 20, docsComplete: 5 });
    const d0 = counts({ valid: 20, received: 20, docsRequested: 20, docsComplete: 15 });
    expect(ids(evaluateAlerts(rules, inputs(d1, d0)))).toContain('a_docs_conversion');
    // 20 % d'annulations sur 5 ventes créées
    expect(ids(evaluateAlerts(rules, inputs(counts({ valid: 20, sales: 4 }, { cancelled: 1 }), counts({ valid: 20 }))))).toEqual(['a_cancelled']);
  });
  it('texte d’une règle', () => {
    expect(ruleText(rule())).toBe('Coût par vente > 500 € ET au moins 10 ventes');
    expect(ruleText(rule({ metric: 'excludedRate', threshold: 12, minVolume: 50 }))).toBe('Leads exclus > 12 % ET au moins 50 leads reçus');
    expect(ruleText(rule({ metric: 'contactRate', mode: 'change', op: 'lte', threshold: -10, minVolume: 0 }))).toBe('variation du taux de contact ≤ -10 pts');
    expect(ruleText(rule({ metric: 'blockedDossiers', days: 7, threshold: 1 }))).toBe('Dossiers bloqués : plus de 7 jours d\'attente, au moins 1 dossier');
  });
});

describe('données d’évaluation d’un rapport', () => {
  it('SLA des deux périodes et dossiers bloqués du périmètre', () => {
    const waiting = lead('w', { status: 'awaiting_documents', documentsState: 'requested', docs: docs({ lastRequestAtMs: NOW - 10 * 86_400_000 }) });
    const leads = [sold('s1'), lead('slow', { slaStoppedAtMs: T(2026, 9, 5) + 3_600_000 }), waiting, lead('f', { status: 'fake_lead', excluded: true, docs: docs({ lastRequestAtMs: NOW - 10 * 86_400_000 }) })];
    const i = alertInputs({ current: counts(), previous: counts(), leads, campaigns: camps, filters: F, nowMs: NOW, slaMs: 5 * 60_000 });
    expect(i.sla.measured).toBeGreaterThan(0);
    expect(i.sla.respected).toBe(1);
    expect(i.blocked(7)).toBe(1);
    expect(i.blocked(14)).toBe(0);
  });
});
