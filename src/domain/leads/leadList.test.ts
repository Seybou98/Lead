import { describe, expect, it } from 'vitest';
import {
  buildLeadRows,
  DEFAULT_SLA_MS,
  filterLeadRows,
  formatAgo,
  formatCounter,
  formatPhoneDisplay,
  NO_LEAD_FILTERS,
  quickTabCounts,
  slaAgeMs,
  slaLevel,
  sortLeadRows,
  type LeadListItem,
  type LeadNames,
} from './leadList';

const NOW = Date.UTC(2026, 9, 6, 10, 0);
const MIN = 60_000;

const item = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id,
  fullName: `Lead ${id}`,
  phone: '+33612345678',
  email: null,
  city: 'Lyon',
  postalCode: '69003',
  campaignId: 'c1',
  productCode: 'pac',
  status: 'interested',
  temperature: null,
  assignmentState: 'assigned',
  bufferReason: null,
  ownerId: 'sarah',
  receivedAtMs: NOW - 60 * MIN,
  slaStartedAtMs: NOW - 60 * MIN,
  slaStoppedAtMs: null,
  nextAction: null,
  documentsState: 'none',
  duplicate: false,
  excluded: false,
  ...over,
});

const names: LeadNames = { users: new Map([['sarah', 'Sarah Cohen']]), campaigns: new Map([['c1', 'PAC IDF']]) };
const rows = (items: LeadListItem[]) => buildLeadRows(items, names);

describe('slaAgeMs : le compteur ne s\'arrête que sur un changement de statut (RG03)', () => {
  it('lead Nouveau, compteur lancé : âge depuis la réception', () => {
    expect(slaAgeMs(item('a', { status: 'new', slaStartedAtMs: NOW - 3 * MIN }), NOW)).toBe(3 * MIN);
  });
  it('statut autre que Nouveau : plus de compteur', () => {
    expect(slaAgeMs(item('a', { status: 'nr' }), NOW)).toBeNull();
  });
  it('arrêt enregistré : plus de compteur, même si le statut est encore Nouveau', () => {
    expect(slaAgeMs(item('a', { status: 'new', slaStoppedAtMs: NOW - MIN }), NOW)).toBeNull();
  });
  it('pas de départ de compteur : null, jamais NaN', () => {
    expect(slaAgeMs(item('a', { status: 'new', slaStartedAtMs: null }), NOW)).toBeNull();
  });
  it('une horloge en retard sur le serveur ne donne pas un âge négatif', () => {
    expect(slaAgeMs(item('a', { status: 'new', slaStartedAtMs: NOW + 5000 }), NOW)).toBe(0);
  });
});

describe('slaLevel (couleur progressive, §5.1)', () => {
  it('calme, puis orange aux 3/5 du délai, puis rouge au dépassement', () => {
    expect(slaLevel(0)).toBe('ok');
    expect(slaLevel(DEFAULT_SLA_MS * 0.59)).toBe('ok');
    expect(slaLevel(DEFAULT_SLA_MS * 0.6)).toBe('warning');
    expect(slaLevel(DEFAULT_SLA_MS)).toBe('warning'); // le seuil lui-même n'est pas un dépassement
    expect(slaLevel(DEFAULT_SLA_MS + 1)).toBe('breached');
  });
  it('délai configuré', () => {
    expect(slaLevel(11 * MIN, 10 * MIN)).toBe('breached');
  });
});

describe('formatCounter / formatAgo', () => {
  it('compteur mm:ss, puis h:mm:ss', () => {
    expect(formatCounter(2 * MIN + 43_000)).toBe('02:43');
    expect(formatCounter(0)).toBe('00:00');
    expect(formatCounter(3600_000 + 5 * MIN + 12_000)).toBe('1:05:12');
    expect(formatCounter(-5)).toBe('00:00');
  });
  it('« il y a… »', () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe("à l'instant");
    expect(formatAgo(NOW - 5 * MIN, NOW)).toBe('il y a 5 min');
    expect(formatAgo(NOW - 125 * MIN, NOW)).toBe('il y a 2 h');
    expect(formatAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('il y a 3 j');
    expect(formatAgo(NOW + MIN, NOW)).toBe("à l'instant");
  });
});

describe('buildLeadRows', () => {
  it('ajoute le nom du propriétaire et de la campagne ; tiret si absents, identifiant si inconnus', () => {
    const [a, b, c] = rows([item('a'), item('b', { ownerId: null, campaignId: null }), item('c', { ownerId: 'inconnu', campaignId: 'cx' })]);
    expect([a.ownerName, a.campaignName]).toEqual(['Sarah Cohen', 'PAC IDF']);
    expect([b.ownerName, b.campaignName]).toEqual(['—', '—']);
    expect([c.ownerName, c.campaignName]).toEqual(['inconnu', 'cx']);
  });
});

