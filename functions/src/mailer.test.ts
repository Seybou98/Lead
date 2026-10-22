import { describe, expect, it, vi } from 'vitest';
import { EMAILJS_URL, emailJsSender, mailerConfigFromEnv, missingMailerVars } from './mailer';

const ENV = { EMAILJS_SERVICE_ID: 'svc', EMAILJS_TEMPLATE_ID: 'tpl', EMAILJS_PUBLIC_KEY: 'pub', EMAILJS_PRIVATE_KEY: 'priv' };
const CFG = { serviceId: 'svc', templateId: 'tpl', publicKey: 'pub', privateKey: 'priv' };

describe('mailerConfigFromEnv', () => {
  it('lit les variables serveur', () => {
    expect(mailerConfigFromEnv(ENV)).toEqual(CFG);
  });
  it('repli sur les noms VITE_EMAILJS_* déjà renseignés pour le navigateur', () => {
    expect(mailerConfigFromEnv({ VITE_EMAILJS_SERVICE: 'svc', VITE_EMAILJS_TEMPLATE: 'tpl', VITE_EMAILJS_USER: 'pub', EMAILJS_PRIVATE_KEY: 'priv' })).toEqual(CFG);
  });
  it('une variable serveur l’emporte sur le repli', () => {
    expect(mailerConfigFromEnv({ ...ENV, VITE_EMAILJS_SERVICE: 'autre' })?.serviceId).toBe('svc');
  });
  it('clé privée absente (ou vide) : pas de configuration, jamais d’envoi à moitié configuré', () => {
    expect(mailerConfigFromEnv({ ...ENV, EMAILJS_PRIVATE_KEY: '  ' })).toBeNull();
    expect(mailerConfigFromEnv({})).toBeNull();
  });
  it('liste les variables manquantes sans jamais citer de valeur', () => {
    expect(missingMailerVars({ EMAILJS_SERVICE_ID: 'svc' })).toEqual(['EMAILJS_TEMPLATE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY']);
    expect(missingMailerVars(ENV)).toEqual([]);
  });
});

describe('emailJsSender', () => {
  it('envoie les identifiants, la clé privée en accessToken et les paramètres du modèle', async () => {
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    const res = await emailJsSender(CFG, fetchMock as never)({ to_email: 'a@b.fr', link: 'https://crm/x' });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(EMAILJS_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ service_id: 'svc', template_id: 'tpl', user_id: 'pub', accessToken: 'priv', template_params: { to_email: 'a@b.fr', link: 'https://crm/x' } });
  });
  it('refus d’EmailJS : erreur lisible avec le code, texte borné', async () => {
    const fetchMock = vi.fn(async () => new Response('x'.repeat(500), { status: 403 }));
    const res = await emailJsSender(CFG, fetchMock as never)({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error).toMatch(/^EmailJS 403 : x+$/);
    expect(res.error.length).toBeLessThan(230);
  });
  it('réseau coupé : erreur, jamais d’exception', async () => {
    const res = await emailJsSender(CFG, (async () => { throw new Error('ECONNRESET'); }) as never)({});
    expect(res).toEqual({ ok: false, error: 'EmailJS injoignable : ECONNRESET' });
  });
  it('la clé privée ne figure dans aucun message d’erreur', async () => {
    const res = await emailJsSender(CFG, (async () => new Response('bad', { status: 400 })) as never)({});
    expect(JSON.stringify(res)).not.toContain('priv');
  });
});
