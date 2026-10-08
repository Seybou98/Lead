// Workflow documentaire d'un lead (réception, contrôle, relance, décision, montage) — fonction Netlify.
//
//   POST https://<site>/api/lead-documents            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase de l'utilisateur connecté>
//   Corps   : { leadId, requestId, input: { kind: 'receive' | 'check' | 'reask' | 'follow_up' | 'decide' | 'start_building', ... } }
//
// Même clé Firebase que les autres fonctions. Aucun secret partagé : l'identité vient du jeton, le rôle de
// users/{uid}. Logique dans functions/src (documents.ts, documentsHttp.ts) et src/domain/documents/plan.ts.

import { applyDocumentAction } from '../../functions/src/documents';
import { handleDocumentsHttp } from '../../functions/src/documentsHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleDocumentsHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (args) => applyDocumentAction(getDb(), { ...args, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