describe('onglets rapides', () => {
  const list = [
    item('n1', { status: 'new' }),
    item('n2', { status: 'new', ownerId: null, assignmentState: 'buffer' }),
    item('i1', { status: 'interested' }),
    item('d1', { status: 'awaiting_documents' }),
    item('d2', { status: 'missing_info' }),
    item('x1', { status: 'not_interested' }),
    item('x2', { status: 'converted' }),
    item('review', { status: 'new', ownerId: null, assignmentState: 'to_assign' }),
    item('closedNoOwner', { status: 'fake_lead', ownerId: null }),
  ];
  it('compte chaque onglet', () => {
    expect(quickTabCounts(list)).toEqual({ all: 9, new: 3, buffer: 2, interested: 1, documents: 2, closed: 3 });
  });
  it('« File tampon » regroupe file tampon et leads à examiner, mais pas un lead clos sans propriétaire', () => {
    const ids = filterLeadRows(rows(list), { ...NO_LEAD_FILTERS, tab: 'buffer' }).map((r) => r.id);
    expect(ids.sort()).toEqual(['n2', 'review']);
  });
});

describe('filterLeadRows', () => {
  const list = rows([
    item('a', { fullName: 'Jean Dupont', phone: '+33612345678', email: 'jean@x.fr', city: 'Lyon' }),
    item('b', { fullName: 'Chloé Bernard', phone: '+33698765432', campaignId: 'c2', ownerId: 'mehdi', temperature: 'hot', status: 'new' }),
    item('c', { fullName: 'Éric Petit', phone: null, ownerId: null, status: 'new' }),
  ]);
  const f = (over: Partial<typeof NO_LEAD_FILTERS>) => filterLeadRows(list, { ...NO_LEAD_FILTERS, ...over }).map((r) => r.id);

  it('sans filtre : tout', () => expect(f({})).toEqual(['a', 'b', 'c']));
  it('recherche : nom sans accents ni casse, email, ville', () => {
    expect(f({ search: 'CHLOE' })).toEqual(['b']);
    expect(f({ search: 'jean@' })).toEqual(['a']);
    expect(f({ search: 'lyon' })).toEqual(['a', 'b', 'c']);
  });
  it('recherche par téléphone, quelle que soit la mise en forme', () => {
    expect(f({ search: '06 12 34 56 78' })).toEqual(['a']);
    expect(f({ search: '0612345678' })).toEqual(['a']);
    expect(f({ search: '+33 6 98 76' })).toEqual(['b']);
  });
  it('une saisie numérique trop courte ne renvoie pas tout', () => {
    expect(f({ search: '06' })).toEqual([]);
  });
  it('lead sans téléphone : trouvé par son nom, jamais par un faux numéro', () => {
    expect(f({ search: 'petit' })).toEqual(['c']);
  });
  it('statut, campagne, température', () => {
    expect(f({ status: 'new' })).toEqual(['b', 'c']);
    expect(f({ campaignId: 'c2' })).toEqual(['b']);
    expect(f({ temperature: 'hot' })).toEqual(['b']);
  });
  it('propriétaire : un télépro, ou « sans propriétaire »', () => {
    expect(f({ ownerId: 'mehdi' })).toEqual(['b']);
    expect(f({ ownerId: 'none' })).toEqual(['c']);
  });
  it('filtres combinés', () => expect(f({ status: 'new', ownerId: 'none' })).toEqual(['c']));
});

describe('sortLeadRows : l\'urgence prime sur la date (RG05)', () => {
  it('les leads Nouveaux au compteur actif d\'abord, le plus ancien en tête ; puis les autres du plus récent', () => {
    const list = rows([
      item('old', { status: 'interested', receivedAtMs: NOW - 500 * MIN }),
      item('recentNew', { status: 'new', slaStartedAtMs: NOW - 1 * MIN, receivedAtMs: NOW - 1 * MIN }),
      item('recent', { status: 'interested', receivedAtMs: NOW - 10 * MIN }),
      item('oldNew', { status: 'new', slaStartedAtMs: NOW - 9 * MIN, receivedAtMs: NOW - 9 * MIN }),
    ]);
    expect(sortLeadRows(list, NOW).map((r) => r.id)).toEqual(['oldNew', 'recentNew', 'recent', 'old']);
  });
  it('ne modifie pas la liste d\'origine', () => {
    const list = rows([item('a', { receivedAtMs: 1 }), item('b', { receivedAtMs: 2 })]);
    sortLeadRows(list, NOW);
    expect(list.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('formatPhoneDisplay', () => {
  it('numéro français : mise en forme habituelle', () => {
    expect(formatPhoneDisplay('+33612345678')).toBe('06 12 34 56 78');
    expect(formatPhoneDisplay('+33123456789')).toBe('01 23 45 67 89');
  });
  it('numéro étranger : tel que stocké', () => expect(formatPhoneDisplay('+32470123456')).toBe('+32470123456'));
  it('absent : tiret', () => {
    expect(formatPhoneDisplay(null)).toBe('—');
    expect(formatPhoneDisplay('')).toBe('—');
  });
});
