import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'u1', role: 'telepro', name: 'Sarah Cohen' }, logout: async () => undefined }) }));
vi.mock('../leads/useLeadsData', () => ({ useLeadsList: () => ({ loading: false, error: null, items: [], truncated: false, names: { users: new Map(), campaigns: new Map() } }) }));
vi.mock('../settings/useSettings', async () => {
  const { defaultTemplates } = await import('../../domain/messages/templates');
  return { useSettings: () => ({ messages: defaultTemplates() }) };
});

import { MessagesView, piecesOf } from './MessagesPage';
import { defaultTemplates } from '../../domain/messages/templates';
import type { LeadListItem } from '../../domain/leads/leadList';

const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: 'Awa Diallo', phone: '0612345678', email: 'awa@mail.fr', city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'awaiting_documents', temperature: null,
  assignmentState: 'assigned', bufferReason: null, ownerId: 'u1', receivedAtMs: 1, slaStartedAtMs: null, slaStoppedAtMs: 2, nextAction: null, documentsState: 'partial', duplicate: false, excluded: false,
  docs: { expected: 3, received: 1, conform: 1, mandatory: 3, mandatoryConform: 1, toCheck: 0, lastReceivedAtMs: 1, completedAtMs: null, lastRequestAtMs: 1, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0,
    missing: [{ code: 'id', label: 'Pièce d’identité', status: 'non_conform', koReason: 'unreadable' }, { code: 'tax', label: 'Avis d’imposition', status: 'expected', koReason: null }, { code: 'rib', label: 'RIB', status: 'conform', koReason: null }] }, ...over,
});
const render = (leads: LeadListItem[], templates = defaultTemplates()) => renderToString(<MemoryRouter><MessagesView leads={leads} loading={false} error={null} telepro="Sarah Cohen" templates={templates} /></MemoryRouter>);

describe('pièces citées', () => {
  it('seulement ce qui manque ou a été rejeté, avec le motif', () => {
    expect(piecesOf(lead('a'))).toEqual(['Pièce d’identité (illisible)', 'Avis d’imposition']);
  });
});

describe('écran Messages du télépro', () => {
  it('message rendu : identité du télépro, pièces exactes, signature ; le CRM n’envoie rien', () => {
    const h = render([lead('a')]);
    expect(h).toContain('Awa Diallo');
    expect(h).toContain('Dossier partiel');
    expect(h).toContain('Pièce d’identité (illisible)');
    expect(h).toContain('Avis d’imposition');
    expect(h).not.toContain('RIB');
    expect(h).toContain('Le CRM n’envoie rien lui-même');
    expect(h).toContain('Objet : ');
  });
  it('liens d’ouverture : messagerie quand le lead a un email', () => {
    expect(render([lead('a')])).toContain('href="mailto:awa%40mail.fr?subject=');
    expect(render([lead('a', { email: null })])).toContain('Pas d’adresse email sur ce lead.');
  });
  it('lead sans rien à envoyer, ou exclu : aucun message', () => {
    expect(render([lead('a', { status: 'new', documentsState: 'none', docs: undefined })])).toContain('Aucun message à envoyer');
    expect(render([lead('a', { excluded: true })])).toContain('Aucun message à envoyer');
  });
  it('documents demandés sans aucune pièce à citer : rien à envoyer', () => {
    expect(render([lead('a', { documentsState: 'requested', docs: { ...lead('x').docs!, missing: [] } })])).toContain('Aucun message à envoyer');
  });
  it('compteurs par déclencheur ; offre envoyée déclenche son message', () => {
    const h = render([lead('a'), lead('b', { status: 'converted', documentsState: 'complete', commercialState: 'offer_sent', docs: undefined })]).replace(/<!-- -->/g, '');
    expect(h).toContain('Tous (2)');
    expect(h).toContain('Dossier partiel (1)');
    expect(h).toContain('Offre envoyée (1)');
  });
  it('aucun modèle actif : l’écran le dit et renvoie vers l’administrateur', () => {
    expect(render([lead('a')], [])).toContain('Aucun modèle actif');
  });
});
