// Navigation par profil — cahier des charges §25.2.
// Fichier volontairement sans React : il est testé unitairement (navigation.test.ts).

import type { Role } from '../domain/enums';

export type NavIconName =
  | 'calendar-check'
  | 'users'
  | 'file-text'
  | 'bar-chart'
  | 'folder'
  | 'message-square'
  | 'gauge'
  | 'user-cog'
  | 'pie-chart'
  | 'megaphone'
  | 'plug'
  | 'scroll-text'
  | 'settings';

export interface NavItem {
  name: string;
  href: string;
  icon: NavIconName;
  roles: readonly Role[];
}

export interface NavGroup {
  /** null = hors bloc, sans libellé */
  label: string | null;
  items: NavItem[];
}

const ALL: readonly Role[] = ['admin', 'manager', 'telepro'];
const PILOTAGE: readonly Role[] = ['admin', 'manager'];
const ADMIN: readonly Role[] = ['admin'];

export const NAVIGATION: NavGroup[] = [
  {
    label: null,
    items: [
      // Télépro
      { name: 'Ma journée', href: '/ma-journee', icon: 'calendar-check', roles: ['telepro'] },
      { name: 'Mes leads', href: '/mes-leads', icon: 'users', roles: ['telepro'] },
      // Manager / admin
      { name: 'Cockpit', href: '/cockpit', icon: 'gauge', roles: PILOTAGE },
      { name: 'Équipe', href: '/equipe', icon: 'users', roles: PILOTAGE },
      { name: 'Leads', href: '/leads', icon: 'users', roles: PILOTAGE },
      // Communs
      { name: 'Documents', href: '/documents', icon: 'file-text', roles: ALL },
      { name: 'Dossiers', href: '/dossiers', icon: 'folder', roles: ALL },
      { name: 'Ventes', href: '/ventes', icon: 'bar-chart', roles: ALL },
      { name: 'Messages', href: '/messages', icon: 'message-square', roles: ['telepro'] },
      { name: 'Rapports', href: '/rapports', icon: 'pie-chart', roles: PILOTAGE },
    ],
  },
  {
    label: 'Administration',
    items: [
      { name: 'Campagnes', href: '/campagnes', icon: 'megaphone', roles: ADMIN },
      { name: 'Utilisateurs', href: '/utilisateurs', icon: 'user-cog', roles: ADMIN },
      { name: 'Journal', href: '/journal', icon: 'scroll-text', roles: ADMIN },
      { name: 'Intégrations', href: '/integrations', icon: 'plug', roles: ADMIN },
      { name: 'Paramètres', href: '/parametres', icon: 'settings', roles: ADMIN },
    ],
  },
];

/** Entrées de menu visibles pour un rôle, groupes vides retirés. */
export function getNavigation(role: Role): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.roles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

export function homePathForRole(role: Role): string {
  return role === 'telepro' ? '/ma-journee' : '/cockpit';
}

/** Une URL est autorisée si son premier segment correspond à une entrée de menu du rôle. */
export function canAccessPath(role: Role, pathname: string): boolean {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return true;
  return NAVIGATION.some((group) =>
    group.items.some((item) => item.href === `/${first}` && item.roles.includes(role))
  );
}
