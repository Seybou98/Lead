// Absences et transferts de portefeuille (fiche télépro, figs. 22 à 24) — fonction Netlify.
//
//   POST https://<site>/api/portfolio            (redirection définie dans netlify.toml)
//   En-tête : Authorization: Bearer <jeton d'identité Firebase d'un manager ou d'un administrateur>
//   Corps   : { kind: 'declare_absence', userId, requestId, input }
//           | { kind: 'end_absence', absenceId }
//           | { kind: 'transfer', fromUid, batchId, assignments: [{ leadId, targetUid }], reason, returnAtMs }
//
// Même clé Firebase que les autres fonctions. L'identité vient du jeton, le rôle de users/{uid}. Logique dans
// functions/src (portfolio.ts, portfolioHttp.ts) et src/domain/portfolio.

import { declareAbsence, endAbsence, transferLeads } from '../../functions/src/portfolio';
import { handlePortfolioHttp } from '../../functions/src/portfolioHttp';
import { resolveLeadRole } from '../../src/config/roles';
import { getAdminAuth, getDb, jsonResponse, type NetlifyEvent, type NetlifyResponse } from '../lib/admin';

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  const out = await handlePortfolioHttp(
    { method: event.httpMethod, authorization: event.headers['authorization'], rawBody },
    {
      verifyToken: async (token) => (await getAdminAuth().verifyIdToken(token)).uid,
      resolveRole: async (uid) => {
        const snap = await getDb().collection('users').doc(uid).get();
        if (!snap.exists || String(snap.get('status') ?? '').toLowerCase() !== 'active') return null;
        return resolveLeadRole(snap.get('role'));
      },
      run: (r) => {
        const nowMs = Date.now();
        if (r.kind === 'declare_absence') return declareAbsence(getDb(), { uid: r.uid, role: r.role, userId: r.userId, requestId: r.requestId, input: r.input as never, nowMs });
        if (r.kind === 'end_absence') return endAbsence(getDb(), { uid: r.uid, role: r.role, absenceId: r.absenceId, nowMs });
        return transferLeads(getDb(), { uid: r.uid, role: r.role, fromUid: r.fromUid, batchId: r.batchId, assignments: r.assignments as never, reason: r.reason, returnAtMs: r.returnAtMs, nowMs });
      },
      log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
    }
  );
  return jsonResponse(out.status, out.body);
};
