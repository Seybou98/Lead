import { describe, expect, it } from 'vitest';
import {
  channelLink,
  coerceMessagesInput,
  defaultTemplates,
  parseMessageTemplates,
  pickTemplate,
  renderTemplate,
  renderText,
  signatureOf,
  templateId,
  triggersFor,
  unknownVariables,
  validateMessages,
  type MessageContext,
  type MessageTemplate,
} from './templates';

const ctx: MessageContext = { prenom: 'Awa', nom: 'Diallo', produit: 'PAC', telepro: 'Sarah Cohen', pieces: ['Pièce d’identité (illisible)', 'Avis d’imposition'] };
const tpl = (over: Partial<MessageTemplate> = {}): MessageTemplate => ({ id: 'x', trigger: 'documents_partial', channel: 'sms', product: '', subject: '', body: 'Bonjour {{prenom}}, il manque :\n{{pieces}}', active: true, ...over });

describe('modèles d’origine', () => {
  it('quatre déclencheurs × trois canaux, valides, un identifiant par combinaison', () => {
    const d = defaultTemplates();
    expect(d).toHaveLength(12);
    expect(new Set(d.map((t) => t.id)).size).toBe(12);
    expect(validateMessages(d)).toEqual([]);
    expect(d.filter((t) => t.channel === 'email').every((t) => t.subject.length > 3)).toBe(true);
  });
  it('sans enregistrement ou document illisible : les modèles d’origine', () => {
    expect(parseMessageTemplates(undefined)).toHaveLength(12);
    expect(parseMessageTemplates({ templates: 'x' })).toHaveLength(12);
  });
  it('un enregistrement remplace les modèles d’origine (une liste vide est permise)', () => {
    expect(parseMessageTemplates({ templates: [] })).toEqual([]);
    const one = parseMessageTemplates({ templates: [tpl({ trigger: 'offer_sent', channel: 'email', subject: 'Offre', body: 'Bonjour' }), { trigger: 'nope', channel: 'sms' }] });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe('offer_sent__email__all');
  });
});

describe('validation', () => {
  it('variable inconnue, message vide, objet absent, trop long, doublon', () => {
    expect(validateMessages([tpl({ body: 'Bonjour {{prenon}} {{pieces}}' })]).join(' ')).toContain('{{prenon}}');
    expect(validateMessages([tpl({ body: ' ' })]).join(' ')).toContain('vide');
    expect(validateMessages([tpl({ channel: 'email', subject: '', body: 'Bonjour {{pieces}}' })]).join(' ')).toContain('objet est obligatoire');
    expect(validateMessages([tpl({ body: `{{pieces}} ${'a'.repeat(500)}` })]).join(' ')).toContain('480 caractères');
    expect(validateMessages([tpl({ id: templateId('documents_partial', 'sms', '') }), tpl({ id: templateId('documents_partial', 'sms', '') })]).join(' ')).toContain('en double');
  });
  it('un message de relance documentaire doit citer {{pieces}} (sauf modèle désactivé)', () => {
    expect(validateMessages([tpl({ body: 'Bonjour {{prenom}}, merci de nous renvoyer vos documents.' })]).join(' ')).toContain('{{pieces}}');
    expect(validateMessages([tpl({ body: 'Bonjour', active: false })])).toEqual([]);
    expect(validateMessages([tpl({ trigger: 'offer_sent', body: 'Bonjour {{prenom}}, votre offre.' })])).toEqual([]);
  });
  it('saisie de l’écran : l’identifiant suit le déclencheur, le canal et le produit', () => {
    const [t] = coerceMessagesInput({ templates: [{ trigger: 'offer_sent', channel: 'sms', product: ' PAC AIR/EAU ', body: 'x', active: true }] });
    expect(t.id).toBe('offer_sent__sms__pac_air_eau');
    expect(t.product).toBe('PAC AIR/EAU');
  });
  it('variables inconnues d’un texte', () => expect(unknownVariables('{{prenom}} {{ foo }} {{foo}} {{bar}}').sort()).toEqual(['bar', 'foo']));
});

describe('choix du modèle', () => {
  const list = [tpl({ id: 'a', product: '' }), tpl({ id: 'b', product: 'PAC', body: 'PAC {{pieces}}' }), tpl({ id: 'c', channel: 'email', subject: 's', body: 'e {{pieces}}' })];
  it('le modèle du produit l’emporte, sinon le général', () => {
    expect(pickTemplate(list, 'documents_partial', 'sms', 'PAC')?.body).toBe('PAC {{pieces}}');
    expect(pickTemplate(list, 'documents_partial', 'sms', 'SSC')?.product).toBe('');
    expect(pickTemplate(list, 'documents_partial', 'sms', null)?.product).toBe('');
  });
  it('modèle désactivé ou absent : aucun', () => {
    expect(pickTemplate([tpl({ active: false })], 'documents_partial', 'sms', null)).toBeNull();
    expect(pickTemplate(list, 'offer_sent', 'sms', null)).toBeNull();
  });
  it('un produit désactivé laisse le général', () => {
    expect(pickTemplate([tpl({ id: 'a' }), tpl({ id: 'b', product: 'PAC', active: false })], 'documents_partial', 'sms', 'PAC')?.product).toBe('');
  });
});

