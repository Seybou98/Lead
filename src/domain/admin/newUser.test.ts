import { describe, expect, it } from 'vitest';
import {
  accessEndsAtMs,
  buildMainUserDoc,
  EMPTY_NEW_USER,
  generateTempPassword,
  initialsOf,
  isValidPhone,
  MAIN_ROLE_VALUE,
  roleIsRecognised,
  validateNewUser,
  type NewUserInput,
} from './newUser';
import { ROLES } from '../enums';

const NOW = Date.parse('2026-10-08T10:00:00');
const ok: NewUserInput = { ...EMPTY_NEW_USER, firstName: 'Nadia', lastName: 'Martin', email: 'nadia.martin@label-energie.fr', phone: '06 12 34 56 78' };

describe('validateNewUser', () => {
  it('saisie complète : aucune erreur', () => expect(validateNewUser(ok, NOW)).toEqual({}));
  it('prénom, nom et email obligatoires', () => {
    const e = validateNewUser({ ...ok, firstName: ' ', lastName: '', email: '' }, NOW);
    expect(Object.keys(e).sort()).toEqual(['email', 'firstName', 'lastName']);
  });
  it('email invalide', () => {
    for (const email of ['nadia', 'nadia@', 'a@b', 'a b@c.fr', '@c.fr']) expect(validateNewUser({ ...ok, email }, NOW).email).toBeTruthy();
  });
  it('téléphone facultatif, mais valide si renseigné', () => {
    expect(validateNewUser({ ...ok, phone: '' }, NOW).phone).toBeUndefined();
    expect(validateNewUser({ ...ok, phone: 'abc' }, NOW).phone).toBeTruthy();
    expect(validateNewUser({ ...ok, phone: '0612' }, NOW).phone).toBeTruthy();
    expect(isValidPhone('+33 6 12 34 56 78')).toBe(true);
    expect(isValidPhone('06.12.34.56.78')).toBe(true);
  });
  it('rôle inconnu refusé', () => expect(validateNewUser({ ...ok, role: 'god' as never }, NOW).role).toBeTruthy());
  it("fin d'accès : le jour même passe, la veille non, une date absurde non", () => {
    expect(validateNewUser({ ...ok, accessEndsOn: '2026-10-08' }, NOW).accessEndsOn).toBeUndefined();
    expect(validateNewUser({ ...ok, accessEndsOn: '2026-10-07' }, NOW).accessEndsOn).toBeTruthy();
    expect(validateNewUser({ ...ok, accessEndsOn: '2026-13-45' }, NOW).accessEndsOn).toBeTruthy();
  });
  it('plafond : entier 0-100, vide = défaut, ignoré hors télépro', () => {
    expect(validateNewUser({ ...ok, cap: '' }, NOW).cap).toBeUndefined();
    expect(validateNewUser({ ...ok, cap: '0' }, NOW).cap).toBeUndefined();
    for (const cap of ['-1', '101', '2.5', 'x']) expect(validateNewUser({ ...ok, cap }, NOW).cap).toBeTruthy();
    expect(validateNewUser({ ...ok, role: 'manager', cap: 'x' }, NOW).cap).toBeUndefined();
  });
});

describe('mot de passe sans invitation', () => {
  it('avec invitation : aucun mot de passe exigé', () => expect(validateNewUser({ ...ok, invite: true, password: '' }, NOW).password).toBeUndefined());
  it('sans invitation : 8 caractères minimum, avec une lettre et un chiffre', () => {
    const v = (password: string) => validateNewUser({ ...ok, invite: false, password }, NOW).password;
    expect(v('')).toMatch(/au moins 8/);
    expect(v('abc123')).toMatch(/au moins 8/);
    expect(v('abcdefgh')).toMatch(/lettre et un chiffre/);
    expect(v('12345678')).toMatch(/lettre et un chiffre/);
    expect(v('motdepasse1')).toBeUndefined();
  });
});

describe('compte du CRM principal', () => {
  it('chaque rôle écrit est reconnu par la table des rôles', () => {
    for (const r of ROLES) expect(roleIsRecognised(r)).toBe(true);
    expect(MAIN_ROLE_VALUE.telepro).toBe('telepro commercial');
  });
  it('actif avec invitation, inactif en brouillon', () => {
    expect(buildMainUserDoc({ uid: 'u1', input: ok, draft: false })).toMatchObject({ id: 'u1', name: 'Nadia Martin', email: 'nadia.martin@label-energie.fr', role: 'telepro commercial', status: 'active', createdFrom: 'crm-leads' });
    expect(buildMainUserDoc({ uid: 'u1', input: ok, draft: true }).status).toBe('inactive');
  });
  it("email en minuscules, champs facultatifs absents s'ils sont vides, aucun mot de passe", () => {
    const d = buildMainUserDoc({ uid: 'u1', input: { ...ok, email: ' Nadia@Label.FR ', phone: '', jobTitle: '' }, draft: false });
    expect(d.email).toBe('nadia@label.fr');
    expect('phone' in d).toBe(false);
    expect('jobTitle' in d).toBe(false);
    expect('password' in d).toBe(false);
  });
});

describe('divers', () => {
  it('mot de passe provisoire : 24 caractères, tirés de l\'alphabet, différents à chaque tirage', () => {
    const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const a = generateTempPassword(rnd);
    expect(a).toHaveLength(24);
    expect(a).not.toBe(generateTempPassword(rnd));
    expect(a).not.toMatch(/[Il1O0\s]/);
  });
  it('date de fin : fin de journée locale, ou null', () => {
    expect(accessEndsAtMs('')).toBeNull();
    expect(accessEndsAtMs('2026-10-08')).toBe(Date.parse('2026-10-08T23:59:59'));
    expect(accessEndsAtMs('nope')).toBeNull();
  });
  it('initiales', () => {
    expect(initialsOf('Nadia Martin')).toBe('NM');
    expect(initialsOf('')).toBe('?');
  });
});
