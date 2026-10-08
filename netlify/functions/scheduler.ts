// Planificateur du CRM Leads (§15.1) — fonction Netlify PLANIFIÉE : toutes les 5 minutes, sans navigateur ouvert.
//
//   Planification : netlify.toml, section [functions."scheduler"] (schedule = "*/5 * * * *").
//   Fait : escalades vers les managers, entrée en recyclage / archivage, attribution des leads de la file tampon
//   quand une capacité compatible réapparaît. Logique : src/domain/scheduler/plan.ts et functions/src/scheduler.ts.
//
// Aucune donnée n'est lue dans la requête : un appel direct ne peut rien faire d'autre que relancer ce même
// traitement, qui est idempotent. Le déclenchement manuel par un administrateur passe par scheduler-run.ts.

import { runScheduler } from '../../functions/src/scheduler';
import { getDb, jsonResponse, type NetlifyResponse } from '../lib/admin';

export const handler = async (): Promise<NetlifyResponse> => {
  try {
    const report = await runScheduler(getDb(), Date.now());
    console.log('scheduler', JSON.stringify(report));
    return jsonResponse(200, { ok: true, report });
  } catch (err) {
    console.error('scheduler : erreur interne', err);
    return jsonResponse(500, { ok: false, error: 'internal' });
  }
};
