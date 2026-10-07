// Correspondance entre les rôles EXISTANTS du CRM principal (`users/{uid}.role`, texte libre,
// casse variable) et les trois profils du CRM Leads.
//
// ⚠️ Cette table existe aussi dans les règles Firestore (fonctions isClAdmin / isClManager /
// isClTelepro, voir firebase/RULES_A_APPLIQUER.md). Si tu la modifies ici, modifie-la là aussi.

import type { Role } from '../domain/enums';

// Cahier des charges §2 : trois profils — Administrateur, Manager, Télépro-commercial.
// « Aucun rôle Commercial séparé » : le rôle `commercial` du CRM principal n'ouvre PAS ce module.
// Le rôle à créer dans le CRM principal pour les télépros s'appelle « telepro commercial ».
const ROLE_MAP: Record<Role, readonly string[]> = {
  admin: ['administrateur', 'admin', 'administratrice'],
  manager: ['manager'],
  telepro: [
    'telepro commercial',
    'telepro-commercial',
    'télépro commercial',
    'télépro-commercial',
    'telepro',
    'télépro',
  ],
};

/** Profil CRM Leads d'un rôle du CRM principal, ou null si ce rôle n'a pas accès au module. */
export function resolveLeadRole(mainRole: string | null | undefined): Role | null {
  const normalized = (mainRole ?? '').trim().toLowerCase();
  if (!normalized) return null;
  for (const [leadRole, aliases] of Object.entries(ROLE_MAP) as [Role, readonly string[]][]) {
    if (aliases.includes(normalized)) return leadRole;
  }
  return null;
}
