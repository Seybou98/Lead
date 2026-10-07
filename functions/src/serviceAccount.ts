// Lecture du compte de service Firebase depuis les variables d'environnement (hébergement Netlify).
// Mêmes noms de variables que les fonctions Netlify du CRM principal et de l'ancien CRM : la clé déjà
// configurée sur un site Netlify peut être reprise telle quelle.

export interface ServiceAccountLike {
  project_id: string;
  client_email: string;
  private_key: string;
  [k: string]: unknown;
}

function fix(raw: string): ServiceAccountLike {
  const svc = JSON.parse(raw) as ServiceAccountLike;
  // Les variables d'environnement transportent souvent la clé avec des « \n » littéraux.
  if (typeof svc.private_key === 'string' && svc.private_key.includes('\\n')) {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  if (!svc.project_id) throw new Error('Le compte de service doit contenir "project_id".');
  if (!svc.client_email || !svc.private_key) throw new Error('Le compte de service doit contenir "client_email" et "private_key".');
  return svc;
}

/**
 * Préférence : FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (le JSON encodé en base64, sans guillemets à
 * échapper), sinon FIREBASE_SERVICE_ACCOUNT_JSON (le JSON brut). Ne journalise jamais la clé.
 */
export function parseServiceAccount(env: Record<string, string | undefined>): ServiceAccountLike {
  const b64 = env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();

  if (b64) {
    try {
      // Erreur fréquente : coller le JSON brut dans la variable « _BASE64 ». Le JSON commence toujours
      // par « { » alors qu'un base64 n'en contient jamais : on le reconnaît sans ambiguïté.
      const json = b64.startsWith('{') ? b64 : Buffer.from(b64, 'base64').toString('utf8');
      return fix(json);
    } catch (e) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 illisible : ${(e as Error).message}`);
    }
  }
  if (raw) {
    try {
      // Quelqu'un colle parfois du base64 dans la variable « JSON » : on l'accepte.
      const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      return fix(json);
    } catch (e) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON illisible : ${(e as Error).message}`);
    }
  }
  throw new Error('Variable manquante : FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (recommandée) ou FIREBASE_SERVICE_ACCOUNT_JSON.');
}
