import { describe, expect, it } from 'vitest';
import {
  computeCampaignStats,
  computeTotals,
  filterCampaigns,
  formatEuros,
  formatPercent,
  NO_CAMPAIGN_FILTERS,
  sortCampaignRows,
  type CampaignView,
  type LeadStatView,
  type SpendView,
} from './campaignStats';

const T0 = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;
const ALL = { fromMs: null, toMs: null };

const camp = (id: string, over: Partial<CampaignView> = {}): CampaignView => ({
  id,
  name: `Campagne ${id}`,
  sourceId: 'meta',
  externalId: `ext-${id}`,
  productCode: 'pac_air_eau',
  zones: ['idf'],
  status: 'active',
  budgetCents: 1_000_000,
  ...over,
});

const lead = (campaignId: string | null, over: Partial<LeadStatView> = {}): LeadStatView => ({
  campaignId,
  status: 'new',
  receivedAtMs: T0,
  documentsState: 'none',
  duplicate: false,
  excluded: false,
  ...over,
});

const repeat = <T,>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

describe('computeCampaignStats', () => {
  const c = camp('a');

  it('compte les leads valides, les ventes, les dossiers complets et les contactés', () => {
    const leads = [
      ...repeat(5, () => lead('a')),
      ...repeat(3, () => lead('a', { status: 'interested' })),
      ...repeat(2, () => lead('a', { status: 'converted', documentsState: 'complete' })),
      lead('a', { status: 'awaiting_documents', documentsState: 'complete' }),
    ];
    const [s] = computeCampaignStats([c], leads, [], ALL);
    expect(s).toMatchObject({ leads: 11, sales: 2, docsComplete: 3 });
    expect(s.funnel).toEqual({ leads: 11, contacted: 6, documents: 3, sales: 2 });
  });

  it("« Pas de réponse » n'est pas un contact : NR, injoignable et recyclage ne comptent pas (§12.1.3)", () => {
    const leads = (['new', 'nr', 'unreachable_cycle_end', 'recycling', 'unreachable_archived'] as const).map((status) => lead('a', { status }));
    const [s] = computeCampaignStats([c], leads, [], ALL);
    expect(s.leads).toBe(5);
    expect(s.funnel.contacted).toBe(0);
  });

  it('un lead joint puis clos (non intéressé, inéligible) reste compté comme contacté', () => {
    const leads = [lead('a', { status: 'not_interested' }), lead('a', { status: 'ineligible' }), lead('a', { status: 'callback' })];
    expect(computeCampaignStats([c], leads, [], ALL)[0].funnel.contacted).toBe(3);
  });

  it('doublons et faux leads sont comptés à part, jamais dans les leads valides', () => {
    const leads = [lead('a'), lead('a'), lead('a', { duplicate: true }), lead('a', { status: 'fake_lead' }), lead('a', { excluded: true })];
    const [s] = computeCampaignStats([c], leads, [], ALL);
    expect(s).toMatchObject({ leads: 2, duplicates: 1, fakeLeads: 1 });
  });

  it('un faux lead qui est aussi un doublon est compté une seule fois, comme faux lead', () => {
    const [s] = computeCampaignStats([c], [lead('a', { status: 'fake_lead', duplicate: true })], [], ALL);
    expect(s).toMatchObject({ leads: 0, duplicates: 0, fakeLeads: 1 });
  });

  it('un lead exclu reste hors des leads valides et hors des ventes', () => {
    const [s] = computeCampaignStats([c], [lead('a', { status: 'converted', excluded: true })], [], ALL);
    expect(s).toMatchObject({ leads: 0, sales: 0 });
  });

  it('ignore les leads des autres campagnes et ceux sans campagne', () => {
    const [s] = computeCampaignStats([c], [lead('b'), lead(null), lead('a')], [], ALL);
    expect(s.leads).toBe(1);
  });

  describe('coûts', () => {
    const leads = [...repeat(4, () => lead('a')), lead('a', { status: 'converted' })];
    const spend: SpendView[] = [
      { campaignId: 'a', amountCents: 20_000, atMs: T0 },
      { campaignId: 'a', amountCents: 5_000, atMs: T0 + DAY },
    ];
    it('CPL = dépenses / leads valides ; coût par vente = dépenses / ventes', () => {
      const [s] = computeCampaignStats([c], leads, spend, ALL);
      expect(s.spendCents).toBe(25_000);
      expect(s.cplCents).toBe(5_000);
      expect(s.costPerSaleCents).toBe(25_000);
    });
    it('aucune dépense saisie : null (affiché « — »), pas 0 €', () => {
      const [s] = computeCampaignStats([c], leads, [], ALL);
      expect(s.spendCents).toBeNull();
      expect(s.cplCents).toBeNull();
      expect(s.costPerSaleCents).toBeNull();
    });
    it('aucune vente : coût par vente null, pas Infinity', () => {
      const [s] = computeCampaignStats([c], [lead('a')], spend, ALL);
      expect(s.costPerSaleCents).toBeNull();
      expect(s.cplCents).toBe(25_000);
    });
    it('aucun lead valide : CPL null, pas NaN', () => {
      const [s] = computeCampaignStats([c], [], spend, ALL);
      expect(s.cplCents).toBeNull();
      expect(s.conversionRate).toBeNull();
    });
    it('les dépenses d\'une autre campagne ne comptent pas', () => {
      const [s] = computeCampaignStats([c], leads, [{ campaignId: 'b', amountCents: 99, atMs: T0 }], ALL);
      expect(s.spendCents).toBeNull();
    });
  });

  describe('période', () => {
    const leads = [lead('a', { receivedAtMs: T0 - 1 }), lead('a', { receivedAtMs: T0 }), lead('a', { receivedAtMs: T0 + DAY - 1 }), lead('a', { receivedAtMs: T0 + DAY })];
    it('borne basse incluse, borne haute exclue', () => {
      const [s] = computeCampaignStats([c], leads, [], { fromMs: T0, toMs: T0 + DAY });
      expect(s.leads).toBe(2);
    });
    it('s\'applique aussi aux dépenses', () => {
      const spend = [{ campaignId: 'a', amountCents: 100, atMs: T0 - DAY }, { campaignId: 'a', amountCents: 300, atMs: T0 }];
      const [s] = computeCampaignStats([c], leads, spend, { fromMs: T0, toMs: null });
      expect(s.spendCents).toBe(300);
    });
    it('sans borne : tout', () => {
      expect(computeCampaignStats([c], leads, [], ALL)[0].leads).toBe(4);
    });
  });

  it('taux de conversion global en pourcentage', () => {
    const leads = [...repeat(9, () => lead('a')), lead('a', { status: 'converted' })];
    expect(computeCampaignStats([c], leads, [], ALL)[0].conversionRate).toBe(10);
  });
});

