import { describe, expect, it } from 'vitest';
import {
  consequencesOf,
  DEFAULT_HANDLING,
  familiesToTransfer,
  familyOf,
  parseHandling,
  planTransfer,
  buildTargets,
  portfolioOf,
  portfolioTotal,
  toSendBatches,
  type Target,
} from './portfolio';
import type { LeadListItem } from '../leads/leadList';

const NOW = new Date(2026, 9, 7, 10, 0, 0).getTime();
const MIN = 60_000;
const H = 60 * MIN;

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'new', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'src', receivedAtMs: NOW - Number(id.replace(/\D/g, '') || 0) * MIN, slaStartedAtMs: null, slaStoppedAtMs: null,
  nextAction: null, documentsState: 'none', duplicate: false, excluded: false, ...over,
});
const target = (uid: string, over: Partial<Target> = {}): Target => ({ uid, name: `Télépro ${uid}`, canReceive: true, newLeads: 0, cap: 10, total: 0, productCodes: ['*'], teamIds: ['t1'], ...over });

describe('familles de charge', () => {
  it('chaque statut ouvert a une famille ; les clôturés et sans compteur non', () => {
    expect(familyOf('new')).toBe('newLeads');
    expect(familyOf('nr')).toBe('newLeads');
    expect(familyOf('callback')).toBe('callbacks');
    expect(familyOf('awaiting_documents')).toBe('documents');
    expect(familyOf('file_ready_to_build')).toBe('filesToBuild');
    expect(familyOf('recycling')).toBe('recycling');
    expect(familyOf('converted')).toBeNull();
    expect(familyOf('unreachable_cycle_end')).toBeNull();
  });
  it('portefeuille : seulement les éléments ouverts du télépro', () => {
    const p = portfolioOf([lead('1'), lead('2', { status: 'callback' }), lead('3', { ownerId: 'autre' }), lead('4', { status: 'converted' }), lead('5', { excluded: true }), lead('6', { status: 'interested' })], 'src');
    expect([p.newLeads.length, p.callbacks.length, p.interested.length]).toEqual([1, 1, 1]);
    expect(portfolioTotal(p)).toBe(3);
  });
});

describe('conséquences d\'une absence', () => {
  it('rappels sous 24 h (ou en retard), leads proches du SLA, promesses documentaires, dossiers à monter', () => {
    const p = portfolioOf(
      [
        lead('1', { status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW + 2 * H, priority: 'P0', reason: '' } }),
        lead('2', { status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW + 3 * 24 * H, priority: 'P0', reason: '' } }),
        lead('3', { status: 'callback', nextAction: { type: 'client_callback', dueAtMs: NOW - H, priority: 'P0', reason: '' } }),
        lead('4', { slaStartedAtMs: NOW - 4 * MIN }),
        lead('5', { slaStartedAtMs: NOW - MIN }),
        lead('6', { status: 'awaiting_documents', nextAction: { type: 'promised_docs_missing', dueAtMs: NOW + H, priority: 'P2', reason: '' } }),
        lead('7', { status: 'file_ready_to_build' }),
      ],
      'src'
    );
    expect(consequencesOf(p, NOW)).toEqual({ callbacksSoon: 2, nearSla: 1, promisedDocs: 1, urgentFiles: 1 });
  });
});

describe('traitement du portefeuille', () => {
  it('recommandations du cahier : transférer rappels, nouveaux leads et documents ; le reste reste ou attend', () => {
    expect(familiesToTransfer(DEFAULT_HANDLING)).toEqual(['newLeads', 'callbacks', 'documents']);
    expect(familiesToTransfer({ newLeads: 'keep', callbacks: 'keep', interested: 'transfer', documents: 'keep', filesToBuild: 'reassign', recycling: 'redistribute' })).toEqual(['interested', 'filesToBuild', 'recycling']);
  });
  it('décisions inconnues ou incomplètes refusées', () => {
    expect(parseHandling(DEFAULT_HANDLING)).toEqual(DEFAULT_HANDLING);
    expect(parseHandling({ ...DEFAULT_HANDLING, callbacks: 'delete' })).toBeNull();
    expect(parseHandling({ ...DEFAULT_HANDLING, recycling: undefined })).toBeNull();
    expect(parseHandling(null)).toBeNull();
    expect(parseHandling({ ...DEFAULT_HANDLING, newLeads: 'constructor' })).toBeNull();
  });
});

