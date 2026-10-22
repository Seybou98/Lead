// Hub d'intégrations (journal des échanges, reprise d'un lead refusé) — fonction Netlify, administrateur seulement.
//
//   POST https://<site>/api/integrations-hub         (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase de l'administrateur>
//   Corps   : { action: 'journal' }  |  { action: 'replay', rawLeadId, overrides?: { phone?, email? } }  |  { action: 'test' }  (administrateur)
//             { action: 'errors' }  (administrateur : toutes les transmissions en échec ; manager : celles de son équipe)
//
// Même clé Firebase que les autres fonctions ; l'identité vient du jeton, le rôle de users/{uid}. Les charges utiles
// renvoyées ont leurs secrets masqués.

import { readJournal, readTransmissionErrors, replayRawLead, testMainCrm } from '../../functions/src/integrationsHub';
import { handleHubHttp } from '../../functions/src/integrationsHubHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleHubHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      journal: () => readJournal(getDb(), Date.now()),
      replay: (args) => replayRawLead(getDb(), { ...args, nowMs: Date.now() }),
      errors: (uid, role) => readTransmissionErrors(getDb(), uid, role),
      test: () => testMainCrm(getDb()),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