describe('computeTotals', () => {
  const rows = computeCampaignStats(
    [camp('a'), camp('b')],
    [...repeat(10, () => lead('a')), lead('a', { status: 'converted', documentsState: 'complete' }), ...repeat(5, () => lead('b')), lead('b', { duplicate: true })],
    [{ campaignId: 'a', amountCents: 11_000, atMs: T0 }],
    ALL
  );

  it('= somme exacte des lignes affichées', () => {
    const t = computeTotals(rows);
    expect(t.leads).toBe(rows[0].leads + rows[1].leads);
    expect(t).toMatchObject({ leads: 16, duplicates: 1, sales: 1, docsComplete: 1 });
  });
  it('les dépenses d\'une campagne sans saisie ne comptent pas, et le CPL utilise TOUS les leads affichés', () => {
    const t = computeTotals(rows);
    expect(t.spendCents).toBe(11_000);
    expect(t.cplCents).toBe(Math.round(11_000 / 16));
  });
  it('aucune ligne : tout à zéro ou null', () => {
    expect(computeTotals([])).toEqual({ spendCents: null, leads: 0, duplicates: 0, fakeLeads: 0, cplCents: null, docsComplete: 0, sales: 0, costPerSaleCents: null });
  });
});

describe('filterCampaigns', () => {
  const list = [
    camp('a', { name: 'PAC IDF — Septembre', sourceId: 'meta', zones: ['idf'] }),
    camp('b', { name: 'SSC Grand Est', sourceId: 'google', productCode: 'ssc', zones: ['grand_est'], externalId: 'G-42' }),
  ];
  it('sans filtre : tout', () => expect(filterCampaigns(list, NO_CAMPAIGN_FILTERS)).toHaveLength(2));
  it('statut de la campagne (§19.1)', () => {
    const l = [camp('a', { status: 'active' }), camp('b', { status: 'suspended' })];
    expect(filterCampaigns(l, { ...NO_CAMPAIGN_FILTERS, status: 'suspended' }).map((c) => c.id)).toEqual(['b']);
  });
  it('source, produit, zone', () => {
    expect(filterCampaigns(list, { ...NO_CAMPAIGN_FILTERS, sourceId: 'google' }).map((c) => c.id)).toEqual(['b']);
    expect(filterCampaigns(list, { ...NO_CAMPAIGN_FILTERS, productCode: 'pac_air_eau' }).map((c) => c.id)).toEqual(['a']);
    expect(filterCampaigns(list, { ...NO_CAMPAIGN_FILTERS, zone: 'grand_est' }).map((c) => c.id)).toEqual(['b']);
  });
  it('recherche par nom (sans accents ni casse) ou par identifiant externe', () => {
    expect(filterCampaigns(list, { ...NO_CAMPAIGN_FILTERS, search: 'SEPTEMBRE' }).map((c) => c.id)).toEqual(['a']);
    expect(filterCampaigns(list, { ...NO_CAMPAIGN_FILTERS, search: 'g-42' }).map((c) => c.id)).toEqual(['b']);
  });
});

