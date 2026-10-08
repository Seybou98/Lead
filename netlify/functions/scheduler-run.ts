// Déclenchement MANUEL du planificateur par un administrateur (Paramètres) — fonction Netlify.
//
//   POST https://<site>/api/scheduler-run            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase d'un administrateur>
//
// Sert à vérifier le planificateur sans attendre la prochaine échéance, et en développement, où aucune
// planification n'existe. Même traitement que scheduler.ts (idempotent).

import { runScheduler } from '../../functions/src/scheduler';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, getStorageAdapter, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  const m = /^Bearer\s+(\S+)$/i.exec((event.headers['authorization'] ?? '').trim());
  if (!m) return jsonResponse(401, { ok: false, error: 'unauthorized' });

  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(m[1])).uid;
  } catch {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  try {
    const user = await getDb().collection('users').doc(uid).get();
    const active = user.exists && String(user.get('status') ?? '').toLowerCase() === 'active';
    if (!active || resolveLeadRole(user.get('role')) !== 'admin') {
      return jsonResponse(403, { ok: false, error: 'forbidden', message: 'Réservé aux administrateurs.' });
    }
    const report = await runScheduler(getDb(), Date.now(), { getStorage: getStorageAdapter });
    return jsonResponse(200, { ok: true, report });
  } catch (err) {
    console.error('scheduler-run : erreur interne', err);
    return jsonResponse(500, { ok: false, error: 'internal' });
  }
};
