import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), saveDraft: async () => ({ ok: true }), discardDraft: async () => ({ ok: true }) }));
vi.mock('./useConfigData', () => ({
  useConfigData: () => ({
    loading: false, error: null, alerts: [], catalog: { categories: [{ code: 'PAC AIR/AIR', count: 3, samples: ['Daikin'] }] },
    coverage: [{ product: 'PAC AIR/AIR', checklist: 'own', teams: ['Équipe Paris'], telepros: 2, activeCampaigns: ['Campagne PAC'] }],
    settings: { loading: false, products: [{ code: 'PAC AIR/AIR', active: true, zones: ['75', '92'], aids: ['mpr', 'cee'], criteria: ['Propriétaire occupant'], note: '' }], drafts: {} },
  }),
}));
vi.mock('./useSettings', () => ({ useSettings: () => ({ products: [{ code: 'PAC AIR/AIR', active: true, zones: ['75', '92'], aids: ['mpr'], criteria: ['Propriétaire occupant', 'Maison individuelle'], note: 'Hors copropriété' }] }) }));

import { ProductsPage } from './ProductsPage';
import { ProductReference, ProductReferenceView } from '../qualification/ProductReference';
import { defaultRule } from '../../domain/products/rules';

describe('page Produits et offres', () => {
  it('périmètre et aides de chaque famille, bouton de configuration, brouillon', () => {
    const h = renderToString(<MemoryRouter><ProductsPage /></MemoryRouter>).replace(/<!-- -->/g, '');
    expect(h).toContain('Départements : 75, 92');
    expect(h).toContain('MaPrimeRénov’, CEE');
    expect(h).toContain('1 critère');
    expect(h).toContain('aria-label="Configurer PAC AIR/AIR"');
    expect(h).toContain('Enregistrer le brouillon');
  });
});

describe('repères du produit dans la qualification', () => {
  const rule = { code: 'PAC AIR/AIR', active: true, zones: ['75', '92'], aids: ['mpr' as const], criteria: ['Propriétaire occupant', 'Maison individuelle'], note: 'Hors copropriété' };
  it('zone couverte, aides, critères à confirmer', () => {
    const h = renderToString(<ProductReferenceView rule={rule} lead={{ postalCode: '75011', productCode: 'PAC AIR/AIR' }} />).replace(/<!-- -->/g, '');
    expect(h).toContain('Zone du lead couverte');
    expect(h).toContain('Aides compatibles : MaPrimeRénov’');
    expect(h).toContain('Propriétaire occupant');
    expect(h).toContain('Hors copropriété');
  });
  it('hors zone couverte et zone illisible sont distinguées', () => {
    expect(renderToString(<ProductReferenceView rule={rule} lead={{ postalCode: '69003', productCode: 'x' }} />).replace(/<!-- -->/g, '')).toContain('Hors zone couverte : ce produit est proposé dans les départements 75, 92.');
    expect(renderToString(<ProductReferenceView rule={rule} lead={{ postalCode: '', productCode: 'x' }} />)).toContain('zone à vérifier');
  });
  it('produit suspendu signalé ; règle vide ou absente : rien n’est affiché', () => {
    expect(renderToString(<ProductReferenceView rule={{ ...rule, active: false }} lead={{ postalCode: '75011', productCode: 'x' }} />)).toContain('Produit suspendu');
    expect(renderToString(<ProductReferenceView rule={defaultRule('SSC')} lead={{ postalCode: '75011', productCode: 'SSC' }} />)).toBe('');
    expect(renderToString(<ProductReferenceView rule={null} lead={{ postalCode: '75011', productCode: 'SSC' }} />)).toBe('');
  });
  it('branché sur les réglages publiés', () => {
    const lead = { postalCode: '75011', productCode: 'pac air/air' } as never;
    expect(renderToString(<ProductReference lead={lead} />)).toContain('Repères du produit');
  });
});
