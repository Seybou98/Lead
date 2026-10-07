// Même projet Firebase que le CRM principal (Auth, Firestore, Storage partagés).
// Toutes les collections de ce module sont préfixées `cl_` (voir src/domain/collections.ts)
// pour ne jamais entrer en collision avec `leads`, `users`, `notifications`… du CRM principal.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { getStorage } from 'firebase/storage';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Pas de cache persistant : les compteurs SLA et les alertes doivent refléter l'état serveur.
// Les champs `undefined` (ex. une raison absente) sont ignorés au lieu de faire échouer l'écriture.
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const storage = getStorage(app);

// Même région que les fonctions du CRM Leads (functions/src/index.ts).
export const functions = getFunctions(app, "europe-west1");
