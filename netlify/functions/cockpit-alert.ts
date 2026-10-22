// Clôture ou report d'une alerte du cockpit manager — fonction Netlify.
//
//   POST https://<site>/api/cockpit-alert            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase du manager ou de l'administrateur>
//   Corps   : { leadId, alertKey, sinceMs, requestId, action: 'close', reasonCode, comment }
//           | { …, action: 'postpone', choice: '30m' | '2h' | '1d', comment? } | { …, action: 'reopen' }
//
// L'identité vient du jeton, le rôle de users/{uid}. Logique dans functions/src (cockpitAlert.ts, cockpitAlertHttp.ts).

import { applyAlertAction } from '../../functions/src/cockpitAlert';
import { handleAlertHttp } from '../../functions/src/cockpitAlertHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleAlertHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (args) => applyAlertAction(getDb(), { ...args, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
