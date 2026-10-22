import { describe, expect, it } from 'vitest';
import { CONNECTORS, connectorCards, diagnosticRows, entryFromConversion, entryFromRaw, entryFromReplayAudit, errorCategory, errorList, errorSummary, externalIdOf, filterEntries, MASK, maskPayload, NO_FILTERS, priorityOf, sortJournal, statsOf, STUCK_AFTER_MS, watchItems, type JournalEntry, type RawLeadTrace } from './hub';

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const raw = (over: Partial<RawLeadTrace> = {}): RawLeadTrace => ({ id: 'r1', receivedAtMs: NOW - 10 * MIN, channel: 'webhook', sourceId: 'pabbly', payloadJson: JSON.stringify({ full_name: 'Jean Dupont', phone: '0612345678', lead_id: 'EXT-42' }), leadId: 'L1', processingState: 'processed', ...over });
const rejected = (over: Partial<RawLeadTrace> = {}) => entryFromRaw(raw({ id: 'rx', processingState: 'rejected', rejectionCode: 'no_contact', rejectionReason: 'Aucun téléphone ni email.', leadId: null, ...over }), NOW, 'Pabbly');
const conv = (state: string, over = {}) => entryFromConversion({ leadId: 'L9', state, attempts: 2, createdAtMs: NOW - HOUR, updatedAtMs: NOW - 30 * MIN, ...over });

describe('masquage des secrets', () => {
  it('clés sensibles masquées à tous les niveaux, le reste intact', () => {
    const out = JSON.parse(maskPayload(JSON.stringify({ name: 'Jean', access_token: 'abc', nested: { apiKey: 'k', Authorization: 'Bearer x', list: [{ client_secret: 's', ok: 1 }] } })) as string);
    expect(out).toEqual({ name: 'Jean', access_token: MASK, nested: { apiKey: MASK, Authorization: MASK, list: [{ client_secret: MASK, ok: 1 }] } });
  });
  it('payload illisible : rendu tel quel, ou masqué s’il évoque un secret', () => {
    expect(maskPayload('pas du json')).toBe('pas du json');
    expect(maskPayload('token=abc')).toBe(MASK);
  });
  it('vide : null ; trop long : tronqué', () => {
    expect(maskPayload(null)).toBeNull();
    expect(maskPayload(JSON.stringify({ a: 'x'.repeat(250), b: Array.from({ length: 200 }, (_, i) => i) }), 200)!.length).toBeLessThanOrEqual(203);
  });
  it('cellule de texte très longue raccourcie', () => {
    expect(JSON.parse(maskPayload(JSON.stringify({ a: 'x'.repeat(900) })) as string).a.length).toBe(301);
  });
});

describe('identifiant externe', () => {
  it('lu avec les synonymes de la réception', () => {
    expect(externalIdOf(JSON.stringify({ leadgen_id: 'LG-1' }))).toBe('LG-1');
    expect(externalIdOf(JSON.stringify({ external_id: 12345 }))).toBe('12345');
    expect(externalIdOf(JSON.stringify({ phone: '1' }))).toBeNull();
    expect(externalIdOf('nope')).toBeNull();
  });
});

