import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { canAccessPath, homePathForRole } from '../config/navigation';
import { AccessMessage } from '../pages/common/AccessMessage';

/** Protège toutes les routes du CRM : connexion + compte actif + rôle autorisé + route autorisée. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state, user, logout } = useAuth();
  const location = useLocation();

  if (state === 'loading') {
    return <div className="p-6 text-sm text-slate-500">Chargement…</div>;
  }
  if (state === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (state === 'blocked') {
    return (
      <AccessMessage
        title="Compte désactivé"
        text="Votre compte est désactivé ou introuvable. Contactez votre administrateur."
        onLogout={logout}
      />
    );
  }
  if (state === 'noAccess') {
    return (
      <AccessMessage
        title="Accès non autorisé"
        text="Votre rôle n'ouvre pas l'accès au CRM Leads. Contactez votre administrateur si vous pensez que c'est une erreur."
        onLogout={logout}
      />
    );
  }

  // state === 'ready' : user est défini
  const role = user!.role;
  if (!canAccessPath(role, location.pathname)) {
    return <Navigate to={homePathForRole(role)} replace />;
  }
  return <>{children}</>;
}