describe('planTransfer', () => {
  const six = ['1', '2', '3', '4', '5', '6'].map((i) => lead(i));
  it("répartit les nouveaux leads selon la capacité restante, signale la saturation et réconcilie les totaux", () => {
    const p = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a', { newLeads: 8 }), target('b', { newLeads: 3 })] });
    expect(p.reconcile).toEqual({ selected: 6, assigned: 6, unassigned: 0 });
    const by = Object.fromEntries(p.projections.map((x) => [x.uid, x]));
    expect(by.a.received + by.b.received).toBe(6);
    expect(by.b.received).toBeGreaterThan(by.a.received); // le plus de capacité restante reçoit le plus
    expect(Math.max(by.a.newAfter, by.b.newAfter)).toBeLessThanOrEqual(10);
    const tight = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a', { newLeads: 8 }), target('b', { newLeads: 8 })] });
    expect(tight.reconcile).toEqual({ selected: 6, assigned: 4, unassigned: 2 });
    expect(tight.projections.every((x) => x.saturated && x.newAfter === 10)).toBe(true);
    expect(tight.warnings.some((w) => /capacité maximale/.test(w))).toBe(true);
  });
  it('jamais au-delà du plafond : le surplus reste non attribué, signalé', () => {
    const p = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'users', uids: ['a'] }, targets: [target('a', { newLeads: 7 })] });
    expect(p.reconcile).toEqual({ selected: 6, assigned: 3, unassigned: 3 });
    expect(p.projections[0].newAfter).toBe(10);
    expect(p.assignments.filter((a) => a.targetUid === null)).toHaveLength(3);
    expect(p.warnings.join(' ')).toMatch(/3 nouveaux leads non attribués/);
  });
  it('autres familles : pas de plafond, équilibrées sur la charge totale', () => {
    const docs = ['1', '2', '3', '4'].map((i) => lead(i, { status: 'awaiting_documents' }));
    const p = planTransfer({ leads: docs, fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a', { total: 10 }), target('b', { total: 0 })] });
    const by = Object.fromEntries(p.projections.map((x) => [x.uid, x.received]));
    expect(by.b).toBe(4);
    expect(p.reconcile.unassigned).toBe(0);
  });
  it('destination : utilisateurs choisis, équipe, ou moteur ; jamais l\'expéditeur', () => {
    const targets = [target('a'), target('b', { teamIds: ['t2'] }), target('src')];
    const only = (d: Parameters<typeof planTransfer>[0]['destination']) => planTransfer({ leads: [lead('1')], fromUid: 'src', destination: d, targets }).assignments[0].targetUid;
    expect(only({ kind: 'users', uids: ['b'] })).toBe('b');
    expect(only({ kind: 'team', teamId: 't2' })).toBe('b');
    expect(['a', 'b']).toContain(only({ kind: 'engine' }));
    expect(only({ kind: 'users', uids: ['src'] })).toBeNull();
  });
  it('destinataire sans compte actif, suspendu ou absent : écarté ; plus personne : aucun attribué, avertissement', () => {
    const p = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a', { canReceive: false })] });
    expect(p.reconcile).toEqual({ selected: 6, assigned: 0, unassigned: 6 });
    expect(p.warnings[0]).toMatch(/Aucun destinataire/);
  });
  it('périmètre produit respecté', () => {
    const l = lead('1', { productCode: 'SSC' });
    const p = planTransfer({ leads: [l], fromUid: 'src', destination: { kind: 'engine' }, targets: [target('pac', { productCodes: ['PAC'] }), target('ssc', { productCodes: ['ssc'] })] });
    expect(p.assignments[0].targetUid).toBe('ssc');
    expect(planTransfer({ leads: [l], fromUid: 'src', destination: { kind: 'engine' }, targets: [target('pac', { productCodes: ['PAC'] })] }).reconcile.unassigned).toBe(1);
    expect(planTransfer({ leads: [lead('2', { productCode: null })], fromUid: 'src', destination: { kind: 'engine' }, targets: [target('pac', { productCodes: ['PAC'] })] }).reconcile.assigned).toBe(1);
  });
  it('détail par famille : volume, attribués, destinataires ; ordre rappels d\'abord', () => {
    const leads = [lead('1', { status: 'callback' }), lead('2'), lead('3', { status: 'interested' })];
    const p = planTransfer({ leads, fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a')] });
    expect(p.rows.map((r) => r.family)).toEqual(['callbacks', 'newLeads', 'interested']);
    expect(p.rows[0]).toMatchObject({ volume: 1, assigned: 1, unassigned: 0, targets: [{ uid: 'a', count: 1 }] });
  });
  it('éléments sans famille (clôturés) ignorés ; sélection vide : plan vide', () => {
    const p = planTransfer({ leads: [lead('1', { status: 'converted' })], fromUid: 'src', destination: { kind: 'engine' }, targets: [target('a')] });
    expect(p.reconcile).toEqual({ selected: 0, assigned: 0, unassigned: 0 });
    expect(p.warnings).toEqual([]);
  });
  it('déterministe : même entrée, même résultat ; entrées jamais modifiées', () => {
    const targets = [target('a', { newLeads: 2 }), target('b', { newLeads: 2 })];
    const copy = JSON.stringify(targets);
    const a = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'engine' }, targets });
    const b = planTransfer({ leads: six, fromUid: 'src', destination: { kind: 'engine' }, targets });
    expect(a).toEqual(b);
    expect(JSON.stringify(targets)).toBe(copy);
  });
});

