// Vérification d'un jeton d'identité Firebase (celui que le navigateur envoie dans « Authorization: Bearer »), sans passer
// par `firebase-admin/auth`.
//
// Pourquoi : `firebase-admin/auth` charge `jwks-rsa`, qui fait un `require()` d'un module ES (`jose` v6). Cela plante au
// chargement sur le Node 20 de Netlify (« ERR_REQUIRE_ESM »), et fait tomber TOUTES les fonctions qui partagent le module.
// `jose` s'importe sans problème par `import()`, et la vérification suit la méthode documentée par Google : signature RS256
// contre les clés publiques de securetoken, émetteur et audience = identifiant du projet, sujet non vide.

import type { JWTVerifyGetKey } from 'jose';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export interface VerifiedToken {
  uid: string;
}

let remoteKeys: JWTVerifyGetKey | null = null;

/** Clés publiques de Google, gardées en mémoire par `jose` (mise en cache et rotation gérées par la bibliothèque). */
async function googleKeys(): Promise<JWTVerifyGetKey> {
  if (!remoteKeys) {
    const { createRemoteJWKSet } = await import('jose');
    remoteKeys = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return remoteKeys;
}

/**
 * Rend l'uid d'un jeton valide, ou lève une erreur (jeton absent, mal formé, expiré, d'un autre projet, mal signé).
 * `keys` n'est fourni que par les tests.
 */
export async function verifyFirebaseIdToken(token: string, projectId: string, keys?: JWTVerifyGetKey, nowMs: number = Date.now()): Promise<VerifiedToken> {
  if (!token || typeof token !== 'string' || token.length > 4096) throw new Error('Jeton absent ou démesuré.');
  if (!projectId) throw new Error('Projet Firebase inconnu : impossible de vérifier le jeton.');
  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(token, keys ?? (await googleKeys()), {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    currentDate: new Date(nowMs),
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) throw new Error('Jeton sans identifiant utilisateur.');
  // Un jeton dont l'authentification serait datée du futur n'est pas un jeton Firebase.
  if (typeof payload.auth_time === 'number' && payload.auth_time * 1000 > nowMs + 5 * 60_000) throw new Error('Date d’authentification invalide.');
  return { uid: payload.sub };
}
