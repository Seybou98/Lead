import { describe, expect, it } from 'vitest';
import {
  buildEssentials,
  buildNextAction,
  buildProgress,
  buildTimeline,
  eventToTimeline,
  housingStatus,
  type EventInput,
  type LeadFileData,
} from './leadFile';

const NOW = Date.UTC(2026, 9, 6, 10, 0);
const MIN = 60_000;

const lead = (over: Partial<LeadFileData> = {}): LeadFileData => ({
  id: 'l1',
  status: 'new',
  productCode: 'PAC Air/Eau',
  qualification: {},
  ownerId: 'sarah',
  bufferReason: null,
  nextAction: { type: 'take_new_lead', dueAtMs: NOW + MIN, priority: 'P1', reason: 'Nouveau lead à prendre en charge' },
  documents: { state: 'none', expected: 0, received: 0, conform: 0, mandatory: 0, mandatoryConform: 0 },
  lastNote: null,
  ...over,
});

describe('buildNextAction', () => {
  it('action à venir : titre lisible, motif, échéance', () => {
    const a = buildNextAction(lead(), NOW, false);
    expect(a).toMatchObject({ title: 'Prendre en charge le nouveau lead', overdue: false, tone: 'info' });
  });
  it('échéance passée : en retard, ton critique', () => {
    const a = buildNextAction(lead({ nextAction: { type: 'client_callback', dueAtMs: NOW - MIN, priority: 'P0', reason: 'Rappel promis' } }), NOW, false);
    expect(a).toMatchObject({ title: 'Rappeler le client', overdue: true, tone: 'danger' });
  });
  it('le code de priorité n\'est jamais montré au télépro (§25.1), seulement au manager et à l\'admin', () => {
    expect(buildNextAction(lead(), NOW, false).priority).toBeNull();
    expect(buildNextAction(lead(), NOW, true).priority).toBe('P1');
  });
  it('lead sans propriétaire : le dit avec le motif lisible', () => {
    const a = buildNextAction(lead({ ownerId: null, nextAction: null, bufferReason: 'capacity_reached' }), NOW, true);
    expect(a.title).toBe('En attente d’attribution');
    expect(a.reason).toContain('plafond atteint');
    expect(a.tone).toBe('warning');
  });
  it('lead attribué sans action : anomalie signalée (RG02), jamais un faux calme', () => {
    const a = buildNextAction(lead({ nextAction: null }), NOW, false);
    expect(a).toMatchObject({ title: 'Aucune action programmée', tone: 'danger' });
  });
  it('type d\'action inconnu : affiché tel quel plutôt que perdu', () => {
    expect(buildNextAction(lead({ nextAction: { type: 'futur_type', dueAtMs: NOW + 1, priority: 'P2', reason: 'x' } }), NOW, false).title).toBe('futur_type');
  });
});

describe('housingStatus', () => {
  it.each([
    [{ isHomeOwner: 'oui' }, 'Propriétaire'],
    [{ isHomeOwner: 'OUI' }, 'Propriétaire'],
    [{ isHomeOwner: 'non' }, 'Non propriétaire'],
    [{ isHomeOwner: 'locataire' }, 'Non propriétaire'],
    [{ isHomeOwner: 'non_renseigne', ownerType: 'Propriétaire occupant' }, 'Propriétaire occupant'],
    [{ isHomeOwner: 'peut-être' }, 'peut-être'],
    [{}, null],
    [{ isHomeOwner: 'non_renseigne' }, null],
  ])('%j → %s', (q, expected) => {
    expect(housingStatus(q)).toBe(expected);
  });
});

describe('buildEssentials', () => {
  it('lead sans qualification : les lignes clés indiquent « Non renseigné », sans inventer', () => {
    const rows = buildEssentials(lead({ productCode: null, ownerId: null }), null);
    const get = (l: string) => rows.find((r) => r.label === l);
    expect(get('Statut logement')).toMatchObject({ value: 'Non renseigné', missing: true });
    expect(get('Chauffage actuel')).toMatchObject({ value: 'Non renseigné', missing: true });
    expect(get('Projet')).toMatchObject({ value: 'Non renseigné', missing: true });
    expect(get('Télépro')).toMatchObject({ value: 'Non renseigné', missing: true });
    expect(get('Surface')).toBeUndefined();
    expect(get('Année de construction')).toBeUndefined();
  });
  it('lead qualifié : valeurs affichées avec unités', () => {
    const rows = buildEssentials(lead({ qualification: { isHomeOwner: 'oui', houseSurface: 135, currentHeatingType: 'fioul', constructionYear: 1985 } }), 'Sarah Martin');
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Statut logement', 'Propriétaire'],
      ['Surface', '135 m²'],
      ['Année de construction', '1985'],
      ['Chauffage actuel', 'fioul'],
      ['Projet', 'PAC Air/Eau'],
      ['Éligibilité', 'À confirmer'],
      ['Télépro', 'Sarah Martin'],
    ]);
  });
  it('une surface à 0 (valeur par défaut d\'une source) est ignorée, pas affichée « 0 m² »', () => {
    expect(buildEssentials(lead({ qualification: { houseSurface: 0 } }), null).some((r) => r.label === 'Surface')).toBe(false);
    expect(buildEssentials(lead({ qualification: { houseSurface: '0' } }), null).some((r) => r.label === 'Surface')).toBe(false);
  });
  it('l\'éligibilité n\'est jamais affirmée', () => {
    expect(buildEssentials(lead(), null).find((r) => r.label === 'Éligibilité')?.value).toBe('À confirmer');
  });
});

