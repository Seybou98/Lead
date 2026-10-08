import { describe, expect, it } from 'vitest';
import { ROLES } from '../domain/enums';
import { canAccessPath, getNavigation, homePathForRole, NAVIGATION } from './navigation';

const names = (role: Parameters<typeof getNavigation>[0]) =>
  getNavigation(role).flatMap((g) => g.items.map((i) => i.name));

describe('navigation par profil (§25.2)', () => {
  it('télépro : Ma journée, Mes leads, Documents, Dossiers, Ventes, Messages — rien d\'administratif', () => {
    expect(names('telepro')).toEqual(['Ma journée', 'Mes leads', 'Documents', 'Dossiers', 'Ventes', 'Messages']);
  });

  it('manager : Cockpit, Équipe, Leads, Documents, Dossiers, Ventes, Rapports — sans paramétrage admin', () => {
    expect(names('manager')).toEqual(['Cockpit', 'Équipe', 'Leads', 'Documents', 'Dossiers', 'Ventes', 'Rapports']);
  });

  it('admin : voit le pilotage et le bloc Administration', () => {
    const list = names('admin');
    expect(list).toEqual(
      expect.arrayContaining(['Cockpit', 'Campagnes', 'Utilisateurs', 'Journal', 'Intégrations', 'Paramètres'])
    );
    expect(list).not.toContain('Ma journée');
  });

  it('le groupe Administration est absent pour manager et télépro', () => {
    expect(getNavigation('manager').some((g) => g.label === 'Administration')).toBe(false);
    expect(getNavigation('telepro').some((g) => g.label === 'Administration')).toBe(false);
  });
});

describe('accès aux routes', () => {
  it('un télépro ne peut pas ouvrir le cockpit, les campagnes ni les paramètres', () => {
    expect(canAccessPath('telepro', '/cockpit')).toBe(false);
    expect(canAccessPath('telepro', '/campagnes')).toBe(false);
    expect(canAccessPath('telepro', '/journal')).toBe(false);
    expect(canAccessPath('telepro', '/parametres/sla')).toBe(false);
  });

  it('un manager ne peut pas ouvrir les paramètres admin', () => {
    expect(canAccessPath('manager', '/parametres')).toBe(false);
    expect(canAccessPath('manager', '/utilisateurs')).toBe(false);
    expect(canAccessPath('manager', '/journal')).toBe(false);
    expect(canAccessPath('manager', '/parametres/attribution')).toBe(false);
  });

  it('un admin accède aux sous-routes de ses modules', () => {
    expect(canAccessPath('admin', '/parametres/sla')).toBe(true);
    expect(canAccessPath('admin', '/cockpit')).toBe(true);
    expect(canAccessPath('admin', '/parametres/attribution')).toBe(true);
    expect(canAccessPath('admin', '/journal')).toBe(true);
  });

  it("les fiches lead suivent le menu : un télépro n'ouvre que /mes-leads/…, un manager /leads/…", () => {
    expect(canAccessPath('telepro', '/mes-leads/abc123')).toBe(true);
    expect(canAccessPath('telepro', '/leads/abc123')).toBe(false);
    expect(canAccessPath('manager', '/leads/abc123')).toBe(true);
    expect(canAccessPath('manager', '/mes-leads/abc123')).toBe(false);
    expect(canAccessPath('admin', '/leads/abc123')).toBe(true);
  });

  it('une route inconnue est refusée', () => {
    for (const role of ROLES) expect(canAccessPath(role, '/n-importe-quoi')).toBe(false);
  });

  it('la page d\'accueil de chaque rôle lui est accessible', () => {
    for (const role of ROLES) expect(canAccessPath(role, homePathForRole(role))).toBe(true);
  });

  it('chaque href est unique', () => {
    const hrefs = NAVIGATION.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
