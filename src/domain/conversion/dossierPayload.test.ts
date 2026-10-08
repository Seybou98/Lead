import { describe, expect, it } from 'vitest';
import {
  buildDossierFromImported,
  clientNumberCandidate,
  dossierTypeOf,
  generateClientSearchIndex,
  gesteOfCategory,
  getClimateZoneFromPostalCode,
  getFiscalCategoriesFromValues,
  getGeographicZoneFromPostalCode,
  resolveDossierStatus,
  saleToImportedData,
  stripUndefined,
  type SaleToDossierInput,
} from './dossierPayload';
import { emptyDraft, type MontageDraft } from './montage';

const NOW = new Date('2026-10-08T10:00:00Z');

function draft(over: (d: MontageDraft) => void = () => undefined): MontageDraft {
  const d = emptyDraft();
  d.identity = { fullName: 'Jean Dupont', phone: '06 12 34 56 78', email: 'jean@x.fr', addressLine: '15 rue des Lilas', postalCode: '69003', city: 'Lyon' };
  d.project = { housingType: 'Maison individuelle', occupancy: 'Propriétaire occupant', livingAreaM2: 125, currentHeating: 'Chaudière fioul', climateZone: 'H1', cadastralRef: '69003 000 AB 0123', previsitDate: '2026-09-12' };
  d.aids = { mprCents: 800_000, ceeCents: 450_000, delegate: 'TotalEnergies', rfrCents: 2_450_000, householdSize: 3, eligibility: 'validated', ceeDoubleChecked: true };
  d.offer.lines = [{ id: 'l1', productId: 'p1', label: 'PAC', service: 'Pose', qty: 1, unitHtCents: 1_332_500, vatRate: 20 }];
  d.consentConfirmed = true;
  over(d);
  return d;
}
const input = (over: Partial<SaleToDossierInput> = {}): SaleToDossierInput => ({
  leadId: 'L1',
  saleNumber: 'V-2026-00042',
  draft: draft(),
  totals: { mprCents: 800_000, ceeCents: 450_000, remainderCents: 349_000, totalTtcCents: 1_599_000, discountCents: 0 },
  lineCategories: ['PAC'],
  conformDocs: ['identity', 'tax_notice'],
  missingDocs: [],
  owner: { id: 'u1', firstName: 'Sarah', lastName: 'Martin' },
  campaignName: 'PAC IDF',
  consent: true,
  ...over,
});
const build = (over: Partial<SaleToDossierInput> = {}) =>
  buildDossierFromImported(saleToImportedData(input(over)), { clientNumber: '2612345', now: NOW, owner: input(over).owner, ids: { leadId: 'L1', saleNumber: 'V-2026-00042', dossierId: 'cl_L1', subventionId: 'sub_L1' } });

describe('zones et catégories (reprises du CRM principal)', () => {
  it('zone géographique : Île-de-France ou non', () => {
    expect(getGeographicZoneFromPostalCode('75011')).toBe('IDF');
    expect(getGeographicZoneFromPostalCode('69003')).toBe('Hors IDF');
    expect(getGeographicZoneFromPostalCode('')).toBe('');
  });
  it('zone climatique par département, DOM sur 3 chiffres', () => {
    expect(getClimateZoneFromPostalCode('69003')).toBe('H1');
    expect(getClimateZoneFromPostalCode('33000')).toBe('H2');
    expect(getClimateZoneFromPostalCode('13001')).toBe('H3');
    expect(getClimateZoneFromPostalCode('97400')).toBe('');
  });
  it('catégorie MPR et CEE selon revenu et foyer (barème Hors IDF)', () => {
    expect(getFiscalCategoriesFromValues({ rfr: 17000, persons: 1, postalCode: '69003' })).toMatchObject({ mprCategory: 'Bleu', ceeCategory: 'Précarité' });
    expect(getFiscalCategoriesFromValues({ rfr: 22000, persons: 1, postalCode: '69003' })).toMatchObject({ mprCategory: 'Jaune', ceeCategory: 'Modeste' });
    expect(getFiscalCategoriesFromValues({ rfr: 100000, persons: 1, postalCode: '69003' })).toMatchObject({ mprCategory: 'Rose', ceeCategory: 'Classique' });
    expect(getFiscalCategoriesFromValues({ rfr: '', persons: 1, postalCode: '69003' }).mprCategory).toBe('');
  });
  it('plus de 5 personnes : seuils prolongés', () => {
    expect(getFiscalCategoriesFromValues({ rfr: 45000, persons: 7, postalCode: '69003' }).mprCategory).toBe('Bleu');
  });
});

