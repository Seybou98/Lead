import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), saveMessages: async () => ({ ok: true }) }));
vi.mock('./useConfigData', async () => {
  const { defaultTemplates } = await import('../../domain/messages/templates');
  return { useConfigData: () => ({ settings: { loading: false, error: false, messages: defaultTemplates(), saved: { messages: false } }, catalog: { categories: [{ code: 'PAC' }, { code: 'SSC' }] } }) };
});

import { MessageTemplatesPage } from './MessageTemplatesPage';

describe('page Modèles de message', () => {
  const h = renderToString(<MemoryRouter><MessageTemplatesPage /></MemoryRouter>);
  it('les quatre déclencheurs, leurs arrêts automatiques et les variables', () => {
    for (const t of ['Passage en attente de documents', 'Dossier partiel', 'Offre envoyée', 'Financement incomplet']) expect(h).toContain(t);
    expect(h).toContain('Dès réception ou validation des pièces ciblées.');
    expect(h).toContain('{{signature}}');
  });
  it('aperçu avec un client fictif, sans variable restante', () => {
    expect(h).toContain('Aperçu (client fictif)');
    expect(h).toContain('Cordialement,');
    expect(h).toContain('Sarah Cohen');
    expect(h).not.toMatch(/Aperçu[\s\S]{0,400}\{\{prenom\}\}/);
  });
  it('indique les modèles d’origine tant que rien n’est enregistré ; ajout par produit proposé', () => {
    expect(h).toContain('ce sont les modèles d’origine qui s’appliquent');
    expect(h).toContain('Ajouter un modèle');
    expect(h).toContain('value="SSC"');
  });
});
