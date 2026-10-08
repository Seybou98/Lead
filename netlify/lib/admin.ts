// Accès Firebase admin partagé par les fonctions Netlify (réception des leads, qualification d'appel).
// Réutilisé tant que le conteneur reste chaud : Firebase n'est initialisé qu'une fois.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applicationDefault, cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { parseServiceAccount } from '../../functions/src/serviceAccount';
import { verifyFirebaseIdToken, type VerifiedToken } from '../../functions/src/idToken';
import type { StorageLike } from '../../functions/src/transmission';

let db: Firestore | undefined;
/** Identifiant du projet Firebase, connu dès l'initialisation (sert à vérifier l'émetteur des jetons). */
let projectId = '';

function ensureApp(): void {
  if (getApps().length) return;
  const env = process.env as Record<string, string | undefined>;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 && !env.FIREBASE_SERVICE_ACCOUNT_JSON && env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Essai en local (`netlify dev`) : fichier de clé indiqué par GOOGLE_APPLICATION_CREDENTIALS.
    const svc = JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')) as { project_id: string };
    projectId = svc.project_id;
    initializeApp({ credential: applicationDefault(), projectId: svc.project_id });
  } else {
    const svc = parseServiceAccount(env);
    projectId = svc.project_id;
    initializeApp({ credential: cert({ projectId: svc.project_id, clientEmail: svc.client_email, privateKey: svc.private_key }), projectId: svc.project_id });
  }
}

export function getDb(): Firestore {
  if (db) return db;
  ensureApp();
  db = getFirestore();
  // Les champs `undefined` (ex. une raison absente) sont ignorés au lieu de faire échouer l'écriture.
  // `settings()` ne peut être appelé qu'UNE fois par instance : en développement, la fonction est recompilée à
  // chaque appel mais firebase-admin (externe) garde son instance, d'où ce garde-fou. Sur Netlify, le module
  // reste en mémoire et l'appel n'a lieu qu'une fois.
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch (e) {
    if (!/already been initialized/i.test((e as Error).message)) throw e;
  }
  return db;
}

/**
 * Vérification des jetons d'identité Firebase. Volontairement SANS `firebase-admin/auth` : ce module charge une chaîne de
 * dépendances (jwks-rsa → jose) qui plante au démarrage sur le Node 20 de Netlify et ferait tomber toutes les fonctions,
 * y compris la réception des leads. Voir functions/src/idToken.ts.
 */
export function getAdminAuth(): { verifyIdToken: (token: string) => Promise<VerifiedToken> } {
  ensureApp();
  // En développement le module est recompilé à chaque appel alors que l'app Firebase reste en mémoire : on relit donc
  // l'identifiant du projet depuis l'app plutôt que de se fier à la variable du module.
  const id = projectId || (getApp().options.projectId ?? '');
  return { verifyIdToken: (token) => verifyFirebaseIdToken(token, id) };
}

/**
 * Copie de fichiers Storage (pièces transmises au CRM principal). Chargé à la demande : les autres fonctions
 * n'embarquent pas le module Storage. Rend null si Storage est indisponible (la transmission le signale).
 */
export async function getStorageAdapter(): Promise<StorageLike | null> {
  ensureApp();
  try {
    const { getStorage } = await import('firebase-admin/storage');
    const bucket = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET?.trim() || `${projectId || getApp().options.projectId}.firebasestorage.app`);
    return {
      async copy(srcPath, destPath) {
        const dest = bucket.file(destPath);
        await bucket.file(srcPath).copy(dest);
        // Jeton de téléchargement : même forme d'adresse que celles des envois faits par le CRM principal.
        const token = randomUUID();
        await dest.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
        return { url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destPath)}?alt=media&token=${token}` };
      },
    };
  } catch (e) {
    console.error('storage indisponible', e);
    return null;
  }
}

export interface NetlifyEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded?: boolean;
}

export interface NetlifyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const jsonResponse = (statusCode: number, body: unknown): NetlifyResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