describe('statut du dossier', () => {
  it('toujours « incomplet » tant que la complétude est sous 100 %', () => expect(resolveDossierStatus({ status: 'incomplet_a_completer', completenessScore: 80 })).toBe('incomplet'));
  it('« complet » à 100 %, « validé » si le contrôle administratif est validé, brouillon prioritaire', () => {
    expect(resolveDossierStatus({ completenessScore: 100 })).toBe('complet');
    expect(resolveDossierStatus({ subventionStatus: 'controle admin valider' })).toBe('valide');
    expect(resolveDossierStatus({ draft: true, completenessScore: 100 })).toBe('brouillon');
  });
});

describe('numéro de dossier et index de recherche', () => {
  it('7 chiffres : année sur 2 chiffres + 5 chiffres', () => {
    expect(clientNumberCandidate(new Date(2026, 5, 1), () => 0.12345)).toBe('2612345');
    expect(clientNumberCandidate(new Date(2026, 5, 1), () => 0)).toBe('2600000');
    expect(clientNumberCandidate(new Date(2026, 5, 1))).toMatch(/^26\d{5}$/);
  });
  it('index : mots du nom, e-mail, téléphone brut, chiffres seuls et préfixes', () => {
    const idx = generateClientSearchIndex('Jean', 'Dupont', 'Jean@X.fr', '06 12 34');
    expect(idx).toEqual(expect.arrayContaining(['jean', 'dupont', 'jean dupont', 'jean@x.fr', '06 12 34', '061234', '06', '061', '0612']));
    expect(new Set(idx).size).toBe(idx.length);
  });
});

describe('gestes et type de dossier', () => {
  it('famille du catalogue → geste du CRM principal', () => {
    expect(gesteOfCategory('PAC')).toBe('pac_air_eau');
    expect(gesteOfCategory('POELE')).toBe('poele_granules');
    expect(gesteOfCategory('BS')).toBe('cesi');
    expect(gesteOfCategory('CHAUDIERE')).toBe('granules');
    expect(gesteOfCategory('pv')).toBe('pv');
    expect(gesteOfCategory('Audit')).toBe('audit');
    expect(gesteOfCategory(null)).toBe('autre');
  });
  it('type : crédit = financement, sinon MPR / CEE / les deux, sinon comptant', () => {
    expect(dossierTypeOf(draft(), 800_000, 450_000)).toBe('mpr_cee');
    expect(dossierTypeOf(draft(), 800_000, 0)).toBe('mpr');
    expect(dossierTypeOf(draft(), 0, 450_000)).toBe('cee');
    expect(dossierTypeOf(draft(), 0, 0)).toBe('comptant');
    expect(dossierTypeOf(draft((d) => { d.offer.financing.mode = 'credit'; }), 800_000, 450_000)).toBe('financement');
  });
});

