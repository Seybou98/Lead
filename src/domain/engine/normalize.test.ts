import { describe, expect, it } from 'vitest';
import {
  isMaintenanceCampaign,
  joinFullName,
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeText,
  splitFullName,
} from './normalize';

describe('normalizePhone → E.164', () => {
  it.each([
    ['06 12 34 56 78', '+33612345678'],
    ['0612345678', '+33612345678'],
    ['06.12.34.56.78', '+33612345678'],
    ['06-12-34-56-78', '+33612345678'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['+33612345678', '+33612345678'],
    ['0033 6 12 34 56 78', '+33612345678'],
    ['33612345678', '+33612345678'],
    ['612345678', '+33612345678'], // zéro initial perdu par un export tableur
    ['+33 (0)6 12 34 56 78', '+33612345678'], // zéro de trunk
    ['  01 23 45 67 89 ', '+33123456789'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('un même numéro écrit de façons différentes donne la même clé de déduplication', () => {
    const variants = ['06 12 34 56 78', '+33612345678', '0033612345678', '06.12.34.56.78', '612345678'];
    expect(new Set(variants.map(normalizePhone)).size).toBe(1);
  });

  it('accepte un numéro international non français', () => {
    expect(normalizePhone('+32 470 12 34 56')).toBe('+32470123456');
    expect(normalizePhone('0032470123456')).toBe('+32470123456');
  });

  it.each([[''], ['   '], ['abc'], ['12345'], ['0012345'], ['00 00 00 00 00'], ['+33 12 34'], ['06 12 34 56']])(
    'refuse « %s » : un numéro invalide n\'est jamais deviné',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    }
  );

  it('refuse les types non texte', () => {
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(612345678)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('met en minuscules et retire les espaces', () => {
    expect(normalizeEmail('  Jean.DUPONT@Example.COM ')).toBe('jean.dupont@example.com');
  });
  it.each([[''], ['pas-un-email'], ['a@b'], ['a b@c.fr'], ['@c.fr'], [undefined], [null], [42]])(
    'refuse %p',
    (input) => {
      expect(normalizeEmail(input as unknown)).toBeNull();
    }
  );
});

describe('autres normalisations', () => {
  it('code postal : 5 chiffres, espaces ignorés', () => {
    expect(normalizePostalCode('69 003')).toBe('69003');
    expect(normalizePostalCode(75001)).toBe('75001');
    expect(normalizePostalCode('7500')).toBeNull();
    expect(normalizePostalCode('ABCDE')).toBeNull();
  });

  it('texte : insensible à la casse, aux accents et à la ponctuation', () => {
    expect(normalizeText('  Éric  DUPONT-Martin ')).toBe('eric dupont martin');
    expect(normalizeText(undefined)).toBe('');
  });

  it('découpe et recompose un nom complet', () => {
    expect(splitFullName('Jean Dupont')).toEqual({ firstName: 'Jean', lastName: 'Dupont' });
    expect(splitFullName('Jean de la Fontaine')).toEqual({ firstName: 'Jean', lastName: 'de la Fontaine' });
    expect(splitFullName('Dupont')).toEqual({ firstName: '', lastName: 'Dupont' });
    expect(splitFullName('')).toEqual({ firstName: '', lastName: '' });
    expect(joinFullName(' Jean ', 'Dupont')).toBe('Jean Dupont');
    expect(joinFullName('', 'Dupont')).toBe('Dupont');
  });
});

describe("isMaintenanceCampaign (même règle que l'ancien CRM)", () => {
  it('nom contenant « entretien », sans tenir compte de la casse ni des accents', () => {
    expect(isMaintenanceCampaign('Entretien Chaudière')).toBe(true);
    expect(isMaintenanceCampaign('campagne ENTRETIEN pac')).toBe(true);
    expect(isMaintenanceCampaign('PAC IDF — Septembre')).toBe(false);
    expect(isMaintenanceCampaign(null)).toBe(false);
    expect(isMaintenanceCampaign(undefined)).toBe(false);
  });
});
