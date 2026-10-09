import { describe, expect, it } from 'vitest';
import { buildCockpit, isSaleSecured, periodStart, sinceLabel, targetChoices } from './cockpit';
import type { LeadListItem } from '../leads/leadList';
import type { UserRow } from '../admin/userRows';

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'new', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 2 * H, slaStartedAtMs: null, slaStoppedAtMs: NOW - H, nextAction: null,
  documentsState: 'none', duplicate: false, excluded: false, ...over,
});
const sla = (ageMin: number): Partial<LeadListItem> => ({ status: 'new', slaStartedAtMs: NOW - ageMin * MIN, slaStoppedAtMs: null, receivedAtMs: NOW - ageMin * MIN });
const callback = (lateMin: number): Partial<LeadListItem> => ({ status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW - lateMin * MIN, priority: 'P0', reason: 'Rappel' } });

const row = (uid: string, over: Partial<UserRow> = {}): UserRow => ({
  uid, name: `Télépro ${uid}`, email: '', role: 'telepro', accountActive: true, hasProfile: true, teamIds: [], teamNames: [], products: [], zones: [],
  newLeads: 2, cap: 10, connected: true, operationalStatus: 'available', distribution: 'active', ...over,
});

const run = (items: LeadListItem[], rows: UserRow[] = [row('u1')], period: 'today' | 'week' | 'month' = 'today') => buildCockpit({ items, rows, nowMs: NOW, period });

describe('leads en danger', () => {
  it('SLA dépassé = critique ; proche (3 min sur 5) = élevé ; récent = absent', () => {
    const c = run([lead('late', sla(9)), lead('near', sla(3.5)), lead('fresh', sla(1))]);
    expect(c.danger.map((i) => [i.lead.id, i.severity])).toEqual([['late', 'critical'], ['near', 'high']]);
    expect(c.danger[0].reason).toMatch(/dépassé de 4 min/);
  });
  it('un lead déjà pris en charge (SLA arrêté), clôturé ou exclu n\'est jamais en danger', () => {
    expect(run([lead('a'), lead('b', { ...sla(20), status: 'not_interested' }), lead('c', { ...sla(20), excluded: true })]).danger).toEqual([]);
  });
  it('un lead non attribué (file tampon) dont le SLA tourne compte aussi', () => {
    expect(run([lead('buf', { ...sla(12), ownerId: null, assignmentState: 'buffer' })]).danger).toHaveLength(1);
  });
});

describe('rappels en retard', () => {
  it('moins de 5 minutes de retard : pas encore « en retard » ; 5 min orange (élevé) ; 15 min rouge (critique)', () => {
    const c = run([lead('on-time', callback(2)), lead('orange', callback(7)), lead('red', callback(20))]);
    expect(c.lateCallbacks.map((i) => [i.lead.id, i.severity])).toEqual([['red', 'critical'], ['orange', 'high']]);
    expect(c.lateCallbacks[0].reason).toBe('Rappel client en retard de 20 min');
  });
  it('un rappel dans le futur ou un lead qui n\'est pas à rappeler : ignoré', () => {
    expect(run([lead('future', callback(-30)), lead('x', { status: 'interested', nextAction: { type: 'client_callback', dueAtMs: NOW - H, priority: 'P0', reason: '' } })]).lateCallbacks).toEqual([]);
  });
});