describe('données brutes → entrées du journal', () => {
  it('lead traité : réussie, référence = identifiant externe', () => {
    const e = entryFromRaw(raw(), NOW, 'Pabbly');
    expect(e).toMatchObject({ id: 'raw_r1', connector: 'webhook', operation: 'Lead reçu', reference: 'EXT-42', leadId: 'L1', status: 'success', error: null, replayable: false, sourceLabel: 'Pabbly', kind: 'raw' });
  });
  it('sans identifiant externe : le lead, puis la trace', () => {
    expect(entryFromRaw(raw({ payloadJson: '{}' }), NOW).reference).toBe('L1');
    expect(entryFromRaw(raw({ payloadJson: '{}', leadId: null }), NOW).reference).toBe('r1');
  });
  it('lead refusé : erreur avec le motif, reprise possible', () => {
    const e = rejected();
    expect(e).toMatchObject({ status: 'error', replayable: true, resolvedAtMs: null, error: { code: 'no_contact', message: 'Aucun téléphone ni email.' } });
  });
  it('refus déjà repris : résolu, plus de reprise', () => {
    const e = rejected({ replayedAtMs: NOW - MIN });
    expect(e).toMatchObject({ replayable: false, resolvedAtMs: NOW - MIN, status: 'error' });
  });
  it('reçu récemment et pas encore traité : en attente ; au-delà du délai : erreur à reprendre', () => {
    expect(entryFromRaw(raw({ processingState: 'received', receivedAtMs: NOW - MIN }), NOW).status).toBe('pending');
    const stuck = entryFromRaw(raw({ processingState: 'received', receivedAtMs: NOW - STUCK_AFTER_MS - MIN }), NOW);
    expect(stuck).toMatchObject({ status: 'error', replayable: true, error: { code: 'stuck' } });
  });
  it('canaux : import, saisie manuelle et API ont leur connecteur et leur libellé', () => {
    expect(entryFromRaw(raw({ channel: 'import' }), NOW)).toMatchObject({ connector: 'import', operation: 'Lead importé' });
    expect(entryFromRaw(raw({ channel: 'manual', actorId: 'm1' }), NOW)).toMatchObject({ connector: 'manual', operation: 'Lead saisi', actorId: 'm1' });
    expect(entryFromRaw(raw({ channel: 'api' }), NOW).connector).toBe('api');
  });
  it('le payload est masqué', () => {
    const e = entryFromRaw(raw({ payloadJson: JSON.stringify({ phone: '0612345678', access_token: 'secret123' }) }), NOW);
    expect(e.payload).toContain(MASK);
    expect(e.payload).not.toContain('secret123');
  });
});

describe('transmissions → entrées du journal', () => {
  it('confirmée : réussie ; échouée : erreur avec le message ; en cours : en attente', () => {
    expect(conv('confirmed', { dossierId: 'D1' })).toMatchObject({ status: 'success', reference: 'D1', connector: 'crm_main', operation: 'Transmission dossier' });
    expect(conv('failed', { lastError: { code: 'step_failed', message: 'Montant invalide' } })).toMatchObject({ status: 'error', error: { code: 'step_failed', message: 'Montant invalide' }, attempts: 2 });
    for (const s of ['pending', 'sent', 'dossier_created']) expect(conv(s).status).toBe('pending');
  });
  it('échec sans message : message par défaut, jamais vide', () => {
    expect(conv('failed').error?.message).toBe('Transmission échouée.');
  });
  it('la reprise d’une transmission n’est pas proposée ici (écran Transmission)', () => {
    expect(conv('failed').replayable).toBe(false);
  });
});

describe('reprise manuelle', () => {
  it('tracée avec son auteur', () => {
    const e = entryFromReplayAudit({ id: 'a1', atMs: NOW, actorId: 'adm', rawLeadId: 'rx', outcome: 'created', leadId: 'L5' });
    expect(e).toMatchObject({ operation: 'Reprise manuelle', actorId: 'adm', status: 'success', reference: 'L5', kind: 'audit' });
    expect(entryFromReplayAudit({ id: 'a2', atMs: NOW, actorId: 'adm', rawLeadId: 'rx', outcome: 'rejected', leadId: null }).status).toBe('error');
  });
});

describe('statistiques', () => {
  const list: JournalEntry[] = [entryFromRaw(raw(), NOW), entryFromRaw(raw({ id: 'r2' }), NOW), rejected(), rejected({ id: 'ry', replayedAtMs: NOW }), entryFromRaw(raw({ id: 'r3', processingState: 'received', receivedAtMs: NOW - MIN }), NOW)];
  it('réussies, en attente, en erreur (non résolues) et taux sur les opérations terminées', () => {
    const s = statsOf(list);
    expect(s).toMatchObject({ total: 5, pending: 1, error: 1 });
    // 2 réussies + 1 erreur reprise (résolue) comptées réussies ; 1 erreur ouverte → 3 sur 4
    expect(s.success).toBe(3);
    expect(s.successRate).toBe(75);
  });
  it('aucune opération terminée : pas de taux, jamais 0 %', () => {
    expect(statsOf([]).successRate).toBeNull();
    expect(statsOf([entryFromRaw(raw({ processingState: 'received', receivedAtMs: NOW - MIN }), NOW)]).successRate).toBeNull();
  });
});