describe('rendu', () => {
  it('variables remplacées, pièces en liste, signature avec l’identité du télépro', () => {
    const r = renderTemplate({ subject: 'Dossier {{produit}}', body: 'Bonjour {{prenom}},\n{{pieces}}\n\n{{signature}}' }, ctx);
    expect(r.subject).toBe('Dossier PAC');
    expect(r.body).toBe('Bonjour Awa,\n- Pièce d’identité (illisible)\n- Avis d’imposition\n\nCordialement,\nSarah Cohen\nLabel Énergie');
  });
  it('données absentes : formule neutre, jamais « undefined » ni variable brute', () => {
    const r = renderText('Bonjour {{prenom}}, votre {{produit}} {{nom}}', { prenom: '', nom: '', produit: '', telepro: '', pieces: [] });
    expect(r).toBe('Bonjour Madame, Monsieur, votre votre projet');
    expect(signatureOf('')).toBe('Cordialement,\nLabel Énergie');
  });
  it('variable inconnue laissée telle quelle (la validation l’interdit à l’enregistrement)', () => {
    expect(renderText('{{zzz}}', ctx)).toBe('{{zzz}}');
  });
  it('les modèles d’origine se rendent sans variable restante', () => {
    for (const t of defaultTemplates()) {
      const r = renderTemplate(t, ctx);
      expect(`${r.subject}${r.body}`).not.toMatch(/\{\{/);
    }
  });
});

describe('déclencheurs d’un lead', () => {
  it('documents demandés, partiels, offre envoyée, financement incomplet', () => {
    expect(triggersFor({ status: 'awaiting_documents', documentsState: 'requested' })).toEqual(['documents_requested']);
    expect(triggersFor({ status: 'awaiting_documents', documentsState: 'partial' })).toEqual(['documents_partial']);
    expect(triggersFor({ status: 'missing_info', documentsState: 'incomplete_non_conform' })).toEqual(['documents_partial']);
    expect(triggersFor({ status: 'converted', documentsState: 'complete', commercialState: 'offer_sent' })).toEqual(['offer_sent']);
    expect(triggersFor({ status: 'converted', documentsState: 'complete', commercialState: 'signed', financialState: 'financing_in_progress' })).toEqual(['financing_incomplete']);
  });
  it('rien à envoyer : lead neuf, dossier complet, vente annulée', () => {
    expect(triggersFor({ status: 'new', documentsState: 'none' })).toEqual([]);
    expect(triggersFor({ status: 'file_ready_to_build', documentsState: 'complete' })).toEqual([]);
    expect(triggersFor({ status: 'converted', documentsState: 'complete', commercialState: 'cancelled', financialState: 'financing_in_progress' })).toEqual([]);
  });
});

describe('ouverture du canal', () => {
  const msg = { subject: 'Objet & co', body: 'Bonjour\nà vous' };
  it('email : mailto encodé ; sans adresse : null', () => {
    expect(channelLink('email', { email: 'a@b.fr', phone: null }, msg)).toBe('mailto:a%40b.fr?subject=Objet%20%26%20co&body=Bonjour%0A%C3%A0%20vous');
    expect(channelLink('email', { email: null, phone: '0612345678' }, msg)).toBeNull();
  });
  it('SMS : numéro nettoyé ; sans téléphone : null', () => {
    expect(channelLink('sms', { email: null, phone: '06 12 34 56 78' }, msg)).toMatch(/^sms:0612345678\?body=/);
    expect(channelLink('sms', { email: 'a@b.fr', phone: null }, msg)).toBeNull();
  });
  it('WhatsApp : indicatif international, sans « + »', () => {
    expect(channelLink('whatsapp', { email: null, phone: '06 12 34 56 78' }, msg)).toMatch(/^https:\/\/wa\.me\/33612345678\?text=/);
    expect(channelLink('whatsapp', { email: null, phone: '+33612345678' }, msg)).toMatch(/wa\.me\/33612345678/);
    expect(channelLink('whatsapp', { email: null, phone: '0033612345678' }, msg)).toMatch(/wa\.me\/33612345678/);
  });
});