describe('documents bloqués', () => {
  const docs = (o: Partial<NonNullable<LeadListItem['docs']>> = {}) => ({ expected: 4, received: 1, conform: 1, mandatory: 3, mandatoryConform: 1, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: NOW - 8 * DAY, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0, ...o });
  const d = (id: string, over: Partial<LeadListItem>) => lead(id, { status: 'awaiting_documents', documentsState: 'partial', docs: docs(), ...over });
  it('décision à J+14, promesse échue, pièces non contrôlées depuis plus d\'un jour, relances sans effet', () => {
    const c = run([
      d('dec', { nextAction: { type: 'document_decision', dueAtMs: NOW - H, priority: 'P1', reason: '' } }),
      d('promised', { nextAction: { type: 'promised_docs_missing', dueAtMs: NOW - 30 * MIN, priority: 'P2', reason: '' } }),
      d('check', { docs: docs({ toCheck: 2, lastReceivedAtMs: NOW - 2 * DAY }) }),
      d('relances', { docs: docs({ followUpCount: 3 }) }),
    ]);
    expect(c.blockedDocs.map((i) => i.lead.id).sort()).toEqual(['check', 'dec', 'promised', 'relances']);
  });
  it('promesse encore dans le futur, pièces reçues récemment, dossier complet : pas bloqués', () => {
    const c = run([
      d('promise-future', { nextAction: { type: 'promised_docs_missing', dueAtMs: NOW + H, priority: 'P2', reason: '' } }),
      d('recent', { docs: docs({ toCheck: 1, lastReceivedAtMs: NOW - H }) }),
      d('complete', { status: 'file_ready_to_build', documentsState: 'complete', docs: docs({ followUpCount: 4 }) }),
    ]);
    expect(c.blockedDocs).toEqual([]);
  });
});

describe('décisions à prendre', () => {
  it('file tampon : un seul item groupé, critique au-delà de 15 min d\'attente, avec l\'ancienneté', () => {
    const c = run([lead('b1', { ownerId: null, assignmentState: 'buffer', receivedAtMs: NOW - 18 * MIN, slaStoppedAtMs: null }), lead('b2', { ownerId: null, assignmentState: 'to_assign', receivedAtMs: NOW - 5 * MIN, slaStoppedAtMs: null })]);
    const d = c.decisions.find((x) => x.id === 'buffer')!;
    expect(d).toMatchObject({ severity: 'critical', title: 'Attribuer 2 leads en attente', action: { label: 'Attribuer', kind: 'buffer' } });
    expect(d.sinceMs).toBe(NOW - 18 * MIN);
    expect(c.buffer).toMatchObject({ count: 2, oldestMs: NOW - 18 * MIN });
    expect(c.buffer.leads.map((l) => l.id)).toEqual(['b1', 'b2']);
  });
  it('file tampon récente : élevé, singulier', () => {
    const d = run([lead('b', { ownerId: null, assignmentState: 'buffer', receivedAtMs: NOW - 3 * MIN, slaStoppedAtMs: null })]).decisions[0];
    expect(d).toMatchObject({ severity: 'high', title: 'Attribuer 1 lead en attente' });
  });
  it('triées : critiques d\'abord, puis plus ancien d\'abord', () => {
    const c = run([lead('cb-orange', callback(7)), lead('cb-red-old', callback(40)), lead('cb-red', callback(20)), lead('sla', sla(9))]);
    expect(c.decisions[0].id).toBe('cb:cb-red-old');
    expect(c.decisions.slice(0, 3).every((x) => x.severity === 'critical')).toBe(true);
    expect(c.decisions[c.decisions.length - 1].id).toBe('cb:cb-orange');
  });
  it('une alerte corrigée disparaît d\'elle-même : rien n\'est mémorisé', () => {
    const before = run([lead('x', callback(20))]);
    const after = run([lead('x', { status: 'interested', nextAction: null })]);
    expect(before.decisions).toHaveLength(1);
    expect(after.decisions).toHaveLength(0);
  });
  it('rien à signaler : aucune décision', () => expect(run([lead('ok')]).decisions).toEqual([]));
});

