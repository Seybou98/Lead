// Rapports programmés : historique, exécution manuelle, renvoi, téléchargement — fonction Netlify.
//
//   POST https://<site>/api/exports-hub              (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase>
//   Corps   : { action: 'runs' } | { action: 'download', runId, file? } | { action: 'run', scheduleId } | { action: 'resend', runId }
//
// Administrateur et managers : historique et téléchargement (un manager ne voit que les fichiers qui lui sont destinés).
// Administrateur seul : exécuter maintenant, renvoyer. L'identité vient du jeton, le rôle de users/{uid}.

import { listRuns, readDownload, resendRun, runNow } from '../../functions/src/exportRunner';
import { handleExportsHttp } from '../../functions/src/exportsHubHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';
import { runnerDeps } from '../lib/exportDeps';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
  const db = getDb();
  const deps = await runnerDeps();

  const out = await handleExportsHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      runs: (role, uid) => listRuns(db, role, uid),
      runNow: (scheduleId, uid) => runNow(db, scheduleId, uid, Date.now(), deps),
      resend: (runId) => resendRun(db, runId, deps, Date.now()),
      download: (args) => readDownload(db, args, deps),
      log: deps.log ?? { warn: () => undefined, error: () => undefined },
    }
  );
  return jsonResponse(out.status, out.body);
};
