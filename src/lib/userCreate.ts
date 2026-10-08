// Création d'un utilisateur depuis le CRM Leads (fig. 21). Même méthode que la création d'utilisateur du CRM
// principal : le compte Firebase Auth est créé par une SECONDE instance de l'application (sinon l'administrateur
// serait déconnecté), puis `users/{uid}` est écrit. L'invitation est l'e-mail Firebase de définition du mot de
// passe : aucun mot de passe n'est choisi ni communiqué.

import { deleteApp, initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, sendPasswordResetEmail, signOut } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, firebaseConfig } from './firebase';
import { saveProfile, saveTeam, type TeamInput } from './adminApi';
import { accessEndsAtMs, buildMainUserDoc, fullName, generateTempPassword, type NewUserInput } from '../domain/admin/newUser';

export interface CreateUserOptions {
  input: NewUserInput;
  /** Brouillon : compte inactif, sans équipe ni profil de distribution. */
  draft: boolean;
  /** Envoie l'e-mail d'invitation (définition du mot de passe). Sinon, le mot de passe saisi est utilisé. */
  invite: boolean;
  /** Équipe choisie, avec ses données actuelles (pour y ajouter le membre sans rien écraser). */
  team: TeamInput | null;
}

export interface CreateUserResult {
  uid: string;
  /** Étapes non bloquantes qui ont échoué (le compte existe : elles se refont depuis la liste). */
  warnings: string[];
}

const AUTH_MESSAGES: Record<string, string> = {
  'auth/email-already-in-use': 'Cet email est déjà utilisé par un compte existant.',
  'auth/invalid-email': 'Adresse email invalide.',
  'auth/operation-not-allowed': "La connexion par email et mot de passe n'est pas activée sur ce projet Firebase.",
  'auth/weak-password': 'Mot de passe provisoire refusé : réessayez.',
  'auth/network-request-failed': 'Réseau indisponible. Vérifiez votre connexion et réessayez.',
};

export class CreateUserError extends Error {}

export async function createUser({ input, draft, invite, team }: CreateUserOptions): Promise<CreateUserResult> {
  const email = input.email.trim().toLowerCase();
  const warnings: string[] = [];

  const secondary = initializeApp(firebaseConfig, `cl-create-user-${Date.now()}`);
  const secondaryAuth = getAuth(secondary);
  let uid: string;
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, invite || draft ? generateTempPassword((n) => crypto.getRandomValues(new Uint8Array(n))) : input.password);
    uid = cred.user.uid;
    try {
      await setDoc(doc(db, 'users', uid), { ...buildMainUserDoc({ uid, input, draft }), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } catch {
      throw new CreateUserError(`Le compte de connexion de ${email} a été créé, mais pas sa fiche utilisateur (droits Firestore). Créez-la depuis le CRM principal avant de réessayer.`);
    }

    if (invite) {
      try {
        await sendPasswordResetEmail(secondaryAuth, email);
      } catch {
        warnings.push("Le compte est créé mais l'e-mail d'invitation n'a pas pu être envoyé. Utilisez « Mot de passe oublié » sur la page de connexion.");
      }
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (e instanceof CreateUserError) throw e;
    throw new CreateUserError(AUTH_MESSAGES[code] ?? (e instanceof Error ? e.message : "Impossible de créer l'utilisateur."));
  } finally {
    await signOut(secondaryAuth).catch(() => undefined);
    await deleteApp(secondary).catch(() => undefined);
  }

  // Profil de distribution et équipe : uniquement pour un télépro, et seulement si le compte est actif
  // (un brouillon n'entre ni dans une équipe ni dans la distribution).
  if (input.role === 'telepro' && !draft) {
    try {
      const capNum = input.cap.trim() === '' ? null : Number(input.cap);
      const res = await saveProfile({
        uid,
        newLeadsCap: capNum,
        scope: { productCodes: input.products, zones: input.zones, campaignIds: input.campaignIds, sourceIds: [] },
        distributionSuspended: !input.autoDistribution,
        accessEndsAtMs: accessEndsAtMs(input.accessEndsOn),
        reason: `Création de ${fullName(input)}`,
      });
      warnings.push(...res.warnings);
    } catch (e) {
      warnings.push(`Profil de distribution non enregistré : ${e instanceof Error ? e.message : 'erreur inconnue'}. Configurez-le depuis la liste.`);
    }
    if (team) {
      try {
        const res = await saveTeam({ ...team, memberIds: [...new Set([...team.memberIds, uid])], reason: `Ajout de ${fullName(input)}` });
        warnings.push(...res.warnings);
      } catch (e) {
        warnings.push(`Ajout à l'équipe impossible : ${e instanceof Error ? e.message : 'erreur inconnue'}. Ajoutez-le depuis l'équipe.`);
      }
    }
  }
  return { uid, warnings };
}
