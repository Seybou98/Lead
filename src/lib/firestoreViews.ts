// Conversions Firestore → modèles d'affichage, partagées par les écrans d'administration.
import type { DocumentData, Timestamp } from 'firebase/firestore';
import type { MainUserView, TeamView } from '../domain/admin/userRows';

export const ms = (v: unknown): number | null => {
  const t = v as Timestamp | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toUser(id: string, d: DocumentData): MainUserView {
  const name = d.name || d.displayName || `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || '';
  return { uid: id, name, email: d.email ?? '', role: d.role ?? null, status: d.status ?? null };
}

export function toTeam(id: string, d: DocumentData): TeamView {
  return {
    id,
    name: d.name ?? id,
    managerId: d.managerId ?? '',
    secondaryManagerId: d.secondaryManagerId ?? null,
    memberIds: strs(d.memberIds),
    active: d.active !== false,
  };
}
