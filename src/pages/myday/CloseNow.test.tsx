import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../documents/useChecklists', () => ({ useChecklistFor: () => ({ items: [], source: 'builtin', key: 'default' }) }));
vi.mock('../settings/useSettings', async () => {
  const { catalogOf, DEFAULT_REASON_SETTINGS } = await import('../../domain/settings/reasons');
  const { DEFAULT_SLA_SETTINGS, DEFAULT_RULES_SETTINGS } = await import('../../domain/settings/settings');
  return { useSettings: () => ({ reasonCatalog: catalogOf(DEFAULT_REASON_SETTINGS), saved: { sla: false, rules: false }, sla: DEFAULT_SLA_SETTINGS, rules: DEFAULT_RULES_SETTINGS, products: [] }) };
});

import { QualificationPanel } from './QualificationPanel';
import { planCallOutcome, DEFAULT_CALL_RULES } from '../../domain/call/plan';
import { toListItem } from '../leads/mapLead';

const NOW = Date.UTC(2026, 9, 7, 8, 46);
const lead = { id: 'L1', fullName: 'Robert Alain', phone: '0612345678', email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'new', temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: NOW - 60_000, slaStartedAtMs: NOW - 60_000, slaStoppedAtMs: null, nextAction: null, documentsState: 'none', duplicate: false, excluded: false } as never;
const panel = (initialChoice?: 'close_now') => renderToString(<MemoryRouter><QualificationPanel lead={lead} durationSeconds={95} endedAtMs={NOW} nowMs={NOW} requestId="req-12345678" userId="u1" onSubmit={async () => ({ ok: true, summary: 'ok', status: 'file_building', nextActionAtMs: null, replay: false })} onCancel={() => undefined} initialChoice={initialChoice} /></MemoryRouter>).replace(/<!-- -->/g, '');

describe('« Conclure maintenant » dans « Comment s’est terminé l’appel ? »', () => {
  it('la tuile est disponible (plus « Bientôt disponible »)', () => {
    const h = panel();
    expect(h).toContain('Conclure maintenant');
    expect(h).not.toContain('Bientôt disponible');
  });
  it('choisie : explication, vente engagée distincte d’une vente, note facultative, validation possible', () => {
    const h = panel('close_now');
    expect(h).toContain('Le client accepte l’offre pendant l’appel');
    expect(h).toContain('engagée');
    expect(h).toContain('Note de la vente engagée');
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?\s*Valider et passer/);
  });
  it('le résultat est accepté par le même planificateur que le serveur : montage direct, sans documents', () => {
    const r = planCallOutcome({ kind: 'close_now', note: '  Accepte  ' }, { lead: { id: 'L1', status: 'new', ownerId: 'u1', productCode: 'PAC', nr: { attempt: 0, cycle: 1 }, nextActionId: null }, actorId: 'u1', actorRole: 'telepro', nowMs: NOW, requestId: 'r1', durationSeconds: 10, rules: DEFAULT_CALL_RULES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ status: 'file_building', directSale: true, documents: undefined, closure: undefined });
    expect(r.plan.nextAction).toMatchObject({ type: 'build_file', priority: 'P1' });
    expect(r.plan.slaStopAtMs).toBe(NOW);
    expect(r.plan.lastNote).toBe('Accepte');
  });
  it('un lead déjà converti ou clos ne peut pas « conclure maintenant »', () => {
    for (const status of ['converted', 'not_interested', 'fake_lead'] as const) {
      const r = planCallOutcome({ kind: 'close_now' }, { lead: { id: 'L1', status, ownerId: 'u1', productCode: 'PAC', nr: { attempt: 0, cycle: 1 }, nextActionId: null }, actorId: 'u1', actorRole: 'telepro', nowMs: NOW, requestId: 'r1', durationSeconds: 10, rules: DEFAULT_CALL_RULES });
      expect(r.ok).toBe(false);
    }
  });
  it('le lead engagé garde son indicateur dans la liste des leads', () => {
    const doc = { fullName: 'X', status: 'file_building', origin: { receivedAt: { toMillis: () => 1_000 } } };
    expect(toListItem('L1', { ...doc, directSale: true })?.directSale).toBe(true);
    expect(toListItem('L1', doc)?.directSale).toBeUndefined();
  });
});