describe('équipe en temps réel', () => {
  it('état, action actuelle, charge et alerte par télépro', () => {
    const c = run(
      [lead('n', { ...sla(2), ownerId: 'u1', fullName: 'Jean Dupont' }), lead('cb', { ...callback(20), ownerId: 'u2' })],
      [row('u1', { newLeads: 7 }), row('u2', { operationalStatus: 'on_call', newLeads: 10 }), row('u3', { connected: false })]
    );
    const by = Object.fromEntries(c.team.map((t) => [t.uid, t]));
    expect(by.u1).toMatchObject({ state: { label: 'Disponible', tone: 'green' }, newLeads: 7, cap: 10, alert: null });
    expect(by.u1.current).toMatch(/Jean Dupont/);
    expect(by.u2).toMatchObject({ state: { label: 'En appel', tone: 'blue' }, alert: { label: 'Rappel en retard', tone: 'red' } });
    expect(by.u3).toMatchObject({ state: { label: 'Déconnecté', tone: 'grey' }, current: null });
  });
  it('plafond atteint : « Saturé » (orange) ; un retard prime sur la saturation', () => {
    const c = run([], [row('u1', { newLeads: 10, cap: 10 })]);
    expect(c.team[0].alert).toEqual({ label: 'Saturé', tone: 'amber' });
  });
  it('les alertes rouges remontent en tête, puis ordre alphabétique', () => {
    const c = run([lead('cb', { ...callback(30), ownerId: 'zoe' })], [row('abel'), row('zoe'), row('bob', { newLeads: 10 })]);
    expect(c.team.map((t) => t.uid)).toEqual(['zoe', 'bob', 'abel']);
  });
  it('seuls les télépros actifs avec profil figurent dans le tableau', () => {
    const c = run([], [row('ok'), row('nop', { hasProfile: false }), row('off', { accountActive: false }), row('mgr', { role: 'manager' })]);
    expect(c.team.map((t) => t.uid)).toEqual(['ok']);
  });
});

describe('flux et période', () => {
  const items = [
    lead('today1', { receivedAtMs: NOW - H }),
    lead('today2', { receivedAtMs: NOW - 2 * H, ownerId: null, assignmentState: 'buffer', slaStoppedAtMs: null }),
    lead('yesterday', { receivedAtMs: NOW - DAY - H }),
    lead('old', { receivedAtMs: NOW - 20 * DAY }),
    lead('excl', { receivedAtMs: NOW - H, excluded: true }),
  ];
  it('aujourd\'hui : reçus, attribués, contactés (SLA arrêté) ; les faux leads sont exclus', () => {
    expect(run(items).flow).toEqual({ received: 2, assigned: 1, contacted: 1 });
  });
  it('7 jours puis 30 jours', () => {
    expect(run(items, [], 'week').flow.received).toBe(3);
    expect(run(items, [], 'month').flow.received).toBe(4);
  });
  it('début de période', () => {
    expect(periodStart('today', NOW)).toBe(new Date(2026, 9, 7).getTime());
    expect(periodStart('week', NOW)).toBe(NOW - 7 * DAY);
  });
});

/** Lead dont la vente est créée (statut « Transmission en cours » ou « Converti »). */
const sold = (over: Partial<LeadListItem> = {}): Partial<LeadListItem> => ({
  status: 'converted',
  commercialState: 'sale_committed',
  financialState: 'none',
  conversion: { state: 'confirmed', clientId: '2612345', dossierId: 'cl_x' },
  montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1_599_000, remainderCents: 349_000, updatedAtMs: NOW - 2 * H },
  ...over,
});
const validation = (sinceMin: number, ttc = 1_599_000): Partial<LeadListItem> => ({
  status: 'manager_validation',
  montage: { validationState: 'pending', blocking: 0, toConfirm: 1, totalTtcCents: ttc, remainderCents: 0, updatedAtMs: NOW - sinceMin * MIN },
});

