// Messages d'erreur lisibles pour les écritures d'administration. Module pur (sans Firebase) : testable.

type Coded = { code?: string; message?: string } | null | undefined;

const GENERIC = "Une erreur est survenue. Réessayez, et prévenez l'administrateur technique si elle persiste.";

/**
 * Traduit une erreur en phrase pour l'utilisateur :
 *  - refus métier (AdminRuleError) : son message tel quel, déjà rédigé pour l'administrateur ;
 *  - droits (règles Firestore ou fonction) : phrase fixe, jamais « Missing or insufficient permissions » ;
 *  - service indisponible : phrase fixe ;
 *  - le reste : message générique, jamais une trace technique.
 */
export function errorMessage(err: unknown): string {
  const e = err as Coded;
  const code = e?.code ?? '';
  if (code === 'functions/unauthenticated' || code === 'unauthenticated') return 'Votre session a expiré. Reconnectez-vous.';
  if (code === 'functions/permission-denied' || code === 'permission-denied') return "Vous n'avez pas le droit d'effectuer cette action.";
  if (code === 'functions/not-found' || code === 'functions/unavailable' || code === 'unavailable') {
    return 'Le service est indisponible pour le moment. Réessayez dans quelques instants.';
  }
  if (code === 'failed-precondition' && /index/i.test(e?.message ?? '')) return GENERIC; // message Firestore technique
  const msg = typeof e?.message === 'string' ? e.message.trim() : '';
  return msg && !/^internal$/i.test(msg) && !/^(firebase|firestore)/i.test(msg) ? msg : GENERIC;
}

/**
 * Mode d'écriture :
 *  - 'direct'    (défaut) : depuis le navigateur, protégé par les règles Firestore ;
 *  - 'functions' : via les fonctions Firebase (secours, quand elles sont déployées).
 */
export type WriteMode = 'direct' | 'functions';

export function resolveWriteMode(value: unknown): WriteMode {
  return value === 'functions' ? 'functions' : 'direct';
}
