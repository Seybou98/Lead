import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SLA_SETTINGS } from '../../domain/settings/settings';

const NOW = Date.UTC(2026, 9, 22, 10, 0);
let hasDraft = true;
let baseMs = NOW - 86_400_000;
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'adm', role: 'admin' }, logout: async () => undefined }) }));
vi.mock('../leads/useLeadsData', () => ({ useLeadsList: () => ({ loading: false, error: null, items: [], truncated: false, names: { users: new Map(), campaigns: new Map() } }) }));
vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), publishDraft: async () => ({ ok: true }), discardDraft: async () => ({ ok: true }) }));
vi.mock('./useConfigData', () => ({ useConfigData: () => ({ campaigns: [] }) }));
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    loading: false,
    drafts: hasDraft ? { sla: { doc: { ...DEFAULT_SLA_SETTINGS, firstAlertMin: 8 }, meta: { atMs: NOW, byId: 'adm', baseMs } } } : {},
    published: { sla: { ...DEFAULT_SLA_SETTINGS, updatedAt: { toMillis: () => NOW - 86_400_000 } } },
  }),
}));

import { PublishPage } from './PublishPage';
import { DraftBanner } from './DraftBanner';

const page = (path: string) => renderToString(<MemoryRouter initialEntries={[path]}><Routes><Route path="/parametres/publier/:module" element={<PublishPage />} /></Routes></MemoryRouter>).replace(/<!-- -->/g, '');

describe('page de publication', () => {
  it('les quatre étapes du cycle et les différences avec le publié', () => {
    hasDraft = true;
    baseMs = NOW - 86_400_000;
    const h = page('/parametres/publier/sla');
    for (const t of ['Brouillon', 'Tester (données fictives)', 'Vérifier l’impact', 'Publier']) expect(h).toContain(t);
    expect(h).toContain('Première alerte : 5 min → 8 min');
    expect(h).toContain('Lancer le test');
  });
  it('publication impossible tant que le test, l’impact et la justification manquent', () => {
    const h = page('/parametres/publier/sla');
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?\s*Publier<\/button>/);
    expect(h).toContain('Lancez le test.');
    expect(h).toContain('Lancez d’abord le test.');
  });
  it('réglage publié modifié depuis le brouillon : alerte, publication refusée', () => {
    baseMs = NOW - 5_000;
    expect(page('/parametres/publier/sla')).toContain('Le réglage publié a changé depuis l’enregistrement de ce brouillon');
  });
  it('sans brouillon : message clair, lien vers le réglage', () => {
    hasDraft = false;
    const h = page('/parametres/publier/sla');
    expect(h).toContain('Aucun brouillon en préparation');
    expect(h).toContain('href="/parametres/sla"');
  });
  it('module inconnu : refusé', () => {
    expect(page('/parametres/publier/zzz')).toContain('Réglage inconnu');
  });
});

describe('bandeau de brouillon', () => {
  it('visible seulement avec un brouillon, avec le lien de publication', () => {
    const d = { doc: {}, meta: { atMs: NOW, byId: 'adm', baseMs: 0 } };
    const h = renderToString(<MemoryRouter><DraftBanner module="rules" draft={d} /></MemoryRouter>);
    expect(h).toContain('Brouillon en préparation');
    expect(h).toContain('il n’affecte aucun lead');
    expect(h).toContain('href="/parametres/publier/rules"');
    expect(renderToString(<MemoryRouter><DraftBanner module="rules" draft={undefined} /></MemoryRouter>)).toBe('');
  });
});