describe('ventes à sécuriser (§25.7, fig. 14)', () => {
  it('une vente créée non sécurisée compte, même si le lead est « Converti » (clos pour la file)', () => {
    const c = run([lead('v1', sold()), lead('v2', sold({ status: 'transmitting', conversion: { state: 'pending', clientId: null, dossierId: null } }))]);
    expect(c.salesToSecure.map((i) => i.lead.id)).toEqual(['v1', 'v2']);
    expect(c.salesToSecure[0].reason).toBe('Vente créée : signature et paiement à confirmer');
    expect(c.salesToSecure[0].sinceMs).toBe(NOW - 2 * H);
  });
  it('signée mais sans paiement ni financement confirmé : encore à sécuriser', () => {
    const c = run([lead('v', sold({ commercialState: 'signed', financialState: 'financing_in_progress' }))]);
    expect(c.salesToSecure).toHaveLength(1);
    expect(c.salesToSecure[0].reason).toBe('Signée : paiement ou financement à confirmer');
  });
  it('sécurisée = signée ET paiement confirmé ou financement accepté : absente de la carte', () => {
    expect(run([lead('a', sold({ commercialState: 'signed', financialState: 'payment_confirmed' })), lead('b', sold({ commercialState: 'signed', financialState: 'financing_accepted' }))]).salesToSecure).toEqual([]);
    expect(isSaleSecured({ commercialState: 'signed', financialState: 'payment_confirmed' })).toBe(true);
    // Un financement demandé ou refusé n'est pas une vente financée (règle KPI du §23.11).
    expect(isSaleSecured({ commercialState: 'signed', financialState: 'financing_refused' })).toBe(false);
    expect(isSaleSecured({ commercialState: 'offer_sent', financialState: 'payment_confirmed' })).toBe(false);
  });
  it('vente annulée ou rétractée, lead exclu, ou lead sans vente : ignorés', () => {
    const c = run([lead('c', sold({ commercialState: 'cancelled' })), lead('r', sold({ commercialState: 'retracted' })), lead('x', sold({ excluded: true })), lead('none', { status: 'converted' })]);
    expect(c.salesToSecure).toEqual([]);
  });
  it('le chiffre de la carte est celui de la liste, la plus ancienne en premier', () => {
    const c = run([lead('new', sold({ montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - H } })), lead('old', sold({ montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - DAY } }))]);
    expect(c.salesToSecure.map((i) => i.lead.id)).toEqual(['old', 'new']);
  });
});

describe('décisions : ventes (§11.11, fig. 14)', () => {
  it('une exception soumise apparaît tout de suite, avec le montant et le bouton « Valider »', () => {
    const c = run([lead('v', validation(25, 120_000))]);
    expect(c.decisions).toHaveLength(1);
    expect(c.decisions[0]).toMatchObject({ id: 'val:v', severity: 'high', sinceMs: NOW - 25 * MIN, leadId: 'v', action: { label: 'Valider', kind: 'validation' } });
    expect(c.decisions[0].title).toMatch(/^Vente à valider — Client v · 1\s?200 €$/);
  });
  it('sans montant connu, le titre reste lisible', () => {
    const c = run([lead('v', { status: 'manager_validation' })]);
    expect(c.decisions[0].title).toBe('Vente à valider — Client v');
    expect(c.decisions[0].sinceMs).toBeNull();
  });
  it('une transmission échouée propose « Réessayer »', () => {
    const c = run([lead('t', { status: 'transmission_error', montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: NOW - 41 * MIN } })]);
    expect(c.decisions[0]).toMatchObject({ id: 'trx:t', severity: 'high', title: 'Erreur d’envoi CRM — Client t', sinceMs: NOW - 41 * MIN, action: { label: 'Réessayer', kind: 'transmit' } });
  });
  it('la décision disparaît dès que la situation est corrigée : approuvée, refusée, transmise', () => {
    expect(run([lead('a', { status: 'file_ready' }), lead('b', { status: 'file_building' }), lead('c', sold())]).decisions).toEqual([]);
  });
  it('un lead exclu n’apparaît jamais', () => {
    expect(run([lead('x', { ...validation(10), excluded: true })]).decisions).toEqual([]);
  });
  it('triées avec les autres alertes : un lead hors SLA (critique) passe avant une validation (élevée)', () => {
    const c = run([lead('v', validation(60)), lead('late', sla(12))]);
    expect(c.decisions.map((d) => d.id)).toEqual(['sla:late', 'val:v']);
  });
});

