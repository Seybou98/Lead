// Statut opérationnel du télépro (menu Disponible / Pause de Ma journée) — fonction Netlify.
//
//   POST https://<site>/api/set-status             (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase>
//   Corps   : { status: 'available' | 'paused' | 'doc_followup' | 'file_building' | 'on_call' }
//
// Même clé Firebase que les autres fonctions. Logique : functions/src/status.ts, statusHttp.ts et
// src/domain/availability/status.ts.

import { setOwnStatus } from '../../functions/src/status';
import { handleStatusHttp } from '../../functions/src/statusHttp';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleStatusHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      run: ({ uid, requested }) => setOwnStatus(getDb(), { uid, requested, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
