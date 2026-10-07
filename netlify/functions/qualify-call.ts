// Qualification de fin d'appel (Ma journée) — fonction Netlify.
//
//   POST https://<site>/api/qualify-call            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase du télépro connecté>
//   Corps   : { leadId, requestId, expectedStatus, durationSeconds, input: { kind, ... } }
//
// Même clé Firebase que la réception des leads (FIREBASE_SERVICE_ACCOUNT_JSON_BASE64). Aucun secret partagé :
// l'identité vient du jeton, le rôle de users/{uid}. Logique dans functions/src (qualify.ts, qualifyHttp.ts)
// et src/domain/call/plan.ts.

import { qualifyCall } from '../../functions/src/qualify';
import { handleQualifyHttp } from '../../functions/src/qualifyHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleQualifyHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (args) => qualifyCall(getDb(), { ...args, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
