// Dépendances communes aux deux fonctions des exports programmés (exécution planifiée, historique et téléchargement).

import type { RunnerDeps } from '../../functions/src/exportRunner';
import { emailJsSender, mailerConfigFromEnv, missingMailerVars } from '../../functions/src/mailer';
import { getExportStorage } from './admin';

/** Adresse publique du CRM, sans barre finale : SITE_URL si renseignée, sinon l'adresse principale que Netlify fournit (URL). */
export const siteUrlFromEnv = (env: Record<string, string | undefined>): string => (env.SITE_URL?.trim() || env.URL?.trim() || '').replace(/\/+$/, '');

export async function runnerDeps(): Promise<RunnerDeps> {
  const env = process.env as Record<string, string | undefined>;
  const cfg = mailerConfigFromEnv(env);
  return {
    storage: await getExportStorage(),
    send: cfg ? emailJsSender(cfg) : null,
    missingVars: missingMailerVars(env),
    siteUrl: siteUrlFromEnv(env),
    log: { warn: (m, meta) => console.warn(m, meta ?? ''), error: (m, meta) => console.error(m, meta ?? '') },
  };
}
