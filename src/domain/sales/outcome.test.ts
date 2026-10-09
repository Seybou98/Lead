import { describe, expect, it } from 'vitest';
import { countOutcomes, outcomeOf, ratePct } from './outcome';

describe('issue d’une vente', () => {
  it('lead sans vente : rien', () => {
    expect(outcomeOf({ status: 'interested' })).toEqual({ sold: false, cancelled: false, net: false, secured: false, validated: false, installed: false, invoiced: false });
  });
  it('vendu : statut converti, transmission en cours ou en erreur, ou axe commercial renseigné', () => {
    for (const status of ['converted', 'transmitting', 'transmission_error']) expect(outcomeOf({ status }).net).toBe(true);
    expect(outcomeOf({ status: 'file_ready', commercialState: 'sale_committed' }).sold).toBe(true);
    expect(outcomeOf({ status: 'file_ready', commercialState: 'none' }).sold).toBe(false);
  });
  it('annulé ou rétracté côté Leads : sort des ventes nettes', () => {
    for (const commercialState of ['cancelled', 'retracted']) expect(outcomeOf({ status: 'converted', commercialState })).toMatchObject({ sold: true, cancelled: true, net: false });
  });
  it('annulé dans le CRM principal : sort des ventes nettes, sans aucune étape de chantier', () => {
    expect(outcomeOf({ status: 'converted', commercialState: 'sale_committed', mainStage: 'cancelled' })).toMatchObject({ cancelled: true, net: false, installed: false, invoiced: false, validated: false });
  });
  it('sécurisé : signé ET paiement confirmé ou financement accepté', () => {
    expect(outcomeOf({ status: 'converted', commercialState: 'signed', financialState: 'payment_confirmed' }).secured).toBe(true);
    expect(outcomeOf({ status: 'converted', commercialState: 'signed', financialState: 'financing_accepted' }).secured).toBe(true);
    expect(outcomeOf({ status: 'converted', commercialState: 'signed', financialState: 'financing_in_progress' }).secured).toBe(false);
    expect(outcomeOf({ status: 'converted', commercialState: 'offer_sent', financialState: 'payment_confirmed' }).secured).toBe(false);
  });
  it('étapes du CRM principal : validé, installé, facturé (cumulatives)', () => {
    const o = (mainStage: string) => outcomeOf({ status: 'converted', commercialState: 'sale_committed', mainStage });
    expect(o('dossier_incomplete')).toMatchObject({ validated: false, installed: false, invoiced: false });
    expect(o('dossier_validated')).toMatchObject({ validated: true, installed: false });
    expect(o('scheduled')).toMatchObject({ validated: true, installed: false });
    expect(o('installed')).toMatchObject({ validated: true, installed: true, invoiced: false });
    expect(o('invoiced')).toMatchObject({ validated: true, installed: true, invoiced: true });
  });
  it('étape inconnue ou absente : aucune étape devinée', () => {
    expect(outcomeOf({ status: 'converted', mainStage: 'unknown' })).toMatchObject({ validated: false, installed: false });
    expect(outcomeOf({ status: 'converted', mainStage: 'zzz' })).toMatchObject({ validated: false });
    expect(outcomeOf({ status: 'converted' })).toMatchObject({ net: true, installed: false });
  });
  it('une étape de chantier sans vente ne compte pas', () => {
    expect(outcomeOf({ status: 'interested', mainStage: 'installed' }).installed).toBe(false);
  });
});

describe('comptage', () => {
  const leads = [
    { status: 'converted', commercialState: 'signed', financialState: 'payment_confirmed', mainStage: 'invoiced' },
    { status: 'converted', commercialState: 'sale_committed', mainStage: 'installed' },
    { status: 'converted', commercialState: 'sale_committed', mainStage: 'cancelled' },
    { status: 'transmitting', commercialState: 'sale_committed' },
    { status: 'interested' },
  ];
  it('ventes, nettes, annulées, sécurisées, validées, installées, facturées', () => {
    expect(countOutcomes(leads)).toEqual({ sold: 4, cancelled: 1, net: 3, secured: 1, validated: 2, installed: 2, invoiced: 1 });
  });
  it('liste vide : zéros', () => expect(countOutcomes([]).net).toBe(0));
  it('taux : une décimale, null sans dénominateur', () => {
    expect(ratePct(2, 3)).toBe(66.7);
    expect(ratePct(0, 5)).toBe(0);
    expect(ratePct(1, 0)).toBeNull();
  });
});