describe('affichage', () => {
  it('euros', () => {
    expect(formatEuros(null)).toBe('—');
    expect(formatEuros(2_480_000).replace(/\s| /g, '')).toBe('24800,00€');
    expect(formatEuros(2_000, 0).replace(/\s| /g, '')).toBe('20€');
  });
  it('pourcentage', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(3.6).replace(/\s| /g, '')).toBe('3,60%');
  });
});

describe('sortCampaignRows', () => {
  const rows = computeCampaignStats(
    [
      camp('a', { name: 'Zeta', sourceId: 'meta', productCode: 'ssc', budgetCents: 100 }),
      camp('b', { name: 'Alpha', sourceId: 'google', productCode: null, budgetCents: null, status: 'suspended' }),
      camp('c', { name: 'Mike', sourceId: 'meta', productCode: 'pac', budgetCents: 300, status: 'draft' }),
    ],
    [...repeat(5, () => lead('a')), ...repeat(9, () => lead('c'))],
    [{ campaignId: 'a', amountCents: 5_000, atMs: T0 }],
    ALL
  );
  const names = (k: Parameters<typeof sortCampaignRows>[1], d: 'asc' | 'desc') => sortCampaignRows(rows, k, d, (id) => id).map((r) => r.campaign.name);

  it('texte : ordre alphabétique sans tenir compte de la casse ni des accents', () => {
    expect(names('name', 'asc')).toEqual(['Alpha', 'Mike', 'Zeta']);
    expect(names('name', 'desc')).toEqual(['Zeta', 'Mike', 'Alpha']);
  });
  it('nombres : croissant et décroissant', () => {
    expect(names('leads', 'asc')).toEqual(['Alpha', 'Zeta', 'Mike']);
    expect(names('leads', 'desc')).toEqual(['Mike', 'Zeta', 'Alpha']);
  });
  it('une valeur absente passe TOUJOURS en dernier, dans les deux sens', () => {
    expect(names('budget', 'asc')).toEqual(['Zeta', 'Mike', 'Alpha']);
    expect(names('budget', 'desc')).toEqual(['Mike', 'Zeta', 'Alpha']);
    expect(names('product', 'asc').at(-1)).toBe('Alpha');
    expect(names('product', 'desc').at(-1)).toBe('Alpha');
  });
  it('coût par lead : les campagnes sans dépense (null) en dernier', () => {
    expect(names('cpl', 'asc')[0]).toBe('Zeta');
    expect(names('cpl', 'desc')[0]).toBe('Zeta');
    expect(names('cpl', 'desc').slice(1).sort()).toEqual(['Alpha', 'Mike']);
  });
  it('statut : actives, suspendues, brouillons, terminées', () => {
    expect(names('status', 'asc')).toEqual(['Zeta', 'Alpha', 'Mike']);
  });
  it('égalité : départage par nom', () => {
    expect(names('docs', 'asc')).toEqual(['Alpha', 'Mike', 'Zeta']);
  });
  it('ne modifie pas la liste d\'origine', () => {
    const before = rows.map((r) => r.campaign.id);
    sortCampaignRows(rows, 'leads', 'desc', (id) => id);
    expect(rows.map((r) => r.campaign.id)).toEqual(before);
  });
  it('tri par source via le nom fourni', () => {
    expect(sortCampaignRows(rows, 'source', 'asc', (id) => ({ meta: 'Meta', google: 'Google' })[id] ?? id).map((r) => r.campaign.sourceId)).toEqual(['google', 'meta', 'meta']);
  });
});
