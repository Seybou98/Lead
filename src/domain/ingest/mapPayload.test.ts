import { describe, expect, it } from 'vitest';
import { mapPayload, parseCostCents, unwrapPayload } from './mapPayload';

describe('mapPayload', () => {
  it('payload simple de l\'ancien webhook (clés anglaises)', () => {
    const m = mapPayload({
      fullName: 'Jean Dupont',
      email: ' Jean.Dupont@Example.com ',
      phone: '06 12 34 56 78',
      postalCode: '69003',
      campaign: 'PAC IDF',
      product: 'pac_air_eau',
      zone: 'idf',
    });
    expect(m).toMatchObject({
      fullName: 'Jean Dupont',
      firstName: 'Jean',
      lastName: 'Dupont',
      email: 'jean.dupont@example.com',
      phone: '+33612345678',
      zone: 'idf',
      productCode: 'pac_air_eau',
    });
    expect(m.address.postalCode).toBe('69003');
    expect(m.campaign.name).toBe('PAC IDF');
  });

  it('synonymes français et noms de champs Pabbly : Prénom / Nom / Email / mobile', () => {
    const m = mapPayload({ Prénom: 'Marie', Nom: 'Martin', Email: 'marie@x.fr', mobile: '0699887766', ville: 'Lyon' });
    expect(m.fullName).toBe('Marie Martin');
    expect(m.firstName).toBe('Marie');
    expect(m.lastName).toBe('Martin');
    expect(m.phone).toBe('+33699887766');
    expect(m.address.city).toBe('Lyon');
  });

  it('enveloppe `data` ou `payload` (Pabbly) dépliée', () => {
    expect(mapPayload({ data: { email: 'a@b.fr' } }).email).toBe('a@b.fr');
    expect(mapPayload({ payload: { email: 'c@d.fr' } }).email).toBe('c@d.fr');
    expect(unwrapPayload(null)).toEqual({});
    expect(unwrapPayload('texte')).toEqual({});
  });

  it('le mapping de la source a priorité sur les synonymes', () => {
    const m = mapPayload(
      { phone: '0600000000', telephone_client: '0611111111' },
      { telephone_client: 'phone' }
    );
    expect(m.phone).toBe('+33611111111');
  });

  it('numéro et email invalides : normalisés à null, valeur brute conservée pour comprendre le rejet', () => {
    const m = mapPayload({ phone: '123', email: 'pas-un-email' });
    expect(m.phone).toBeNull();
    expect(m.email).toBeNull();
    expect(m.phoneRaw).toBe('123');
    expect(m.emailRaw).toBe('pas-un-email');
  });

  it('valeurs vides, espaces ou absentes → null, jamais « undefined » ni chaîne vide parasite', () => {
    const m = mapPayload({ phone: '   ', email: '', zone: null, postalCode: undefined });
    expect(m.phone).toBeNull();
    expect(m.email).toBeNull();
    expect(m.zone).toBeNull();
    expect(m.address.postalCode).toBeNull();
  });

  it('coût : virgule décimale, symbole €, refus des valeurs invalides ou négatives', () => {
    expect(parseCostCents('12,50')).toBe(1250);
    expect(parseCostCents('12.5 €')).toBe(1250);
    expect(parseCostCents('20')).toBe(2000);
    expect(parseCostCents('abc')).toBeNull();
    expect(parseCostCents('-3')).toBeNull();
    expect(parseCostCents(null)).toBeNull();
    expect(mapPayload({ cost: '8,40' }).costCents).toBe(840);
  });

  it('consentement', () => {
    expect(mapPayload({ consent: 'oui' }).consent).toBe(true);
    expect(mapPayload({ Consentement: 'Non' }).consent).toBe(false);
    expect(mapPayload({ consent: 'peut-être' }).consent).toBeNull();
    expect(mapPayload({}).consent).toBeNull();
  });

  it('qualification : reprend les champs de logement et de foyer connus, ignore le reste', () => {
    const m = mapPayload({ houseSurface: 135, currentHeatingType: 'fioul', rfr: 21000, champInconnu: 'x', ownerType: '' });
    expect(m.qualification).toEqual({ houseSurface: 135, currentHeatingType: 'fioul', rfr: 21000 });
  });

  it("aucun champ de l'ancien webhook n'est perdu : maintenance, estimations, consentement horodaté, foyer", () => {
    const m = mapPayload({
      Last_maintenance_date: '2025-03-01',
      'Estimation min': '1200',
      'Estimation max': '1800',
      'Horodatage consentement': '2026-10-01T10:00:00Z',
      apartment_situation: 'rez-de-chaussée',
      clim_installation_timing: 'sous 3 mois',
      anneeRevenu: 2025,
      numeroFiscal: '123456789',
      montantFacturesEnergetiques: 2400,
    });
    expect(m.qualification).toEqual({
      lastMaintenanceDate: '2025-03-01',
      estimationMin: '1200',
      estimationMax: '1800',
      consentTimestamp: '2026-10-01T10:00:00Z',
      apartmentSituation: 'rez-de-chaussée',
      climInstallationTiming: 'sous 3 mois',
      anneeRevenu: 2025,
      numeroFiscal: '123456789',
      montantFacturesEnergetiques: 2400,
    });
  });

  it('identifiants de campagne et de publicité', () => {
    const m = mapPayload({ campaignId: 'c1', adset_id: 'as1', ad_id: 'ad1', form_id: 'f1', leadgen_id: 'L-99', platform: 'meta' });
    expect(m.campaign.id).toBe('c1');
    expect(m).toMatchObject({ adsetId: 'as1', adId: 'ad1', formId: 'f1', externalId: 'L-99', platform: 'meta' });
  });

  it('un nom complet seul est découpé ; prénom et nom seuls sont recomposés', () => {
    expect(mapPayload({ name: 'Paul Durand' })).toMatchObject({ firstName: 'Paul', lastName: 'Durand' });
    expect(mapPayload({ first_name: 'Paul', last_name: 'Durand' }).fullName).toBe('Paul Durand');
  });

  it('ne plante jamais sur un payload inattendu', () => {
    for (const bad of [null, undefined, 42, 'x', [], [1, 2]]) {
      expect(() => mapPayload(bad)).not.toThrow();
      expect(mapPayload(bad).phone).toBeNull();
    }
  });
});
