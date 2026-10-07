import { describe, expect, it } from 'vitest';
import { findDuplicates, type ExistingLeadSummary, type IncomingLead } from './duplicates';

const incoming = (over: Partial<IncomingLead> = {}): IncomingLead => ({
  phone: '+33612345678',
  email: 'jean.dupont@example.com',
  externalId: null,
  sourceId: 'meta',
  fullName: 'Jean Dupont',
  addressLine: '12 rue des Lilas',
  postalCode: '69003',
  ...over,
});

const existing = (over: Partial<ExistingLeadSummary> = {}): ExistingLeadSummary => ({
  id: 'L1',
  phone: '+33699999999',
  email: 'autre@example.com',
  externalId: null,
  sourceId: 'meta',
  fullName: 'Quelqu Un',
  addressLine: '1 avenue de la Gare',
  postalCode: '75001',
  status: 'new',
  ownerId: 'u1',
  ...over,
});

describe('findDuplicates', () => {
  it('aucune correspondance → nouveau lead', () => {
    const r = findDuplicates(incoming(), [existing()]);
    expect(r.outcome).toBe('new_lead');
    expect(r.matches).toEqual([]);
    expect(r.primaryMatchId).toBeNull();
  });

  it('liste vide → nouveau lead', () => {
    expect(findDuplicates(incoming(), []).outcome).toBe('new_lead');
  });

  it('même téléphone, lead encore ouvert → rattaché, pas de second compteur SLA', () => {
    const r = findDuplicates(incoming(), [existing({ phone: '+33612345678', status: 'interested' })]);
    expect(r.outcome).toBe('attached_to_open_lead');
    expect(r.primaryMatchId).toBe('L1');
    expect(r.matches[0].reasons).toEqual(['phone']);
    expect(r.isReplay).toBe(false);
  });

  it('même email, lead ouvert → rattaché', () => {
    const r = findDuplicates(incoming(), [existing({ email: 'jean.dupont@example.com', status: 'nr' })]);
    expect(r.outcome).toBe('attached_to_open_lead');
    expect(r.matches[0].reasons).toEqual(['email']);
  });

  it('téléphone ET email identiques : confiance plus élevée qu\'un seul des deux', () => {
    const both = findDuplicates(incoming(), [existing({ phone: '+33612345678', email: 'jean.dupont@example.com' })]);
    const one = findDuplicates(incoming(), [existing({ phone: '+33612345678' })]);
    expect(both.matches[0].confidence).toBeGreaterThan(one.matches[0].confidence);
    expect(both.matches[0].confidence).toBeLessThanOrEqual(1);
  });

  it('même téléphone mais lead déjà converti → client connu', () => {
    const r = findDuplicates(incoming(), [existing({ phone: '+33612345678', status: 'converted' })]);
    expect(r.outcome).toBe('known_client');
    expect(r.primaryMatchId).toBe('L1');
  });

  it('même téléphone mais lead clos (non converti) → décision humaine', () => {
    for (const status of ['not_interested', 'ineligible', 'fake_lead', 'unreachable_archived'] as const) {
      const r = findDuplicates(incoming(), [existing({ phone: '+33612345678', status })]);
      expect(r.outcome).toBe('probable_duplicate');
    }
  });

  it('même nom + même adresse + même code postal, sans téléphone ni email → doublon probable seulement', () => {
    const r = findDuplicates(incoming(), [
      existing({ fullName: 'jean  DUPONT', addressLine: '12, rue des Lilas', postalCode: '69003' }),
    ]);
    expect(r.outcome).toBe('probable_duplicate');
    expect(r.matches[0].reasons).toEqual(['name_and_address']);
  });

  it('même nom seul, ou même adresse seule → pas un doublon (homonymes, colocataires)', () => {
    expect(findDuplicates(incoming(), [existing({ fullName: 'Jean Dupont' })]).outcome).toBe('new_lead');
    expect(
      findDuplicates(incoming(), [existing({ addressLine: '12 rue des Lilas', postalCode: '69003' })]).outcome
    ).toBe('new_lead');
  });

  it('nom + adresse sans code postal : ne compte pas', () => {
    const r = findDuplicates(incoming({ postalCode: null }), [
      existing({ fullName: 'Jean Dupont', addressLine: '12 rue des Lilas', postalCode: null }),
    ]);
    expect(r.outcome).toBe('new_lead');
  });

  it('un téléphone ou un email absent n\'est jamais comparé (null ≠ null)', () => {
    const r = findDuplicates(incoming({ phone: null, email: null }), [existing({ phone: null, email: null })]);
    expect(r.outcome).toBe('new_lead');
  });

  it('même identifiant externe de la même source → relance de la source, rien à recréer', () => {
    const r = findDuplicates(incoming({ externalId: 'meta-123' }), [existing({ externalId: 'meta-123', sourceId: 'meta' })]);
    expect(r.isReplay).toBe(true);
    expect(r.outcome).toBe('attached_to_open_lead');
    expect(r.matches[0].confidence).toBe(1);
  });

  it('même identifiant externe mais autre source → pas un rejeu', () => {
    const r = findDuplicates(incoming({ externalId: 'abc' }), [existing({ externalId: 'abc', sourceId: 'google' })]);
    expect(r.isReplay).toBe(false);
    expect(r.outcome).toBe('new_lead');
  });

  it('plusieurs correspondances : la plus fiable, puis la plus ouverte, est la fiche principale', () => {
    const r = findDuplicates(incoming(), [
      existing({ id: 'A', phone: '+33612345678', status: 'not_interested' }),
      existing({ id: 'B', phone: '+33612345678', status: 'interested' }),
    ]);
    expect(r.primaryMatchId).toBe('B');
    expect(r.outcome).toBe('attached_to_open_lead');
  });

  it('résultat déterministe quel que soit l\'ordre de la liste', () => {
    const list = [
      existing({ id: 'A', phone: '+33612345678' }),
      existing({ id: 'B', phone: '+33612345678' }),
      existing({ id: 'C', phone: '+33612345678' }),
    ];
    const a = findDuplicates(incoming(), list);
    const b = findDuplicates(incoming(), [...list].reverse());
    expect(a.matches.map((m) => m.leadId)).toEqual(b.matches.map((m) => m.leadId));
    expect(a.primaryMatchId).toBe(b.primaryMatchId);
  });

  it('chaque résultat s\'accompagne d\'une explication lisible', () => {
    expect(findDuplicates(incoming(), []).explanation).not.toBe('');
    expect(findDuplicates(incoming(), [existing({ phone: '+33612345678' })]).explanation).toContain('téléphone');
  });
});
