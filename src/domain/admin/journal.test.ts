import { describe, expect, it } from 'vitest';
import {
  buildJournalRows,
  explainDecision,
  filterJournalRows,
  journalToCsv,
  motifLabel,
  NO_JOURNAL_FILTERS,
  shortLeadId,
  type JournalEntry,
  type JournalNames,
} from './journal';

const T = Date.UTC(2026, 9, 6, 14, 2);
const names: JournalNames = {
  users: new Map([
    ['sarah', 'Sarah'],
    ['mehdi', 'Mehdi'],
    ['laura', 'Laura'],
  ]),
  campaigns: new Map([['c1', 'PAC IDF — Septembre']]),
};

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'e1',
  atMs: T,
  leadId: 'abcdef123456',
  leadName: 'Jean Dupont',
  campaignId: 'c1',
  event: 'assign',
  mode: 'real',
  chosenOwnerId: 'sarah',
  previousOwnerId: null,
  actorId: 'engine',
  reason: 'lowest_active_load',
  ruleApplied: 'lowest_active_load>fewest_new_leads>oldest_last_assignment>stable_hash',
  candidates: [
    { uid: 'sarah', eligible: true, exclusions: [], activeLoad: 4, newLeads: 4, cap: 10 },
    { uid: 'mehdi', eligible: true, exclusions: [], activeLoad: 8, newLeads: 8, cap: 10 },
    { uid: 'laura', eligible: false, exclusions: ['status_in_meeting'], activeLoad: 3, newLeads: 3, cap: 10 },
  ],
  ...over,
});

describe('motifLabel', () => {
  it('traduit les motifs du moteur', () => {
    expect(motifLabel('lowest_active_load')).toBe('Charge active la plus faible');
    expect(motifLabel('capacity_reached')).toBe('Plafond atteint');
    expect(motifLabel('auto_distribution_off')).toBe('Distribution automatique désactivée');
  });
  it('affiche tel quel un motif libre saisi par un manager', () => {
    expect(motifLabel('Demande manager')).toBe('Demande manager');
  });
  it('absent : tiret', () => expect(motifLabel(null)).toBe('—'));
});

describe('buildJournalRows', () => {
  it('une ligne par décision, du plus récent au plus ancien', () => {
    const rows = buildJournalRows([entry({ id: 'old', atMs: T - 1000 }), entry({ id: 'new', atMs: T })], names);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
  });
  it('affiche identifiant court, nom du lead, campagne, télépro, motif et statut', () => {
    const [r] = buildJournalRows([entry()], names);
    expect(r).toMatchObject({
      leadLabel: 'LEAD-ABCDEF — Jean Dupont',
      campaignName: 'PAC IDF — Septembre',
      eventLabel: 'Attribution automatique',
      ownerName: 'Sarah',
      motif: 'Charge active la plus faible',
      status: 'success',
    });
  });
  it('lead sans nom connu (ancienne entrée) : identifiant seul', () => {
    expect(buildJournalRows([entry({ leadName: null })], names)[0].leadLabel).toBe(shortLeadId('abcdef123456'));
  });
  it('file tampon : « En attente », aucun télépro', () => {
    const [r] = buildJournalRows([entry({ event: 'buffer', chosenOwnerId: null, reason: 'capacity_reached' })], names);
    expect(r).toMatchObject({ status: 'pending', ownerName: '—', motif: 'Plafond atteint', eventLabel: 'File tampon' });
  });
  it('utilisateur ou campagne introuvable : l\'identifiant, jamais un champ vide', () => {
    const [r] = buildJournalRows([entry({ chosenOwnerId: 'inconnu', campaignId: 'cx' })], names);
    expect(r.ownerName).toBe('inconnu');
    expect(r.campaignName).toBe('cx');
  });
  it('campagne absente : tiret', () => {
    expect(buildJournalRows([entry({ campaignId: null })], names)[0].campaignName).toBe('—');
  });
});

describe('filterJournalRows', () => {
  const rows = buildJournalRows(
    [
      entry({ id: '1', atMs: T }),
      entry({ id: '2', atMs: T - 3600_000, chosenOwnerId: 'mehdi', leadId: 'zzzzzz999', leadName: 'Chloé Bernard' }),
      entry({ id: '3', atMs: T - 7200_000, event: 'buffer', chosenOwnerId: null, campaignId: null }),
    ],
    names
  );
  it('sans filtre : tout', () => expect(filterJournalRows(rows, NO_JOURNAL_FILTERS)).toHaveLength(3));
  it('période : borne basse incluse, haute exclue', () => {
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, fromMs: T - 3600_000, toMs: T }).map((r) => r.id)).toEqual(['2']);
  });
  it('campagne, télépro, événement', () => {
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, campaignId: 'c1' })).toHaveLength(2);
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, ownerId: 'mehdi' }).map((r) => r.id)).toEqual(['2']);
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, event: 'buffer' }).map((r) => r.id)).toEqual(['3']);
  });
  it('recherche par identifiant ou nom, sans accents ni casse', () => {
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, search: 'chloe' }).map((r) => r.id)).toEqual(['2']);
    expect(filterJournalRows(rows, { ...NO_JOURNAL_FILTERS, search: 'ZZZZZZ' }).map((r) => r.id)).toEqual(['2']);
  });
});

