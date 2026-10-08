// Création d'un utilisateur depuis le CRM Leads (fig. 21). Fonctions pures : validation de la saisie, forme du
// compte du CRM principal (`users/{uid}`) et mot de passe provisoire. L'écriture (Firebase Auth + Firestore)
// est dans src/lib/userCreate.ts.

import type { Role } from '../enums';
import { ROLES } from '../enums';
import { resolveLeadRole } from '../../config/roles';

export interface NewUserInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  role: Role;
  /** Date de fin d'accès au format AAAA-MM-JJ, ou vide. */
  accessEndsOn: string;
  teamId: string;
  products: string[];
  zones: string[];
  campaignIds: string[];
  /** Vide = valeur par défaut de la configuration. */
  cap: string;
  autoDistribution: boolean;
  /** Envoi de l'e-mail d'invitation (l'utilisateur choisit son mot de passe). */
  invite: boolean;
  /** Mot de passe choisi par l'administrateur ; exigé seulement sans invitation. */
  password: string;
}

export const EMPTY_NEW_USER: NewUserInput = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  jobTitle: '',
  role: 'telepro',
  accessEndsOn: '',
  teamId: '',
  products: [],
  zones: [],
  campaignIds: [],
  cap: '10',
  autoDistribution: true,
  invite: true,
  password: '',
};

/** Libellé du rôle écrit dans `users/{uid}.role` : celui que reconnaissent le CRM principal et les règles Firestore. */
export const MAIN_ROLE_VALUE: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'manager',
  telepro: 'telepro commercial',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const MIN_PASSWORD = 8;

export type NewUserErrors = Partial<Record<'firstName' | 'lastName' | 'email' | 'phone' | 'role' | 'accessEndsOn' | 'cap' | 'password', string>>;

/** « 06 12 34 56 78 », « +33 6 12 34 56 78 » : 9 à 15 chiffres, sans autre caractère que les séparateurs usuels. */
export const isValidPhone = (v: string): boolean => /^\+?[\d\s.()-]+$/.test(v) && v.replace(/\D/g, '').length >= 9 && v.replace(/\D/g, '').length <= 15;

export function validateNewUser(input: NewUserInput, todayMs: number): NewUserErrors {
  const e: NewUserErrors = {};
  if (!input.firstName.trim()) e.firstName = 'Le prénom est obligatoire.';
  if (!input.lastName.trim()) e.lastName = 'Le nom est obligatoire.';
  if (!input.email.trim()) e.email = "L'email professionnel est obligatoire.";
  else if (!EMAIL.test(input.email.trim())) e.email = 'Adresse email invalide.';
  if (input.phone.trim() && !isValidPhone(input.phone.trim())) e.phone = 'Numéro de téléphone invalide.';
  if (!(ROLES as readonly string[]).includes(input.role)) e.role = 'Choisissez un rôle.';
  if (input.accessEndsOn) {
    const t = Date.parse(`${input.accessEndsOn}T23:59:59`);
    if (!Number.isFinite(t)) e.accessEndsOn = 'Date invalide.';
    else if (t < todayMs) e.accessEndsOn = "La date de fin d'accès est déjà passée.";
  }
  // Sans invitation, l'administrateur fixe le mot de passe : il doit être utilisable pour se connecter.
  if (!input.invite) {
    if (input.password.length < MIN_PASSWORD) e.password = `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`;
    else if (!/[A-Za-z]/.test(input.password) || !/\d/.test(input.password)) e.password = 'Mélangez au moins une lettre et un chiffre.';
  }
  if (input.role === 'telepro' && input.cap.trim() !== '') {
    const n = Number(input.cap);
    if (!Number.isInteger(n) || n < 0 || n > 100) e.cap = 'Un nombre entier entre 0 et 100.';
  }
  return e;
}

export const fullName = (i: Pick<NewUserInput, 'firstName' | 'lastName'>): string => `${i.firstName.trim()} ${i.lastName.trim()}`.trim();

/** Fin d'accès : fin de la journée choisie (heure locale du navigateur), ou null. */
export const accessEndsAtMs = (on: string): number | null => {
  if (!on) return null;
  const t = Date.parse(`${on}T23:59:59`);
  return Number.isFinite(t) ? t : null;
};

/**
 * Compte du CRM principal. Même forme que celle écrite par la création d'utilisateur du CRM principal
 * (sans mot de passe : l'accès est ouvert par l'invitation). `status: 'inactive'` = brouillon, sans accès.
 */
export function buildMainUserDoc(args: { uid: string; input: NewUserInput; draft: boolean }): Record<string, unknown> {
  const { uid, input, draft } = args;
  const doc: Record<string, unknown> = {
    id: uid,
    name: fullName(input),
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim().toLowerCase(),
    role: MAIN_ROLE_VALUE[input.role],
    status: draft ? 'inactive' : 'active',
    team: '',
    avatar: '/avatars/avatar.png',
    conducteur: false,
    createdFrom: 'crm-leads',
  };
  if (input.phone.trim()) doc.phone = input.phone.trim();
  if (input.jobTitle.trim()) doc.jobTitle = input.jobTitle.trim();
  return doc;
}

/** Le rôle écrit est bien reconnu par le CRM Leads (garde-fou : une faute dans la table ferait un compte sans accès). */
export const roleIsRecognised = (role: Role): boolean => resolveLeadRole(MAIN_ROLE_VALUE[role]) === role;

/** Mot de passe provisoire : jamais communiqué, l'utilisateur choisit le sien via le lien d'invitation. */
export function generateTempPassword(randomBytes: (n: number) => Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%*+-?';
  const bytes = randomBytes(24);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';
