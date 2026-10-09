import { describe, expect, it } from 'vitest';
import { buildDocumentsReport, docHits, documentStagePopulation, documentsRows } from './documents';
import { camps, DAY, docs, F, lead, NOW, sold, T } from './reportsFixtures';

const rep = (leads: ReturnType<typeof lead>[], f = {}, blockDays?: number) => buildDocumentsReport({ leads, campaigns: camps, filters: { ...F, ...f }, nowMs: NOW, blockDays });

const waiting = (id: string, daysAgo: number, over = {}) => lead(id, { status: 'awaiting_documents', documentsState: 'requested', docs: docs({ lastRequestAtMs: NOW - daysAgo * DAY, followUpCount: 2 }), ...over });
const partial = (id: string, over = {}) => lead(id, { status: 'awaiting_documents', documentsState: 'partial', docs: docs({ received: 2, lastRequestAtMs: T(2026, 9, 6), lastReceivedAtMs: T(2026, 9, 7), followUpCount: 1 }), ...over });

describe('étapes documentaires', () => {
  it('dossier valide : demandé, reçu, complet', () => {
    const h = docHits(sold('a'));
    expect(h.requested.reached && h.received.reached && h.complete.reached && h.mounted.reached).toBe(true);
  });
  it('doublon et faux lead ne comptent pas', () => {
    for (const over of [{ duplicate: true }, { excluded: true }, { status: 'fake_lead' as const }]) {
      const h = docHits(sold('a', over));
      expect([h.requested, h.received, h.complete, h.mounted].some((x) => x.reached)).toBe(false);
    }
  });
  it('sans pièce demandée : rien', () => expect(docHits(lead('a')).requested.reached).toBe(false));
});

describe('rapport documentaire', () => {
  const leads = [sold('s1'), sold('s2'), partial('p1'), waiting('w1', 10), waiting('w2', 2), lead('x', { status: 'not_interested', documentsState: 'requested', docs: docs({ lastRequestAtMs: T(2026, 9, 6) }) }), lead('none')];
  const r = rep(leads);
  it('volumes de chaque étape et passages', () => {
    expect(r.counts).toMatchObject({ requested: 6, received: 3, complete: 2 });
    expect(r.stages.map((s) => s.count)).toEqual([r.counts.requested, r.counts.received, r.counts.complete, r.counts.mounted]);
    expect(r.stages[1].passage).toBe(50);
    expect(r.stages[0].passage).toBeNull();
  });
  it('relances moyennes sur les dossiers demandés', () => {
    expect(r.avgReminders).toBe(0.8);
  });
  it('partiels : pièces reçues sans dossier complet', () => expect(r.partial).toBe(1));
  it('abandon : demandé puis clôturé sans vente', () => {
    expect(r.abandoned).toBe(1);
    expect(r.abandonRate).toBe(16.7);
  });
  it('délais : médiane et volume mesuré', () => {
    const d = Object.fromEntries(r.delays.map((x) => [x.key, x]));
    expect(d.requestToComplete).toMatchObject({ medianDays: 2, n: 2, late: false });
    expect(d.completeToSale).toMatchObject({ medianDays: 2, n: 2 });
    expect(d.completeToMount.medianDays).toBe(1);
  });
  it('délai sans donnée : null, jamais 0', () => {
    const e = rep([partial('p')]).delays;
    expect(e.every((x) => x.medianDays === null && x.n === 0 && !x.late)).toBe(true);
  });
  it('délai trop long : signalé en retard', () => {
    const slow = sold('slow', { docs: docs({ received: 4, lastRequestAtMs: T(2026, 9, 1), completedAtMs: T(2026, 9, 12) }) });
    expect(rep([slow]).delays[0].late).toBe(true);
  });
  it('liste ouverte au clic = volume affiché (§22.12)', () => {
    for (const s of ['requested', 'received', 'complete', 'mounted'] as const) expect(documentStagePopulation(leads, camps, F, s)).toHaveLength(r.counts[s]);
  });
});

describe('goulots d’étranglement', () => {
  it('dossiers en attente de pièces depuis plus de N jours', () => {
    const leads = [waiting('old', 10), waiting('recent', 3), waiting('mid', 8)];
    expect(rep(leads).bottlenecks.waiting.map((l) => l.id).sort()).toEqual(['mid', 'old']);
    expect(rep(leads, {}, 2).bottlenecks.waiting).toHaveLength(3);
    expect(rep(leads, {}, 14).bottlenecks.waiting).toHaveLength(0);
  });
  it('dossier complet qui attend le montage depuis plus de 24 h', () => {
    const late = lead('late', { status: 'file_ready_to_build', documentsState: 'complete', docs: docs({ completedAtMs: NOW - 2 * DAY }) });
    const fresh = lead('fresh', { status: 'file_ready_to_build', documentsState: 'complete', docs: docs({ completedAtMs: NOW - 3_600_000 }) });
    expect(rep([late, fresh]).bottlenecks.mountWait.map((l) => l.id)).toEqual(['late']);
  });
  it('un dossier clos ou faux n’est pas un goulot', () => {
    expect(rep([waiting('c', 20, { status: 'not_interested' }), waiting('d', 20, { duplicate: true })]).bottlenecks.waiting).toHaveLength(0);
  });
});

describe('non-conformités', () => {
  const nc = (id: string, items: [string, string | null, string | null][]) => lead(id, { status: 'missing_info', documentsState: 'partial', docs: docs({ received: 1, lastRequestAtMs: T(2026, 9, 6), missing: items.map(([code, ko, kl]) => ({ code, label: null, status: 'non_conform' as const, koReason: ko, koReasonLabel: kl })) }) });
  const r = rep([nc('a', [['identity', 'unreadable', null], ['tax_notice', 'expired', 'Expiré (v2)']]), nc('b', [['identity', 'unreadable', null]]), nc('c', [['identity', null, null]])]);
  it('pièces les plus souvent non conformes, avec part du total', () => {
    expect(r.nonConformTotal).toBe(4);
    expect(r.nonConformDocs[0]).toMatchObject({ key: 'identity', count: 3, share: 75 });
  });
  it('motifs : libellé conservé, motif absent regroupé', () => {
    const m = Object.fromEntries(r.nonConformReasons.map((x) => [x.label, x.count]));
    expect(m['Illisible']).toBe(2);
    expect(m['Expiré (v2)']).toBe(1);
    expect(m['Motif non renseigné']).toBe(1);
  });
  it('rien de non conforme : listes vides, pas de division par zéro', () => {
    const e = rep([sold('s')]);
    expect(e.nonConformDocs).toEqual([]);
    expect(e.nonConformTotal).toBe(0);
  });
});

describe('modes de date et export', () => {
  const l = sold('x', { receivedAtMs: T(2026, 8, 28), docs: docs({ received: 4, lastRequestAtMs: T(2026, 8, 29), completedAtMs: T(2026, 9, 2) }) });
  it('cohorte : rattaché à la réception, pas à la date du dossier complet', () => {
    expect(rep([l], { mode: 'event' }).counts.complete).toBe(1);
    expect(rep([l], { mode: 'cohort' }).counts.complete).toBe(0);
  });
  it('CSV : mode de date, étapes, délais et goulots', () => {
    const rows = documentsRows(rep([sold('s'), waiting('w', 9)]), 'Date d’événement');
    expect(rows[0]).toEqual(['Mode de date', 'Date d’événement']);
    expect(rows.some((x) => String(x[0]).includes('depuis plus de 7 jours'))).toBe(true);
  });
});
