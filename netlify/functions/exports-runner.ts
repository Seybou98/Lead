// Rapports programmés (§22.10) — fonction Netlify PLANIFIÉE : toutes les 5 minutes, sans navigateur ouvert.
//
//   Planification : netlify.toml, section [functions."exports-runner"] (schedule = "*/5 * * * *").
//   Fait : génère les rapports dont l'échéance est passée (fichiers dans Firebase Storage), envoie le lien par EmailJS,
//   retente les envois en échec, supprime les fichiers de plus de 30 jours. Logique : functions/src/exportRunner.ts.
//
// Aucune donnée n'est lue dans la requête : un appel direct ne peut rien faire d'autre que relancer ce même traitement,
// qui est idempotent (une exécution par rapport et par échéance).

import { runDueExports } from '../../functions/src/exportRunner';
import { getDb, jsonResponse, type NetlifyResponse } from '../lib/admin';
import { runnerDeps } from '../lib/exportDeps';

export const handler = async (): Promise<NetlifyResponse> => {
  try {
    const report = await runDueExports(getDb(), Date.now(), await runnerDeps());
    console.log('exports-runner', JSON.stringify(report));
    return jsonResponse(200, { ok: true, report });
  } catch (err) {
    console.error('exports-runner : erreur interne', err);
    return jsonResponse(500, { ok: false, error: 'internal' });
  }
};
