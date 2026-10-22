import { describe, expect, it } from 'vitest';
import { buildCockpit } from '../cockpit/cockpit';
import type { LeadListItem } from '../leads/leadList';
import { buildEngagedSales, engagedInfo, ENGAGED_ALERT_DAYS, isEngagedSale } from './engaged';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);

const lead = (over: Partial<LeadListItem> = {}): LeadListItem =>
  ({
    id: 'L1', fullName: 'Aïcha Test', phone: null, email: null, city: 'Lyon', postalCode: '69000', campaignId: null, productCode: 'PAC',
    status: 'file_building', temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'tel1', receivedAtMs: NOW - 10 * DAY,
    slaStartedAtMs: null, slaStoppedAtMs: NOW - 4 * DAY, nextAction: null, documentsState: 'requested', duplicate: false, excluded: false, directSale: true,
    ...over,
  }) as LeadListItem;
const docs = (mandatory: number, mandatoryConform: number) => ({ mandatory, mandatoryConform }) as LeadListItem['docs'];

describe('vente engagée : liste et retard', () => {
  it('une vente engagée n’est ni une vente créée, ni un lead exclu, ni un lead clos', () => {
    expect(isEngagedSale(lead())).toBe(true);
    expect(isEngagedSale(lead({ status: 'file_ready' }))).toBe(true);
    expect(isEngagedSale(lead({ conversion: { state: 'confirmed', clientId: 'c1', dossierId: 'd1' } }))).toBe(false);
    expect(isEngagedSale(lead({ excluded: true }))).toBe(false);
    expect(isEngagedSale(lead({ status: 'closed_lost' as never }))).toBe(false);
    expect(isEngagedSale(lead({ directSale: false }))).toBe(false);
  });
  it('en retard après le délai tant que les pièces obligatoires ne sont pas toutes conformes', () => {
    expect(ENGAGED_ALERT_DAYS).toBe(3);
    expect(engagedInfo(lead({ docs: docs(3, 1) }), NOW)).toMatchObject({ missingDocs: 2, readyToCreate: false, late: true });
    expect(engagedInfo(lead({ docs: docs(3, 1), slaStoppedAtMs: NOW - DAY }), NOW).late).toBe(false);
  });
  it('dernière pièce conforme : prêt à créer la vente, plus de retard', () => {
    expect(engagedInfo(lead({ docs: docs(3, 3) }), NOW)).toMatchObject({ missingDocs: 0, readyToCreate: true, late: false });
  });
  it('aucune pièce demandée : en retard sans compter de pièces manquantes', () => {
    expect(engagedInfo(lead(), NOW)).toMatchObject({ missingDocs: null, readyToCreate: false, late: true });
  });
  it('liste : la plus ancienne d’abord, les prêtes en dernier, filtres « mes ventes » et recherche', () => {
    const rows = [
      lead({ id: 'a', fullName: 'Ancienne', slaStoppedAtMs: NOW - 6 * DAY, docs: docs(2, 0) }),
      lead({ id: 'b', fullName: 'Prête', slaStoppedAtMs: NOW - 8 * DAY, docs: docs(2, 2) }),
      lead({ id: 'c', fullName: 'Récente', slaStoppedAtMs: NOW - DAY, ownerId: 'tel2' }),
      lead({ id: 'd', fullName: 'Déjà vendue', conversion: { state: 'confirmed', clientId: 'c', dossierId: 'd' } }),
    ];
    expect(buildEngagedSales(rows, { nowMs: NOW }).map((e) => e.row.id)).toEqual(['a', 'c', 'b']);
    expect(buildEngagedSales(rows, { nowMs: NOW, mineOnly: true, uid: 'tel1' }).map((e) => e.row.id)).toEqual(['a', 'b']);
    expect(buildEngagedSales(rows, { nowMs: NOW, search: 'récente' }).map((e) => e.row.id)).toEqual(['c']);
  });
});

describe('cockpit : point d’attention « vente engagée »', () => {
  const salesAlerts = (items: LeadListItem[]) => buildCockpit({ items, rows: [], nowMs: NOW, period: 'week' }).salesToSecure ?? [];
  it('apparaît après le délai, sans pièces conformes ; disparaît quand le dossier est complet', () => {
    const c = buildCockpit({ items: [lead({ docs: docs(3, 1) })], rows: [], nowMs: NOW, period: 'week' });
    const issues = JSON.stringify(c);
    expect(issues).toContain('Vente engagée, 2 pièce(s) obligatoire(s) non conforme(s)');
    const done = JSON.stringify(buildCockpit({ items: [lead({ docs: docs(3, 3) })], rows: [], nowMs: NOW, period: 'week' }));
    expect(done).not.toContain('Vente engagée');
    expect(salesAlerts).toBeTypeOf('function');
  });
  it('pas d’alerte avant le délai', () => {
    expect(JSON.stringify(buildCockpit({ items: [lead({ slaStoppedAtMs: NOW - DAY })], rows: [], nowMs: NOW, period: 'week' }))).not.toContain('Vente engagée');
  });
});