describe('états des connecteurs', () => {
  const cards = (entries: JournalEntry[], scheduler: number | null = NOW - 2 * MIN) => Object.fromEntries(connectorCards(entries, NOW, scheduler).map((c) => [c.def.id, c]));
  it('un connecteur qui n’existe pas en V1 est « non connecté », jamais opérationnel', () => {
    const c = cards([]);
    for (const id of ['meta', 'google_ads', 'email', 'sms', 'whatsapp', 'signature', 'financing']) expect(c[id].state).toBe('not_connected');
    expect(CONNECTORS.filter((d) => !d.live).length).toBe(7);
  });
  it('connecteur sans aucune trace : « aucune activité »', () => {
    expect(cards([]).import.state).toBe('inactive');
  });
  it('trace réussie récente : opérationnel, volume des 24 h et dernier succès', () => {
    const c = cards([entryFromRaw(raw(), NOW), entryFromRaw(raw({ id: 'old', receivedAtMs: NOW - 2 * DAY }), NOW)]).webhook;
    expect(c).toMatchObject({ state: 'operational', daily: 1, errors24h: 0, lastSuccessAtMs: NOW - 10 * MIN });
  });
  it('erreur non résolue dans les 24 h ou opération en attente : attention', () => {
    expect(cards([entryFromRaw(raw(), NOW), rejected()]).webhook).toMatchObject({ state: 'attention', errors24h: 1 });
    expect(cards([conv('pending')]).crm_main.state).toBe('attention');
  });
  it('erreur reprise : plus d’attention', () => {
    expect(cards([entryFromRaw(raw(), NOW), rejected({ replayedAtMs: NOW })]).webhook.state).toBe('operational');
  });
  it('planificateur : opérationnel s’il a passé il y a moins de 15 min, sinon attention ; jamais passé : aucune activité', () => {
    expect(cards([]).scheduler.state).toBe('operational');
    expect(cards([], NOW - 20 * MIN).scheduler.state).toBe('attention');
    expect(cards([], null).scheduler.state).toBe('inactive');
  });
});

describe('à surveiller', () => {
  it('erreurs regroupées par connecteur et cause, la plus grave d’abord', () => {
    const w = watchItems([rejected(), rejected({ id: 'rz' }), conv('failed', { attempts: 5, lastError: { code: 'step_failed', message: 'Montant invalide' } })], NOW, NOW);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ connector: 'crm_main', level: 'critical' });
    expect(w[0].detail).toContain('tentatives épuisées');
    expect(w[1]).toMatchObject({ connector: 'webhook', level: 'warning' });
    expect(w[1].detail).toContain('2 éléments');
  });
  it('erreurs résolues ignorées ; planificateur arrêté et opérations en attente signalés', () => {
    expect(watchItems([rejected({ replayedAtMs: NOW })], NOW, NOW)).toEqual([]);
    expect(watchItems([], NOW, NOW - 30 * MIN).map((x) => x.id)).toEqual(['scheduler_stale']);
    expect(watchItems([conv('pending', { updatedAtMs: NOW - 2 * HOUR })], NOW, NOW).map((x) => x.id)).toEqual(['pending_old']);
  });
  it('rien à signaler : liste vide', () => expect(watchItems([entryFromRaw(raw(), NOW)], NOW, NOW)).toEqual([]));
});

