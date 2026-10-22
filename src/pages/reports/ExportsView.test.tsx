import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// Rendu serveur (sans navigateur) : vérifie que l'écran se construit et ce qu'il annonce selon le rôle.
let role: 'admin' | 'manager' = 'admin';
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'u1', role }, logout: async () => undefined }) }));
vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), logReportExport: async () => ({ ok: true }) }));

import { ExportsView } from './ExportsView';
import { camps, F, NOW, sold } from '../../domain/reports/reportsFixtures';
import type { ReportsData } from './useReportsData';

const data = { loading: false, error: null, leads: [sold('s1')], truncated: false, names: { users: new Map([['u1', 'Sarah']]), campaigns: new Map([['c1', 'PAC IDF']]) }, campaigns: [], reportCampaigns: camps, sources: [{ id: 'meta', name: 'Meta' }], spends: [] } as unknown as ReportsData;
const html = () => renderToString(<ExportsView data={data} filters={F} now={NOW} />);

describe('écran Exports', () => {
  it('administrateur : formulaire complet, filtres restitués, rappel de la permission', () => {
    role = 'admin';
    const h = html();
    expect(h).toContain('Créer un export');
    expect(h).toContain('Rapport Direction');
    expect(h).toContain('CSV (ouvre dans Excel)');
    expect(h).toContain('PDF (impression)');
    expect(h).toContain('Générer l’export');
    expect(h).toContain('Période');
    expect(h).toContain('01/09/2026 au 30/09/2026');
    expect(h).toContain('Aucun export généré depuis ce navigateur');
    expect(h).toContain('permission distincte');
    expect(h).not.toContain('Réservé à l’administrateur : votre export est toujours anonymisé');
  });
  it('manager : l’anonymisation est imposée et annoncée', () => {
    role = 'manager';
    expect(html()).toContain('Réservé à l’administrateur : votre export est toujours anonymisé');
  });
});
