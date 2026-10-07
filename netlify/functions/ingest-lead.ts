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

import { ingestLead } from '../../functions/src/ingest';
import { handleIngestHttp, resolveSourceId } from '../../functions/src/http';
import { getDb, jsonResponse as json, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

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
