import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// Rendu serveur (sans navigateur) : les onglets selon le rôle, la liste des rapports programmés et l'historique.
let role: 'admin' | 'manager' = 'admin';
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'u1', role }, logout: async () => undefined }) }));
vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), logReportExport: async () => ({ ok: true }), saveExports: async () => ({ ok: true }) }));
vi.mock('../../lib/exportsApi', () => ({ fetchRuns: async () => ({ ok: true, runs: [] }), fetchRunFile: async () => ({ ok: false, message: 'x' }), runScheduleNow: async () => ({ ok: false, message: 'x' }), resendRunEmails: async () => ({ ok: false, message: 'x' }) }));
vi.mock('./useScheduledExports', async () => {
  const { zonedToMs } = await import('../../domain/reports/schedule');
  return {
    useScheduledExports: () => ({ loading: false, error: false, saved: true, schedules: [{ id: 's_1', name: 'Direction du lundi', kind: 'direction', format: 'csv', frequency: 'weekly', weekday: 1, dayOfMonth: 1, time: '08:00', period: 'previous_week', mode: 'event', sourceId: '', product: '', corrected: true, detail: false, attachCsv: false, recipients: ['u2'], active: true, endDate: '', createdAtMs: zonedToMs(2026, 9, 1, 0, 0) }] }),
    useRecipients: () => ({ loading: false, recipients: [{ uid: 'u2', name: 'Marie Manager', email: 'marie@x.fr', role: 'manager' }, { uid: 'u3', name: 'Sans Email', email: '', role: 'manager' }] }),
  };
});

import { ExportsHub } from './ExportsHub';
import { ScheduledView } from './ScheduledView';
import { HistoryView } from './HistoryView';
import { camps, F, NOW, sold } from '../../domain/reports/reportsFixtures';
import type { ReportsData } from './useReportsData';

const data = { loading: false, error: null, leads: [sold('s1')], truncated: false, names: { users: new Map(), campaigns: new Map() }, campaigns: [], reportCampaigns: camps, sources: [{ id: 'meta', name: 'Meta' }], spends: [] } as unknown as ReportsData;

describe('onglet Exports : sous-onglets', () => {
  it('administrateur : Exports, Rapports programmés, Historique', () => {
    role = 'admin';
    const h = renderToString(<ExportsHub data={data} filters={F} now={NOW} />);
    expect(h).toMatch(/role="tab"[^>]*>Rapports programmés</);
    expect(h).toMatch(/role="tab"[^>]*>Historique</);
    expect(h).toContain('Créer un export');
  });
  it('manager : pas de réglage des rapports programmés, mais l’historique de ses fichiers', () => {
    role = 'manager';
    const h = renderToString(<ExportsHub data={data} filters={F} now={NOW} />);
    expect(h).not.toMatch(/role="tab"[^>]*>Rapports programmés</);
    expect(h).toMatch(/role="tab"[^>]*>Historique</);
  });
});

describe('rapports programmés', () => {
  it('liste : fréquence, période, destinataires, prochaine échéance, actions de l’administrateur', () => {
    role = 'admin';
    const h = renderToString(<ScheduledView data={data} now={NOW} />);
    expect(h).toContain('Direction du lundi');
    expect(h).toContain('Tous les lundis à 08:00');
    expect(h).toContain('Semaine précédente');
    expect(h).toContain('Marie Manager');
    expect(h).toContain('Nouveau rapport programmé');
    expect(h).toContain('Exécuter Direction du lundi maintenant');
  });
  it('manager : lecture seule, aucune action', () => {
    role = 'manager';
    const h = renderToString(<ScheduledView data={data} now={NOW} />);
    expect(h).toContain('Direction du lundi');
    expect(h).not.toContain('Nouveau rapport programmé');
    expect(h).not.toContain('Exécuter Direction du lundi maintenant');
  });
  it('historique : chargement avant la réponse du serveur', () => {
    role = 'admin';
    expect(renderToString(<HistoryView />)).toContain('Historique des rapports programmés');
  });
});
