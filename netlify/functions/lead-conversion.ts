// Montage du dossier et création de la vente (brouillon, validation manager, vente) — fonction Netlify.
//
//   POST https://<site>/api/lead-conversion            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase de l'utilisateur connecté>
//   Corps   : { leadId, requestId, input: { kind: 'save_draft' | 'request_validation' | 'decide' | 'create_sale' | 'transmit', ... } }
//
// Même clé Firebase que les autres fonctions. Aucun secret partagé : l'identité vient du jeton, le rôle de
// users/{uid}. Logique dans functions/src (conversion.ts, conversionHttp.ts) et src/domain/conversion/plan.ts.

import { runConversionRequest } from '../../functions/src/conversionRun';
import { handleConversionHttp } from '../../functions/src/conversionHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, getStorageAdapter, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleConversionHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: async (args) => runConversionRequest(getDb(), await getStorageAdapter(), args),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
