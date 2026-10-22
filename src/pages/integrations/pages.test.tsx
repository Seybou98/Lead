import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { writeFileSync } from 'node:fs';

// Rendu serveur (sans navigateur) des écrans du hub d'intégrations, de l'import et de la saisie manuelle : ils se
// construisent et annoncent l'essentiel. Avec SNAP_DIR, le HTML est écrit pour un contrôle visuel.
const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const MIN = 60_000;

vi.mock('../../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));
vi.mock('firebase/firestore', () => ({ doc: () => ({}), collection: () => ({}), onSnapshot: () => () => undefined, getDocs: async () => ({ docs: [] }) }));
let role: 'admin' | 'manager' = 'admin';
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ state: 'ready', user: { uid: 'u1', role }, logout: async () => undefined }) }));
vi.mock('../../lib/hubApi', () => ({ fetchTransmissionErrors: async () => ({ ok: true, entries: [], truncated: false }), testMainCrmConnection: async () => ({ ok: true, reachable: true, ms: 12, message: 'ok' }), fetchJournal: async () => ({ ok: false, message: 'x' }), replayRawLead: async () => ({ ok: true, message: 'ok', kind: 'created', leadId: 'L1' }) }));
vi.mock('../../lib/adminApi', () => ({ errorMessage: (e: unknown) => String(e), saveSource: async () => ({ ok: true }) }));
vi.mock('../../lib/importApi', () => ({ newBatchId: () => 'b1', sendImportBatch: async () => ({ ok: false, message: 'x', retryable: false }) }));
vi.mock('../intake/useIntakeOptions', () => ({ useIntakeOptions: () => ({ loading: false, error: false, sources: [{ id: 'pabbly', name: 'Pabbly', enabled: true }], campaigns: [{ id: 'c1', name: 'PAC IDF', status: 'active' }], products: ['PAC', 'SSC'] }) }));
vi.mock('../leads/useLeadsData', () => ({ useNow: () => NOW }));

import { entryFromConversion, entryFromRaw, type JournalEntry } from '../../domain/integrations/hub';

const raw = (id: string, over = {}) => entryFromRaw({ id, receivedAtMs: NOW - 12 * MIN, channel: 'webhook', sourceId: 'pabbly', payloadJson: JSON.stringify({ full_name: 'Jean Dupont', phone: '0612345678', access_token: 'secret123', lead_id: `EXT-${id}` }), leadId: 'L1', processingState: 'processed', ...over }, NOW, 'Pabbly');
const ENTRIES: JournalEntry[] = [
  raw('a'),
  raw('b', { processingState: 'rejected', rejectionCode: 'no_contact', rejectionReason: 'Aucun téléphone ni email.', leadId: null }),
  entryFromRaw({ id: 'c', receivedAtMs: NOW - 40 * MIN, channel: 'import', sourceId: null, payloadJson: '{}', leadId: 'L2', processingState: 'processed', actorId: 'm1' }, NOW),
  entryFromConversion({ leadId: 'L9', state: 'failed', attempts: 5, lastError: { code: 'step_failed', message: 'Montant de subvention invalide' }, createdAtMs: NOW - 3_600_000, updatedAtMs: NOW - 30 * MIN }),
  entryFromConversion({ leadId: 'L8', state: 'confirmed', attempts: 1, createdAtMs: NOW - 7_200_000, updatedAtMs: NOW - 2 * 3_600_000, dossierId: 'D8' }),
].sort((x, y) => y.atMs - x.atMs);

vi.mock('./useJournal', async (orig) => ({ ...(await orig<typeof import('./useJournal')>()), useSchedulerStatus: () => ({ lastRunAtMs: NOW - MIN, statusReturn: { atMs: NOW - MIN, read: 14, changed: 3, cancelled: 1, errorCount: 2, errors: ['dossier D3 illisible'], durationMs: 2300 } }), useJournal: () => ({ loading: false, error: null, entries: ENTRIES, truncated: false, fetchedAtMs: NOW, refresh: async () => undefined }), useSchedulerLastRun: () => NOW - 3 * MIN }));

import { IntegrationsPage } from '../transmission/IntegrationsPage';
import { ErrorsPage } from './ErrorsPage';
import { JournalPage } from './JournalPage';
import { SourcesPage } from './SourcesPage';
import { ImportLeadsPage } from '../intake/ImportLeadsPage';
import { NewLeadPage } from '../intake/NewLeadPage';

