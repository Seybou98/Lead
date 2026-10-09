import { describe, expect, it } from 'vitest';
import { toListItem } from './mapLead';

const T = (ms: number) => ({ toMillis: () => ms });
const base = { fullName: 'Jean Dupont', status: 'new', origin: { receivedAt: T(1000) }, ownerId: 'u1' };

describe('toListItem — dossier, vente et transmission', () => {
  it('sans montage ni vente : aucun champ supplémentaire', () => {
    const i = toListItem('L1', base)!;
    expect(i.montage).toBeUndefined();
    expect(i.conversion).toBeUndefined();
    expect(i.commercialState).toBeUndefined();
    expect(i.financialState).toBeUndefined();
  });
  it('résumé du montage recopié par le serveur, date comprise', () => {
    const i = toListItem('L1', { ...base, status: 'manager_validation', montage: { validationState: 'pending', blocking: 0, toConfirm: 2, totalTtcCents: 1_599_000, remainderCents: 349_000, updatedAt: T(5000) } })!;
    expect(i.montage).toEqual({ validationState: 'pending', blocking: 0, toConfirm: 2, totalTtcCents: 1_599_000, remainderCents: 349_000, updatedAtMs: 5000, financingMode: null, validated: null, total: null });
  });
  it('montage sans date lisible : null, jamais une date inventée', () => {
    expect(toListItem('L1', { ...base, montage: { validationState: 'none', blocking: 1 } })!.montage?.updatedAtMs).toBeNull();
  });
  it('vente créée : états commercial et financier, et transmission', () => {
    const i = toListItem('L1', { ...base, status: 'converted', saleId: 'L1', commercialState: 'sale_committed', financialState: 'none', conversion: { state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1' } })!;
    expect(i.commercialState).toBe('sale_committed');
    expect(i.financialState).toBe('none');
    expect(i.conversion).toEqual({ state: 'confirmed', clientId: '2612345', dossierId: 'cl_L1', convertedAtMs: null });
  });
  it('mode de règlement du montage : conservé tel quel', () => {
    expect(toListItem('L1', { ...base, montage: { validationState: 'none', financingMode: 'credit' } })!.montage?.financingMode).toBe('credit');
  });
  it('vente sécurisée : date de sécurisation et suivi (relances, acompte, organisme, dates)', () => {
    const i = toListItem('L1', { ...base, saleId: 'L1', commercialState: 'signed', financialState: 'payment_confirmed', securedAt: T(9000), saleTrack: { lastReminderAt: T(7000), reminderCount: 2, depositCents: 90_000, financingOrganism: 'Floa', offerSentAt: T(3000), signedAt: T(6000) } })!;
    expect(i.securedAtMs).toBe(9000);
    expect(i.saleTrack).toEqual({ lastReminderAtMs: 7000, reminderCount: 2, depositCents: 90_000, financingOrganism: 'Floa', offerSentAtMs: 3000, signedAtMs: 6000 });
  });
  it('vente sans suivi encore : valeurs neutres, jamais une date inventée', () => {
    const i = toListItem('L1', { ...base, saleId: 'L1', commercialState: 'sale_committed', financialState: 'none' })!;
    expect(i.securedAtMs).toBeNull();
    expect(i.saleTrack).toEqual({ lastReminderAtMs: null, reminderCount: 0, depositCents: null, financingOrganism: null, offerSentAtMs: null, signedAtMs: null });
  });
  it('étape du CRM principal : lue sur le lead, absente sinon', () => {
    expect(toListItem('L1', base)!.mainStatus).toBeUndefined();
    const i = toListItem('L1', { ...base, mainStatus: { stage: 'installed', label: 'Installé', changedAt: T(4000) } })!;
    expect(i.mainStatus).toEqual({ stage: 'installed', label: 'Installé', changedAtMs: 4000 });
    expect(toListItem('L1', { ...base, mainStatus: { label: 'x' } })!.mainStatus).toBeUndefined();
  });
  it('conversion pas encore faite : identifiants null', () => {
    const i = toListItem('L1', { ...base, saleId: 'L1', conversion: { state: 'pending', clientId: null, dossierId: null } })!;
    expect(i.conversion).toEqual({ state: 'pending', clientId: null, dossierId: null, convertedAtMs: null });
  });
  it('conversion vide (état null, lead sans vente) : ignorée', () => {
    expect(toListItem('L1', { ...base, conversion: { state: null, clientId: null, dossierId: null } })!.conversion).toBeUndefined();
  });
  it('sans date de réception : le lead est ignoré', () => {
    expect(toListItem('L1', { fullName: 'x', status: 'new' })).toBeNull();
  });
});