describe('sinceLabel', () => {
  it('minutes, heures, jours', () => {
    expect(sinceLabel(NOW - 30_000, NOW)).toBe("moins d'une minute");
    expect(sinceLabel(NOW - 18 * MIN, NOW)).toBe('18 min');
    expect(sinceLabel(NOW - 3 * H, NOW)).toBe('3 h');
    expect(sinceLabel(NOW - 2 * DAY, NOW)).toBe('2 j');
  });
});

describe('targetChoices (réattribution)', () => {
  const team = run([], [row('a', { newLeads: 6 }), row('b', { newLeads: 2 }), row('c', { newLeads: 10 }), row('d', { newLeads: 1, connected: false }), row('e', { newLeads: 3, operationalStatus: 'paused' })]).team;
  it('recommande le disponible sous plafond le moins chargé, et le place en tête', () => {
    const c = targetChoices(team, null);
    expect(c[0]).toMatchObject({ uid: 'b', recommended: true });
    expect(c.filter((x) => x.recommended)).toHaveLength(1);
  });
  it('les télépros indisponibles ou saturés restent choisissables, après les candidats', () => {
    const c = targetChoices(team, null);
    expect(c.map((x) => x.uid)).toEqual(['b', 'a', 'd', 'e', 'c']);
    expect(c.find((x) => x.uid === 'c')!.full).toBe(true);
  });
  it("le propriétaire actuel n'est jamais proposé", () => expect(targetChoices(team, 'b').map((x) => x.uid)).not.toContain('b'));
  it('aucun candidat : pas de recommandation', () => {
    expect(targetChoices(run([], [row('x', { connected: false })]).team, null).some((x) => x.recommended)).toBe(false);
    expect(targetChoices([], null)).toEqual([]);
  });
});

describe('résultat de la période par télépro (fig. 14)', () => {
  const soldBy = (id: string, owner: string, atMs: number, stage: string | null = null, over: Partial<LeadListItem> = {}) =>
    lead(id, { ownerId: owner, status: 'converted', commercialState: 'sale_committed', conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: atMs }, ...(stage ? { mainStatus: { stage, label: stage, changedAtMs: atMs } } : {}), ...over });
  const rowOf = (items: LeadListItem[], uid = 'u1') => run(items, [row('u1'), row('u2')]).team.find((t) => t.uid === uid)!;
  it('ventes nettes de la période, dont installées et facturées', () => {
    const t = rowOf([soldBy('a', 'u1', NOW - H, 'installed'), soldBy('b', 'u1', NOW - 2 * H, 'invoiced'), soldBy('c', 'u1', NOW - 3 * H)]);
    expect(t.result).toEqual({ sales: 3, installed: 2, invoiced: 1 });
  });
  it('une vente annulée n’est pas comptée', () => {
    expect(rowOf([soldBy('a', 'u1', NOW - H, 'cancelled'), soldBy('b', 'u1', NOW - H)]).result.sales).toBe(1);
  });
  it('seules les ventes de la période et du télépro comptent', () => {
    const items = [soldBy('old', 'u1', NOW - 3 * DAY), soldBy('other', 'u2', NOW - H), soldBy('mine', 'u1', NOW - H)];
    expect(rowOf(items).result.sales).toBe(1);
    expect(rowOf(items, 'u2').result.sales).toBe(1);
    expect(run(items, [row('u1')], 'week').team[0].result.sales).toBe(2);
  });
  it('aucune vente : zéros', () => expect(rowOf([lead('x')]).result).toEqual({ sales: 0, installed: 0, invoiced: 0 }));
});
