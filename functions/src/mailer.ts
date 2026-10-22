// Envoi d'email par EmailJS (API REST), pour les rapports programmés. Le message ne contient JAMAIS le fichier : seulement un
// lien vers le CRM (la connexion et les droits sont vérifiés au téléchargement).
//
// Configuration côté serveur uniquement (variables d'environnement Netlify) :
//   EMAILJS_SERVICE_ID  (repli : VITE_EMAILJS_SERVICE)    identifiant du service d'envoi
//   EMAILJS_TEMPLATE_ID (repli : VITE_EMAILJS_TEMPLATE)   identifiant du modèle
//   EMAILJS_PUBLIC_KEY  (repli : VITE_EMAILJS_USER)       clé publique du compte
//   EMAILJS_PRIVATE_KEY                                    clé privée (jamais dans le dépôt ni dans le navigateur)
// Côté compte EmailJS : « Autoriser l'API pour les applications non navigateur » doit être activé, et le champ « To Email » du
// modèle doit valoir {{to_email}}.

export interface MailerConfig {
  serviceId: string;
  templateId: string;
  publicKey: string;
  privateKey: string;
}

export type MailResult = { ok: true } | { ok: false; error: string };
export type MailSender = (params: Record<string, string>) => Promise<MailResult>;

export const EMAILJS_URL = 'https://api.emailjs.com/api/v1.0/email/send';

/** Lit la configuration ; null si une variable manque (l'envoi est alors signalé en erreur, jamais ignoré en silence). */
export function mailerConfigFromEnv(env: Record<string, string | undefined>): MailerConfig | null {
  const pick = (...names: string[]): string => names.map((n) => env[n]?.trim() ?? '').find((v) => v !== '') ?? '';
  const cfg: MailerConfig = {
    serviceId: pick('EMAILJS_SERVICE_ID', 'VITE_EMAILJS_SERVICE'),
    templateId: pick('EMAILJS_TEMPLATE_ID', 'VITE_EMAILJS_TEMPLATE'),
    publicKey: pick('EMAILJS_PUBLIC_KEY', 'VITE_EMAILJS_USER'),
    privateKey: pick('EMAILJS_PRIVATE_KEY'),
  };
  return cfg.serviceId && cfg.templateId && cfg.publicKey && cfg.privateKey ? cfg : null;
}

/** Variables absentes, pour un message d'erreur utile à l'administrateur (sans jamais citer de valeur). */
export function missingMailerVars(env: Record<string, string | undefined>): string[] {
  const has = (...names: string[]) => names.some((n) => (env[n]?.trim() ?? '') !== '');
  return [
    has('EMAILJS_SERVICE_ID', 'VITE_EMAILJS_SERVICE') ? '' : 'EMAILJS_SERVICE_ID',
    has('EMAILJS_TEMPLATE_ID', 'VITE_EMAILJS_TEMPLATE') ? '' : 'EMAILJS_TEMPLATE_ID',
    has('EMAILJS_PUBLIC_KEY', 'VITE_EMAILJS_USER') ? '' : 'EMAILJS_PUBLIC_KEY',
    has('EMAILJS_PRIVATE_KEY') ? '' : 'EMAILJS_PRIVATE_KEY',
  ].filter(Boolean);
}

/** Message d'erreur sans fuite : le texte renvoyé par EmailJS est court, la clé n'y figure jamais, mais on le borne. */
const clip = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200);

export function emailJsSender(cfg: MailerConfig, fetchImpl: typeof fetch = fetch): MailSender {
  return async (params) => {
    try {
      const res = await fetchImpl(EMAILJS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: cfg.serviceId, template_id: cfg.templateId, user_id: cfg.publicKey, accessToken: cfg.privateKey, template_params: params }),
      });
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      return { ok: false, error: `EmailJS ${res.status}${text ? ` : ${clip(text)}` : ''}` };
    } catch (e) {
      return { ok: false, error: `EmailJS injoignable : ${clip(e instanceof Error ? e.message : String(e))}` };
    }
  };
}
