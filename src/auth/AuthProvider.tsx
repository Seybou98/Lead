import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { COL } from '../domain/collections';
import type { Role } from '../domain/enums';
import type { Profile } from '../domain/models';
import { resolveLeadRole } from '../config/roles';

/**
 * Même système de connexion que le CRM principal :
 *   Firebase Auth  →  users/{uid} (role, status)  →  droits.
 * Le rôle du CRM principal est traduit en profil CRM Leads par `resolveLeadRole`.
 *
 * - loading   : Auth ou users/{uid} n'a pas encore répondu
 * - signedOut : personne de connecté
 * - blocked   : users/{uid} absent ou status ≠ 'active'
 * - noAccess  : compte actif mais son rôle n'ouvre pas le CRM Leads (technicien, régie, …)
 * - ready     : accès accordé
 */
export type AuthState = 'loading' | 'signedOut' | 'blocked' | 'noAccess' | 'ready';

export interface LeadUser {
  uid: string;
  email: string;
  name: string;
  /** Rôle tel qu'écrit dans users/{uid}.role (ex. « Administrateur »). */
  mainRole: string;
  /** Profil CRM Leads résolu depuis mainRole. */
  role: Role;
  /** Données opérationnelles CRM Leads (cl_profiles/{uid}) ; null tant que l'utilisateur n'est rattaché à aucune équipe. */
  profile: Profile | null;
}

interface AuthContextValue {
  state: AuthState;
  user: LeadUser | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface MainUserDoc {
  role?: string;
  status?: string;
  name?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

function displayName(data: MainUserDoc, fallbackEmail: string): string {
  return (
    data.name ||
    data.displayName ||
    `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim() ||
    fallbackEmail
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [mainDoc, setMainDoc] = useState<MainUserDoc | null>(null);
  const [mainReady, setMainReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (!user) {
        setMainDoc(null);
        setProfile(null);
        setMainReady(true);
      } else {
        setMainReady(false);
      }
    });
  }, []);

  // users/{uid} en temps réel : un changement de rôle ou de statut dans le CRM principal
  // s'applique sans nouvelle connexion (§20.11).
  useEffect(() => {
    if (!firebaseUser) return;
    return onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        setMainDoc(snap.exists() ? (snap.data() as MainUserDoc) : null);
        setMainReady(true);
      },
      () => {
        // Erreur de lecture : on refuse l'accès, on ne l'accorde jamais par défaut.
        setMainDoc(null);
        setMainReady(true);
      }
    );
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) return;
    return onSnapshot(
      doc(db, COL.profiles, firebaseUser.uid),
      (snap) => setProfile(snap.exists() ? (snap.data() as Profile) : null),
      () => setProfile(null)
    );
  }, [firebaseUser]);

  const value = useMemo<AuthContextValue>(() => {
    const logout = () => signOut(auth);
    if (!authReady || !mainReady) return { state: 'loading', user: null, logout };
    if (!firebaseUser) return { state: 'signedOut', user: null, logout };

    const active = String(mainDoc?.status ?? '').toLowerCase() === 'active';
    if (!mainDoc || !active) return { state: 'blocked', user: null, logout };

    const role = resolveLeadRole(mainDoc.role);
    if (!role) return { state: 'noAccess', user: null, logout };

    const email = mainDoc.email ?? firebaseUser.email ?? '';
    return {
      state: 'ready',
      user: {
        uid: firebaseUser.uid,
        email,
        name: displayName(mainDoc, email),
        mainRole: mainDoc.role ?? '',
        role,
        profile,
      },
      logout,
    };
  }, [authReady, mainReady, firebaseUser, mainDoc, profile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