// Le rendu serveur sépare les morceaux de texte par des commentaires : on les retire pour chercher du texte continu.
const render = (node: React.ReactNode, url = '/') => renderToString(<StaticRouter location={url}>{node}</StaticRouter>).replace(/<!-- -->/g, '');
const snap = (name: string, html: string) => { if (process.env.SNAP_DIR) writeFileSync(`${process.env.SNAP_DIR}/${name}.html`, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${process.env.SNAP_CSS}"></head><body class="bg-slate-50"><div class="p-6">${html}</div></body></html>`); };

describe('hub d’intégrations', () => {
  it('connecteurs : états réels, non connectés en V1, à surveiller', () => {
    const h = render(<IntegrationsPage />);
    snap('hub', h);
    expect(h).toContain('Intégrations &amp; synchronisations');
    for (const l of ['Réception des leads', 'Import CSV', 'Saisie manuelle', 'CRM principal', 'Planificateur serveur', 'Meta Lead Ads', 'SMS', 'WhatsApp Business']) expect(h).toContain(l);
    expect(h).toContain('Non connecté');
    expect(h).toContain('Opérationnel');
    expect(h).toContain('À surveiller');
    expect(h).toContain('Montant de subvention invalide');
    expect(h).toContain('Tentatives épuisées'.toLowerCase());
  });
  it('journal : opérations du jour, statuts, secrets absents', () => {
    const h = render(<JournalPage />);
    snap('journal', h);
    expect(h).toContain('Journal des synchronisations');
    expect(h).toContain('Transmission dossier');
    expect(h).toContain('Lead importé');
    expect(h).toContain('Erreur');
    expect(h).not.toContain('secret123');
  });
  it('erreurs et reprises : synthèse, onglets, priorités', () => {
    const h = render(<ErrorsPage />);
    snap('errors', h);
    expect(h).toContain('Erreurs &amp; reprises');
    expect(h).toContain('À traiter');
    expect(h).toContain('Résolues');
    expect(h).toContain('Critique');
    expect(h).toContain('Donnée invalide');
    expect(h).toContain('Relancer la sélection (0)');
  });
  it('sources de leads : adresses de réception, secret jamais affiché', () => {
    const h = render(<SourcesPage />);
    snap('sources', h);
    expect(h).toContain('Sources de leads');
    expect(h).toContain('/api/leads');
    expect(h).toContain('CL_INGEST_SECRET');
  });
});

describe('import et saisie manuelle', () => {
  it('import : première étape, formats annoncés', () => {
    const h = render(<ImportLeadsPage />);
    snap('import', h);
    expect(h).toContain('Importer des leads');
    expect(h).toContain('Cliquez ou déposez un fichier CSV');
    expect(h).toContain('2 000 lignes');
  });
  it('saisie manuelle : formulaire complet, sources, campagnes et produits proposés', () => {
    const h = render(<NewLeadPage />);
    snap('newlead', h);
    expect(h).toContain('Nouveau lead');
    for (const l of ['Prénom', 'Téléphone', 'Email', 'Code postal', 'Pabbly', 'PAC IDF', 'SSC', 'Créer le lead']) expect(h).toContain(l);
    expect(h).toContain('au moins un téléphone ou un email');
  });
});

describe('hub d’intégrations : délais, retour des statuts, accès manager', () => {
  it('connecteurs : trace du retour des statuts, test de connexion, alerte', () => {
    role = 'admin';
    const h = render(<IntegrationsPage />);
    expect(h).toContain('Retour des statuts');
    expect(h).toContain('14 dossiers lus, 3 étapes changées, 1 annulée');
    expect(h).toContain('2 erreurs');
    expect(h).toContain('Tester la connexion');
    expect(h).toContain('Retour des statuts du CRM principal : erreurs');
  });
  it('journal : colonne Durée', () => {
    role = 'admin';
    expect(render(<JournalPage />)).toContain('>Durée<');
  });
  it('manager : seulement les erreurs de transmission de son équipe, aucun connecteur', () => {
    role = 'manager';
    const h = render(<IntegrationsPage />);
    expect(h).toContain('Erreurs de transmission');
    expect(h).toContain('Les dossiers de votre équipe');
    expect(h).not.toContain('Planificateur serveur');
    expect(h).not.toContain('Tester la connexion');
    role = 'admin';
  });
});
