import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { catalogOf, DEFAULT_REASON_SETTINGS } from '../../domain/settings/reasons';

vi.mock('../settings/useSettings', () => ({ useSettings: () => ({ reasonCatalog: catalogOf(DEFAULT_REASON_SETTINGS) }) }));
vi.mock('../../lib/cockpitAlertApi', () => ({ sendAlertAction: async () => ({ ok: true, replay: false, message: 'ok' }) }));
vi.mock('../../lib/reassignApi', () => ({ sendReassign: async () => ({ ok: true, replay: false, message: 'ok', ownerId: 'u' }) }));

import { AlertDecision } from './AlertDecision';
import { BulkBar } from './BulkBar';
import { ListPanel } from './CockpitPanel';
import type { LeadIssue, TeamRow } from '../../domain/cockpit/cockpit';
import type { LeadListItem } from '../../domain/leads/leadList';

const lead = (id: string): LeadListItem => ({ id, fullName: `Client ${id}`, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'callback', temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: 0, slaStartedAtMs: null, slaStoppedAtMs: null, nextAction: null, documentsState: 'none', duplicate: false, excluded: false });
const issue = (id: string, key: LeadIssue['key']): LeadIssue => ({ lead: lead(id), sinceMs: 1000, severity: 'high', reason: 'Rappel en retard', key });
const team: TeamRow[] = [{ uid: 'u2', name: 'Mehdi', state: { label: 'Disponible', tone: 'green' }, distribution: 'active', current: null, newLeads: 1, cap: 10, workload: { callbacks: 0, interested: 0, documents: 0 }, assignedInPeriod: 0, result: { sales: 0, installed: 0, invoiced: 0 }, alert: null }];
const names = { users: new Map([['u1', 'Sarah']]), campaigns: new Map<string, string>() };

describe('décision sur une alerte', () => {
  it('rappel : clôture avec motif obligatoire (liste administrable) ou report', () => {
    const h = renderToString(<AlertDecision leadId="L1" alertKey="callback" sinceMs={1} onDone={() => undefined} />);
    expect(h).toContain('Rappel en retard');
    expect(h).toContain('clôturer ou reporter');
    expect(h).toContain('Motif (obligatoire)');
    expect(h).toContain('Traité hors du CRM');
    expect(h).toContain('Clôturer l’alerte');
    expect(h).not.toContain('disabled=""');
  });
  it('lead neuf hors SLA : le report est désactivé et expliqué', () => {
    const h = renderToString(<AlertDecision leadId="L1" alertKey="sla" sinceMs={1} onDone={() => undefined} />);
    expect(h).toMatch(/disabled=""[^>]*title="Un lead neuf hors SLA ne se reporte pas/);
  });
});

describe('actions de masse', () => {
  it('liste : cases à cocher et « Tout sélectionner » seulement quand les actions de masse sont proposées', () => {
    const issues = [issue('a', 'callback'), issue('b', 'docs')];
    const withBulk = renderToString(<MemoryRouter><ListPanel title="Rappels" issues={issues} nowMs={5000} names={names} onPick={() => undefined} onClose={() => undefined} bulk={{ team, canAct: true, onDone: () => undefined }} /></MemoryRouter>);
    expect(withBulk).toContain('Tout sélectionner');
    expect(withBulk).toContain('Sélectionner Client a');
    const without = renderToString(<MemoryRouter><ListPanel title="Rappels" issues={issues} nowMs={5000} names={names} onPick={() => undefined} onClose={() => undefined} /></MemoryRouter>);
    expect(without).not.toContain('Tout sélectionner');
  });
  it('barre : attribuer (motif obligatoire), reporter (seulement ce qui se reporte), exporter', () => {
    const h = renderToString(<BulkBar issues={[issue('a', 'callback'), issue('b', 'sla')]} team={team} names={names} canAct onDone={() => undefined} />);
    expect(h.replace(/<!-- -->/g, '')).toContain('2 leads sélectionnés');
    expect(h).toContain('Attribuer à…');
    expect(h.replace(/<!-- -->/g, '')).toContain('Mehdi (recommandé)');
    expect(h).toMatch(/Reporter \(<!-- -->1<!-- -->\)/);
    expect(h).toContain('Exporter la sélection');
  });
  it('sans droit d’agir : export seulement', () => {
    const h = renderToString(<BulkBar issues={[issue('a', 'callback')]} team={team} names={names} canAct={false} onDone={() => undefined} />);
    expect(h).not.toContain('Attribuer à…');
    expect(h).toContain('Exporter la sélection');
  });
});
