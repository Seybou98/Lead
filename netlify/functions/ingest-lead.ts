// Réception des leads (Pabbly, Meta, formulaires, agences) — fonction Netlify, chemin PRINCIPAL.
//
//   POST https://<site>/api/leads?source=<idSource>        (redirection définie dans netlify.toml)
//   En-tête : X-CRM-SECRET: <secret>
//   Corps   : JSON ou formulaire (x-www-form-urlencoded)
//
// Variables d'environnement du site Netlify :
//   CL_INGEST_SECRET                      secret partagé avec la source de leads (ou CRM_SHARED_SECRET,
//                                         le nom utilisé par l'ancien CRM : on peut reprendre sa valeur)
//   FIREBASE_SERVICE_ACCOUNT_JSON_BASE64  clé du compte de service du projet Firebase visé
//                                         (ou FIREBASE_SERVICE_ACCOUNT_JSON) — mêmes noms que le CRM principal
//
// Toute la logique est dans functions/src (ingest.ts, http.ts), partagée avec la fonction Firebase de secours.

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { ingestLead } from '../../functions/src/ingest';
import { handleIngestHttp, resolveSourceId } from '../../functions/src/http';
import { parseServiceAccount } from '../../functions/src/serviceAccount';

interface NetlifyEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded?: boolean;
}

interface NetlifyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// Réutilisé tant que le conteneur reste chaud : on n'initialise Firebase qu'une fois.
let db: Firestore | undefined;

function getDb(): Firestore {
  if (db) return db;
  if (!getApps().length) {
    const svc = parseServiceAccount(process.env as Record<string, string | undefined>);
    initializeApp({ credential: cert({ projectId: svc.project_id, clientEmail: svc.client_email, privateKey: svc.private_key }), projectId: svc.project_id });
  }
  db = getFirestore();
  // Les champs `undefined` (ex. une raison absente) sont ignorés au lieu de faire échouer l'écriture.
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

const json = (statusCode: number, body: unknown): NetlifyResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleIngestHttp(
    {
      method: event.httpMethod,
      secret: event.headers['x-crm-secret'],
      sourceId: resolveSourceId(event.queryStringParameters?.source, event.headers['x-source-id']),
      contentType: event.headers['content-type'],
      rawBody,
    },
    {
      expectedSecret: (process.env.CL_INGEST_SECRET || process.env.CRM_SHARED_SECRET || '').trim(),
      // getDb() peut échouer (clé absente ou illisible) : handleIngestHttp répond alors 500 sans détail technique.
      run: ({ sourceId, payload }) => ingestLead(getDb(), { channel: 'webhook', sourceId, payload, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return json(out.status, out.body);
};
