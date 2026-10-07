import { describe, expect, it } from 'vitest';
import { resolveLeadRole } from './roles';

describe('résolution du profil CRM Leads depuis users.role', () => {
  it('administrateur, quelle que soit la casse ou les espaces', () => {
    expect(resolveLeadRole('Administrateur')).toBe('admin');
    expect(resolveLeadRole('  administrateur ')).toBe('admin');
    expect(resolveLeadRole('admin')).toBe('admin');
  });

  it('manager', () => {
    expect(resolveLeadRole('Manager')).toBe('manager');
  });

  it("télépro-commercial, quelle que soit l'orthographe", () => {
    expect(resolveLeadRole('telepro commercial')).toBe('telepro');
    expect(resolveLeadRole('Télépro-commercial')).toBe('telepro');
    expect(resolveLeadRole('Télépro')).toBe('telepro');
  });

  it("le rôle « commercial » du CRM principal n'ouvre PAS le module (§2 : aucun rôle Commercial séparé)", () => {
    expect(resolveLeadRole('commercial')).toBeNull();
    expect(resolveLeadRole('Commerciale')).toBeNull();
  });

  it('les autres rôles du CRM principal n\'ont aucun accès au module', () => {
    for (const r of ['technicien', 'regie', 'mandataire', 'juriste', 'rh', 'chef equipe', 'logistique']) {
      expect(resolveLeadRole(r)).toBeNull();
    }
  });

  it('rôle absent ou vide : aucun accès', () => {
    expect(resolveLeadRole('')).toBeNull();
    expect(resolveLeadRole(undefined)).toBeNull();
    expect(resolveLeadRole(null)).toBeNull();
  });
});
