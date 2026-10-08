// Réattribution manuelle d'un lead (cockpit manager) — fonction Netlify.
//
//   POST https://<site>/api/reassign-lead            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase du manager ou de l'administrateur>
//   Corps   : { leadId, targetUid, requestId, reason }
//
// Même clé Firebase que les autres fonctions. L'identité vient du jeton, le rôle de users/{uid}. Logique dans
// functions/src (reassign.ts, reassignHttp.ts) et src/domain/leads/reassign.ts.

import { reassignLead } from '../../functions/src/reassign';
import { handleReassignHttp } from '../../functions/src/reassignHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleReassignHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (args) => reassignLead(getDb(), { ...args, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
