// Enregistrement des réponses au formulaire de qualification d'un lead — fonction Netlify.
//
//   POST https://<site>/api/lead-qualification       (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase de l'utilisateur>
//   Corps   : { leadId, requestId, answers }
//
// Les réponses sont contrôlées contre le formulaire PUBLIÉ du produit (functions/src/qualificationForm.ts). Même clé
// Firebase que les autres fonctions ; l'identité vient du jeton, le rôle de users/{uid}.

import { handleQualificationHttp } from '../../functions/src/qualificationFormHttp';
import { saveQualificationAnswers } from '../../functions/src/qualificationForm';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handleQualificationHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (args) => saveQualificationAnswers(getDb(), { ...args, nowMs: Date.now() }),
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