describe('explainDecision — « Pourquoi Sarah ? »', () => {
  const ex = explainDecision(entry(), names);

  it('chronologie : reçu, éligibilité, attribution', () => {
    expect(ex.timeline.map((t) => t.title)).toEqual(['Lead reçu', 'Éligibilité analysée', 'Attribué à Sarah']);
  });
  it('télépros évalués : retenu d\'abord, puis éligible, puis exclu, avec charge et raison', () => {
    expect(ex.evaluated.map((e) => [e.name, e.tag, e.load, e.detail])).toEqual([
      ['Sarah', 'retained', '4/10', 'Disponible'],
      ['Mehdi', 'eligible', '8/10', 'Disponible'],
      ['Laura', 'excluded', '3/10', 'En rendez-vous'],
    ]);
  });
  it('reconstitue la raison à partir des valeurs figées, avec le chiffre qui a départagé', () => {
    expect(ex.whyTitle).toBe('Pourquoi Sarah ?');
    expect(ex.why.join(' ')).toContain('Charge active la plus faible : 4 (contre 8 pour Mehdi)');
    expect(ex.why).toContain('Capacité disponible : 4/10 nouveaux leads.');
  });
  it('seul candidat éligible : le dit', () => {
    const e = explainDecision(
      entry({ reason: 'only_candidate', candidates: [entry().candidates[0], { ...entry().candidates[1], eligible: false, exclusions: ['product_not_allowed'] }] }),
      names
    );
    expect(e.why.join(' ')).toContain('Seul télépro éligible');
  });
  it('plafond inconnu (ancienne entrée) : « — », sans inventer de valeur', () => {
    const e = explainDecision(entry({ candidates: [{ uid: 'sarah', eligible: true, exclusions: [], activeLoad: 1, newLeads: 1, cap: null }] }), names);
    expect(e.evaluated[0].load).toBe('—');
    expect(e.why.join(' ')).not.toContain('Capacité disponible');
  });
  it('plusieurs motifs de décision', () => {
    const w = (reason: string) => explainDecision(entry({ reason }), names).why.join(' ');
    expect(w('fewest_new_leads')).toContain('moins de nouveaux leads : 4 (contre 8 pour Mehdi)');
    expect(w('oldest_last_assignment')).toContain('dernière attribution la plus ancienne');
    expect(w('stable_hash')).toContain('Égalité parfaite');
  });
  it('décision manuelle : cite le motif saisi par le manager', () => {
    const e = explainDecision(entry({ event: 'manual', actorId: 'mgr1', reason: 'Demande du client' }), names);
    expect(e.why[0]).toBe('Décision manuelle : Demande du client');
    expect(e.timeline[2].detail).toContain('manuelle');
  });
  it('file tampon : pas de « Pourquoi », la chronologie dit pourquoi', () => {
    const e = explainDecision(entry({ event: 'buffer', chosenOwnerId: null, reason: 'capacity_reached', candidates: [] }), names);
    expect(e.whyTitle).toBeNull();
    expect(e.why).toEqual([]);
    expect(e.timeline[2]).toEqual({ title: 'Mis en file tampon', detail: 'Aucune attribution : plafond atteint.' });
  });
});

describe('journalToCsv', () => {
  const evil: JournalNames = { users: names.users, campaigns: new Map([['c1', '=HYPERLINK("http://evil")']]) };
  const rows = buildJournalRows([entry(), entry({ id: 'x', atMs: T - 1 })], evil);
  const csv = journalToCsv(rows);
  it('BOM UTF-8, séparateur point-virgule, en-tête puis une ligne par décision', () => {
    expect(csv.startsWith('﻿Date;Heure;Lead;Campagne;Événement;Télépro;Motif;Statut')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(3);
  });
  it('une cellule qui ressemble à une formule est neutralisée (injection de formule tableur)', () => {
    expect(csv).not.toMatch(/;=HYPERLINK/);
    expect(csv).toContain("'=HYPERLINK");
  });
  it('échappe guillemets, points-virgules et retours à la ligne', () => {
    const r = buildJournalRows([entry({ leadName: 'Dupont; "Jean"\nPierre' })], names);
    const line = journalToCsv(r).split('\r\n')[1];
    expect(line).toContain('"LEAD-ABCDEF — Dupont; ""Jean""\nPierre"');
  });
});