describe('dossier créé (même forme que le CRM principal)', () => {
  it('identité, adresse, type, statut, commercial, index', () => {
    const { dossier } = build();
    expect(dossier).toMatchObject({
      id: 'cl_L1',
      clientNumber: '2612345',
      numeroDossier: '2612345',
      name: 'Jean Dupont',
      tag: 'MPR + CEE',
      status: 'incomplet',
      team: null,
      productsIds: [],
      regie: null,
      commercial: { id: 'u1', firstName: 'Sarah', lastName: 'Martin' },
      RAC: { hasToCollect: false, amount: 3490 },
      subventionId: 'sub_L1',
      geographicZone: 'Hors IDF',
      zone: 'H1',
      source: 'crm-leads',
      leadId: 'L1',
      saleNumber: 'V-2026-00042',
    });
    expect(dossier.contact).toMatchObject({ firstName: 'Jean', lastName: 'Dupont', email: 'jean@x.fr', phone: '06 12 34 56 78' });
    expect(dossier.address).toEqual({ street: '15 rue des Lilas', postalCode: '69003', city: 'Lyon', country: 'France' });
    expect(dossier.searchIndex).toContain('jean dupont');
    expect(dossier.createdAt).toBe(NOW);
  });
  it('catégories fiscales calculées depuis le revenu et le foyer', () => {
    const { dossier } = build();
    expect(dossier).toMatchObject({ rfr: 24500, numberOfPersons: 3, mprCategory: 'Bleu', ceeCategory: 'Précarité', precarite: 'Précarité' });
  });
  it('détails du dossier : logement, fiscal, subvention, opération', () => {
    const d = build().dossier.dossierDetails as Record<string, Record<string, unknown>>;
    expect(d.housing).toMatchObject({ fullAddress: '15 rue des Lilas', postalCode: '69003', city: 'Lyon', type: 'Maison individuelle', livingArea: 125, currentHeating: 'Chaudière fioul', climateZone: 'H1', cadastralReference: '69003 000 AB 0123' });
    expect(d.fiscal).toMatchObject({ declaredRfr: 24500, householdSize: 3, mprCategory: 'Bleu', ceeCategory: 'Précarité' });
    expect(d.subvention).toMatchObject({ type: 'mpr_cee', globalStatus: 'incomplet', estimatedMpr: 8000, estimatedCee: 4500, estimatedRac: 3490 });
    expect(d.cee).toMatchObject({ delegation: 'TotalEnergies' });
    expect(d.operation.operation).toBe('Pompe à chaleur');
    expect(d.client).toMatchObject({ consent: true, leadOrigin: 'PAC IDF' });
  });
  it('notes commerciales : celles du montage puis la dernière note du lead, dans le commentaire du dossier', () => {
    const { dossier } = build({ draft: draft((x) => { x.notes = 'Client pressé avant l’hiver.'; }), lastNote: 'Rappeler après 18 h.' });
    expect(dossier.comment).toBe('Client pressé avant l’hiver.\nRappeler après 18 h.');
    expect((dossier.dossierDetails as { commercial: { notes: string } }).commercial.notes).toBe('Client pressé avant l’hiver.\nRappeler après 18 h.');
  });
  it('notes identiques ou absentes : pas de doublon ni de texte inventé', () => {
    expect(build({ draft: draft((x) => { x.notes = 'Même note'; }), lastNote: 'Même note' }).dossier.comment).toBe('Même note');
    expect(build().dossier.comment).toBe('');
  });
  it('attribution marketing : campagne, source, plateforme, identifiants publicitaires', () => {
    const { dossier } = build({ marketing: { campaignId: 'c1', sourceId: 'pabbly', platform: 'meta', adsetId: 'as1', adId: 'ad1', formId: 'f1', externalId: 'ext-9', receivedAtMs: Date.UTC(2026, 9, 8, 10, 0) } });
    expect((dossier.dossierDetails as { marketing: Record<string, unknown> }).marketing).toEqual({ campagne: 'PAC IDF', campagneId: 'c1', source: 'pabbly', plateforme: 'meta', adsetId: 'as1', adId: 'ad1', formId: 'f1', identifiantExterne: 'ext-9', recuLe: '2026-10-08T10:00:00.000Z' });
  });
  it('attribution marketing inconnue : champs vides, pas de date inventée', () => {
    expect((build().dossier.dossierDetails as { marketing: Record<string, unknown> }).marketing).toMatchObject({ campagne: 'PAC IDF', source: null, plateforme: null, recuLe: null });
  });
  it('financement par crédit : organisme, apport et montant financé', () => {
    const { dossier } = build({ draft: draft((x) => { x.offer.financing = { mode: 'credit', downPaymentCents: 90_000, organism: 'Floa' }; }) });
    expect((dossier.dossierDetails as { financing: Record<string, unknown> }).financing).toEqual({ mode: 'credit', organisme: 'Floa', apport: 900, montantFinance: 2590, resteACharge: 3490 });
  });
  it('apport supérieur au reste à charge : plafonné, jamais de montant financé négatif', () => {
    const { dossier } = build({ draft: draft((x) => { x.offer.financing = { mode: 'credit', downPaymentCents: 9_999_999, organism: 'Floa' }; }) });
    expect((dossier.dossierDetails as { financing: { apport: number; montantFinance: number } }).financing).toMatchObject({ apport: 3490, montantFinance: 0 });
  });
  it('comptant : pas d’organisme ni de montant financé', () => {
    expect((build().dossier.dossierDetails as { financing: Record<string, unknown> }).financing).toMatchObject({ mode: 'comptant', organisme: '', montantFinance: 0 });
  });
  it('prestations ligne par ligne : HT, TVA, TTC, hors catalogue', () => {
    const { dossier } = build({ draft: draft((x) => { x.offer.lines = [{ id: 'l1', productId: 'p1', label: 'PAC', service: 'Fourniture et pose', qty: 2, unitHtCents: 500_000, vatRate: 5.5 }, { id: 'l2', productId: null, label: 'Matériel spécial', service: 'Pose seule', qty: 1, unitHtCents: 10_000, vatRate: 20 }]; x.offer.discountCents = 5_000; }), totals: { mprCents: 800_000, ceeCents: 450_000, remainderCents: 349_000, totalTtcCents: 1_599_000, discountCents: 5_000 } });
    const offer = (dossier.dossierDetails as { offer: { lignes: Record<string, unknown>[]; remise: number } }).offer;
    expect(offer.lignes[0]).toEqual({ designation: 'PAC', prestation: 'Fourniture et pose', quantite: 2, prixUnitaireHt: 5000, tva: 5.5, totalHt: 10000, totalTtc: 10550, horsCatalogue: false });
    expect(offer.lignes[1]).toMatchObject({ designation: 'Matériel spécial', horsCatalogue: true, totalTtc: 120 });
    expect(offer.remise).toBe(50);
  });
  it('le formulaire importé du dossier garde ces données (le CRM principal les relit depuis là)', () => {
    const imported = (build({ lastNote: 'N' }).dossier.dossierDetails as { importedForm: Record<string, unknown> }).importedForm;
    expect(imported).toHaveProperty('financement');
    expect(imported).toHaveProperty('offre');
    expect(imported).toHaveProperty('attributionMarketing');
    expect(imported.notesCommerciales).toBe('N');
  });
  it('parcelle cadastrale stockée sous les noms lus par le CRM principal', () => {
    const { dossier } = build();
    const qa = (dossier.questionnaireAnswers as { info: Record<string, unknown> }).info;
    expect(qa).toMatchObject({ parcelCadastrale: '69003 000 AB 0123', parcellesCadastrales: '69003 000 AB 0123' });
    const housing = (dossier.dossierDetails as { housing: Record<string, unknown> }).housing;
    expect(housing).toMatchObject({ cadastralReference: '69003 000 AB 0123', cadastralPlots: '69003 000 AB 0123' });
  });
  it('financement : sous-statut « à faire » comme le CRM principal', () => {
    const { dossier } = build({ draft: draft((x) => { x.offer.financing.mode = 'credit'; }) });
    expect(dossier).toMatchObject({ tag: 'Financement', subStatus: 'financement_a_faire', dossierSubStatus: 'financement_a_faire' });
  });
  it('comptant sans aides : sous-statut « à payer »', () => {
    const { dossier } = build({ draft: draft((x) => { x.aids.mprCents = 0; x.aids.ceeCents = 0; }), totals: { mprCents: 0, ceeCents: 0, remainderCents: 1_599_000, totalTtcCents: 1_599_000, discountCents: 0 } });
    expect(dossier).toMatchObject({ tag: 'Comptant', subStatus: 'comptant_a_payer' });
  });
  it('subvention liée au dossier, statut initial et primes portées par la première opération', () => {
    const { subvention } = build();
    expect(subvention).toMatchObject({ id: 'sub_L1', ownerType: 'occupant', clientId: 'cl_L1', dossierId: 'cl_L1', dossier: { statut: 'incomplet_a_completer' }, primeMprTotal: 8000, primeCeeTotal: 4500, racTotal: 3490, color: 'bleu' });
    const ops = subvention.operations as { operation: string; primeMpr: number; primeCee: number; rac: number; bareme: string; category: string }[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operation: 'Pompe à chaleur', primeMpr: 8000, primeCee: 4500, rac: 3490, bareme: 'BAR-TH-171', category: 'PAC' });
  });
  it('plusieurs gestes : primes et reste à charge sur la première opération seulement', () => {
    const { subvention } = build({ lineCategories: ['PAC', 'SSC', 'PAC'] });
    const ops = subvention.operations as { primeMpr: number; primeCee: number; rac: number; operation: string }[];
    expect(ops.map((o) => o.operation)).toEqual(['Pompe à chaleur', 'Système solaire combiné']);
    expect(ops[1]).toMatchObject({ primeMpr: 0, primeCee: 0, rac: 0 });
  });
  it('MPR ignorée pour un dossier CEE seul', () => {
    const { subvention } = build({ draft: draft((x) => { x.aids.mprCents = 0; }), totals: { mprCents: 0, ceeCents: 450_000, remainderCents: 1_149_000, totalTtcCents: 1_599_000, discountCents: 0 } });
    expect(subvention.primeMprTotal).toBe(0);
    expect(subvention.primeCeeTotal).toBe(4500);
  });
  it('pièces non conformes listées comme manquantes, aucune valeur undefined', () => {
    const { dossier } = build({ missingDocs: ['bank_details'] });
    expect(dossier.missingDocuments).toEqual(['bank_details']);
    expect(JSON.stringify(dossier)).not.toContain('undefined');
    const hasUndefined = (v: unknown): boolean => v === undefined || (!!v && typeof v === 'object' && !(v instanceof Date) && Object.values(v as object).some(hasUndefined));
    expect(hasUndefined(dossier)).toBe(false);
    expect(hasUndefined(build().subvention)).toBe(false);
  });
  it('sans commercial connu : pas de champ commercial', () => {
    const { dossier } = build({ owner: null });
    expect('commercial' in dossier).toBe(false);
  });
  it('historique : création du dossier avec son numéro', () => {
    expect(build().history).toEqual({ action: 'client_created', clientName: 'Jean Dupont', details: 'Nouveau dossier N°: 2612345', newValue: 'Dossier créé' });
  });
  it('nom vide : « Dossier sans nom » comme le CRM principal', () => {
    expect(build({ draft: draft((x) => { x.identity.fullName = ''; }) }).dossier.name).toBe('Dossier sans nom');
  });
});

describe('stripUndefined', () => {
  it('retire les undefined, garde dates et null, remplace par null dans les tableaux', () => {
    const d = new Date();
    expect(stripUndefined({ a: 1, b: undefined, c: null, d, e: [1, undefined], f: { g: undefined, h: 2 } })).toEqual({ a: 1, c: null, d, e: [1, null], f: { h: 2 } });
  });
});