describe('buildTargets', () => {
  const row = (uid: string, over: Record<string, unknown> = {}) => ({ uid, name: `T ${uid}`, email: '', role: 'telepro', accountActive: true, hasProfile: true, teamIds: ['t1'], teamNames: [], products: ['PAC'], zones: [], newLeads: 4, cap: 10, connected: true, operationalStatus: 'available', distribution: 'active', ...over }) as never;
  it('télépros actifs avec profil ; absents et indisponibles ne reçoivent pas ; charge totale comptée', () => {
    const t = buildTargets([row('a'), row('b', { operationalStatus: 'absent' }), row('c', { operationalStatus: 'unavailable' }), row('d', { hasProfile: false }), row('e', { accountActive: false }), row('m', { role: 'manager' }), row('p', { operationalStatus: 'paused', distribution: 'paused' })], [lead('1', { ownerId: 'a' }), lead('2', { ownerId: 'a', status: 'callback' }), lead('3', { ownerId: 'a', status: 'converted' })]);
    expect(t.map((x) => [x.uid, x.canReceive])).toEqual([['a', true], ['b', false], ['c', false], ['p', true]]);
    expect(t[0]).toMatchObject({ newLeads: 4, cap: 10, total: 2, productCodes: ['PAC'], teamIds: ['t1'] });
  });
});

describe('toSendBatches', () => {
  const a = (leadId: string, family: 'newLeads' | 'documents' | 'callbacks', targetUid: string | null) => ({ leadId, family, targetUid });
  it('les non attribués ne sont jamais envoyés ; définitifs puis temporaires', () => {
    const b = toSendBatches([a('1', 'newLeads', 'x'), a('2', 'documents', 'x'), a('3', 'callbacks', null), a('4', 'callbacks', 'y')], ['documents'], 25);
    expect(b).toEqual([
      { temporary: false, assignments: [{ leadId: '1', targetUid: 'x' }, { leadId: '4', targetUid: 'y' }] },
      { temporary: true, assignments: [{ leadId: '2', targetUid: 'x' }] },
    ]);
  });
  it('découpé en envois de taille maximale, sans perdre ni dupliquer un élément', () => {
    const list = Array.from({ length: 60 }, (_, i) => a(`L${i}`, 'newLeads', 'x'));
    const b = toSendBatches(list, [], 25);
    expect(b.map((x) => x.assignments.length)).toEqual([25, 25, 10]);
    expect(b.flatMap((x) => x.assignments.map((y) => y.leadId))).toEqual(list.map((x) => x.leadId));
  });
  it('rien à envoyer : aucun lot', () => {
    expect(toSendBatches([], ['documents'], 25)).toEqual([]);
    expect(toSendBatches([a('1', 'newLeads', null)], [], 25)).toEqual([]);
  });
});