describe('buildProgress', () => {
  const states = (l: LeadFileData) => buildProgress(l).map((s) => s.state);
  it('lead tout juste reçu : rien de fait, « Contacté » est l\'étape en cours', () => {
    expect(states(lead())).toEqual(['current', 'todo', 'todo', 'todo']);
  });
  it('un lead en NR n\'est pas contacté', () => {
    expect(states(lead({ status: 'nr' }))[0]).toBe('current');
  });
  it('rappel : contacté, pas encore intéressé', () => {
    expect(states(lead({ status: 'callback' }))).toEqual(['done', 'current', 'todo', 'todo']);
  });
  it('intéressé, documents partiels : progression des pièces visible', () => {
    const l = lead({ status: 'awaiting_documents', documents: { state: 'partial', expected: 4, received: 2, conform: 1, mandatory: 4, mandatoryConform: 1 } });
    const p = buildProgress(l);
    expect(p.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo']);
    expect(p[2].detail).toBe('2/4 pièces reçues');
  });
  it('documents complets : étape faite, la vente devient l\'étape en cours', () => {
    const l = lead({ status: 'file_ready_to_build', documents: { state: 'complete', expected: 4, received: 4, conform: 4, mandatory: 4, mandatoryConform: 4 } });
    expect(states(l)).toEqual(['done', 'done', 'done', 'current']);
  });
  it('converti : tout est fait', () => {
    expect(states(lead({ status: 'converted', documents: { state: 'complete', expected: 1, received: 1, conform: 1, mandatory: 1, mandatoryConform: 1 } }))).toEqual(['done', 'done', 'done', 'done']);
  });
  it('une seule étape est « en cours » à la fois', () => {
    for (const status of ['new', 'callback', 'interested', 'awaiting_documents', 'converted'] as const) {
      expect(buildProgress(lead({ status })).filter((s) => s.state === 'current').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('historique', () => {
  const users = new Map([['sarah', 'Sarah Martin'], ['mgr', 'Marc Leroy']]);
  const ev = (type: string, over: Partial<EventInput> = {}): EventInput => ({ id: type, type, atMs: NOW, actorId: 'system', ...over });

  it('lead reçu', () => expect(eventToTimeline(ev('created'), users)).toMatchObject({ title: 'Lead reçu', kind: 'created' }));
  it('attribution : nom du télépro et raison lisible', () => {
    const t = eventToTimeline(ev('assigned', { actorId: 'engine', after: { ownerId: 'sarah' }, reason: 'lowest_active_load' }), users);
    expect(t.title).toBe('Attribué à Sarah Martin');
    expect(t.detail).toBe('Raison : charge active la plus faible.');
  });
  it('réattribution : de qui à qui, avec le motif', () => {
    const t = eventToTimeline(ev('reassigned', { before: { ownerId: 'sarah' }, after: { ownerId: 'mgr' }, reason: 'Absence' }), users);
    expect(t.title).toBe('Réattribué de Sarah Martin à Marc Leroy');
    expect(t.detail).toBe('Motif : Absence');
  });
  it('changement de statut : libellés lisibles', () => {
    expect(eventToTimeline(ev('status_changed', { before: { status: 'new' }, after: { status: 'callback' } }), users).title).toBe('Statut : Nouveau → À rappeler');
  });
  it('note : auteur et texte', () => {
    const t = eventToTimeline(ev('note', { actorId: 'sarah', note: 'Client motivé' }), users);
    expect(t).toMatchObject({ title: 'Note de Sarah Martin', detail: 'Client motivé', kind: 'note' });
  });
  it('alerte de file tampon : le texte écrit par le moteur', () => {
    expect(eventToTimeline(ev('alert', { note: 'Aucun télépro éligible' }), users).detail).toBe('Aucun télépro éligible');
  });
  it('type inconnu : conservé, jamais perdu ni source d\'erreur', () => {
    expect(eventToTimeline(ev('type_futur'), users)).toMatchObject({ title: 'type_futur', kind: 'other' });
  });
  it('utilisateur inconnu : l\'identifiant plutôt que rien', () => {
    expect(eventToTimeline(ev('note', { actorId: 'zz', note: 'x' }), users).title).toBe('Note de zz');
  });

  it('chronologie : du plus récent au plus ancien', () => {
    const t = buildTimeline([ev('created', { atMs: NOW - 5 * MIN }), ev('note', { atMs: NOW, note: 'x', actorId: 'sarah' })], users);
    expect(t.map((x) => x.kind)).toEqual(['note', 'created']);
  });
  it('événements écrits ensemble (même heure) : « reçu » avant « attribué », quel que soit l\'ordre de lecture', () => {
    const a = buildTimeline([ev('created'), ev('assigned', { after: { ownerId: 'sarah' } })], users);
    const b = buildTimeline([ev('assigned', { after: { ownerId: 'sarah' } }), ev('created')], users);
    // plus récent en premier : « attribué » au-dessus de « reçu »
    expect(a.map((x) => x.kind)).toEqual(['assigned', 'created']);
    expect(b.map((x) => x.kind)).toEqual(['assigned', 'created']);
  });
  it('ne modifie pas le tableau d\'origine', () => {
    const src = [ev('created', { atMs: 1 }), ev('note', { atMs: 2 })];
    buildTimeline(src, users);
    expect(src.map((e) => e.type)).toEqual(['created', 'note']);
  });
});