describe('filtres du journal', () => {
  const list = sortJournal([entryFromRaw(raw({ id: 'a', receivedAtMs: NOW - HOUR }), NOW), rejected(), entryFromRaw(raw({ id: 'b', channel: 'import', receivedAtMs: NOW - 3 * DAY, leadId: 'L7', payloadJson: '{}' }), NOW), conv('failed')]);
  it('période : aujourd’hui exclut hier', () => {
    expect(filterEntries(list, NO_FILTERS, NOW).map((e) => e.id).sort()).toEqual(['conv_L9', 'raw_a', 'raw_rx']);
    expect(filterEntries(list, { ...NO_FILTERS, period: '7d' }, NOW)).toHaveLength(4);
    expect(filterEntries(list, { ...NO_FILTERS, period: 'all' }, NOW)).toHaveLength(4);
  });
  it('connecteur, opération, statut', () => {
    const all = { ...NO_FILTERS, period: 'all' as const };
    expect(filterEntries(list, { ...all, connector: 'import' }, NOW).map((e) => e.id)).toEqual(['raw_b']);
    expect(filterEntries(list, { ...all, operation: 'Transmission dossier' }, NOW)).toHaveLength(1);
    expect(filterEntries(list, { ...all, status: 'error' }, NOW)).toHaveLength(2);
  });
  it('recherche : identifiant externe, lead, identifiant de trace, accents et casse ignorés', () => {
    const all = { ...NO_FILTERS, period: 'all' as const };
    expect(filterEntries(list, { ...all, search: 'ext-42' }, NOW).map((e) => e.id).sort()).toEqual(['raw_a', 'raw_rx']);
    expect(filterEntries(list, { ...all, search: 'l7' }, NOW).map((e) => e.id)).toEqual(['raw_b']);
    expect(filterEntries(list, { ...all, search: 'pabbly' }, NOW).length).toBeGreaterThan(0);
    expect(filterEntries(list, { ...all, search: 'zzz' }, NOW)).toEqual([]);
  });
  it('tri : le plus récent d’abord, départage stable', () => {
    const t = sortJournal([entryFromRaw(raw({ id: 'b', receivedAtMs: 5 }), NOW), entryFromRaw(raw({ id: 'a', receivedAtMs: 5 }), NOW), entryFromRaw(raw({ id: 'c', receivedAtMs: 9 }), NOW)]);
    expect(t.map((e) => e.sourceId)).toEqual(['c', 'a', 'b']);
  });
});

describe('erreurs et reprises', () => {
  const open = rejected();
  const done = rejected({ id: 'rd', replayedAtMs: NOW - 2 * MIN });
  const cm = conv('failed', { attempts: 5 });
  const list = [open, done, cm, entryFromRaw(raw(), NOW)];
  it('onglets : à traiter / résolues', () => {
    expect(errorList(list, 'open').map((e) => e.id).sort()).toEqual(['conv_L9', 'raw_rx']);
    expect(errorList(list, 'resolved').map((e) => e.id)).toEqual(['raw_rd']);
  });
  it('priorité : transmission au CRM, tentatives épuisées ou ancienneté = critique', () => {
    expect(priorityOf(cm, NOW)).toBe('critical');
    expect(priorityOf(open, NOW)).toBe('to_check');
    expect(priorityOf(rejected({ id: 'old', receivedAtMs: NOW - 2 * DAY }), NOW)).toBe('critical');
  });
  it('catégories', () => {
    expect(errorCategory(open)).toBe('Donnée invalide');
    expect(errorCategory(rejected({ rejectionCode: 'unknown_source' }))).toBe('Configuration');
    expect(errorCategory(cm)).toBe('Erreur technique');
  });
  it('synthèse du mois', () => {
    expect(errorSummary(list, NOW)).toEqual({ open: 2, replayable: 1, critical: 1, resolvedThisMonth: 1 });
  });
});

describe('diagnostic exportable', () => {
  it('lignes lisibles, sans charge utile ni secret', () => {
    const rows = diagnosticRows([entryFromRaw(raw({ payloadJson: JSON.stringify({ access_token: 'secret123', phone: '0612345678' }) }), NOW), conv('failed')]);
    expect(rows[0]).toContain('Erreur');
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain('secret123');
    expect(JSON.stringify(rows)).not.toContain('0612345678');
    expect(rows[1][1]).toBe('Réception des leads');
  });
});
