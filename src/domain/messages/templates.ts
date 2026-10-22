// Communications personnalisées (§24.5) : modèles de message par déclencheur, canal et produit. Fonctions PURES, partagées
// par l'écran d'administration, l'écran Messages du télépro et les tests.
//
// Le CRM n'ENVOIE rien en V1 (pas de canal d'envoi, §1.2) : il PRÉPARE le message avec l'identité commerciale du télépro, le
// télépro l'envoie lui-même (copie, ou ouverture de sa messagerie / de son téléphone / de WhatsApp). L'envoi automatique et
// ses arrêts automatiques sont une évolution (Lot 6).
//
// Un modèle est versionné comme les autres réglages : chaque enregistrement laisse l'ancienne et la nouvelle valeur dans le
// journal d'audit (Paramètres → Versions & publication).

import { LEAD_STATUS_LABELS } from '../labels';

export const MESSAGE_TRIGGERS = ['documents_requested', 'documents_partial', 'offer_sent', 'financing_incomplete'] as const;
export type MessageTrigger = (typeof MESSAGE_TRIGGERS)[number];

export const TRIGGER_INFO: Record<MessageTrigger, { label: string; message: string; stop: string }> = {
  documents_requested: { label: 'Passage en attente de documents', message: 'Liste exacte des pièces, présentation de la société.', stop: 'À réception de toutes les pièces attendues.' },
  documents_partial: { label: 'Dossier partiel', message: 'Uniquement les documents manquants ou non conformes.', stop: 'Dès réception ou validation des pièces ciblées.' },
  offer_sent: { label: 'Offre envoyée', message: 'Rappel de l’offre avec les coordonnées du télépro.', stop: 'À la signature, au refus ou au remplacement.' },
  financing_incomplete: { label: 'Financement incomplet', message: 'Reprise du parcours partenaire et aide proposée.', stop: 'À la soumission, acceptation, refus ou expiration.' },
};

export const MESSAGE_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export const CHANNEL_LABELS: Record<MessageChannel, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

/** Longueur maximale du corps : un SMS reste court, un email peut être détaillé. */
export const BODY_MAX: Record<MessageChannel, number> = { email: 3000, sms: 480, whatsapp: 1500 };
export const SUBJECT_MAX = 150;
export const MAX_TEMPLATES = 60;

export const VARIABLES = ['prenom', 'nom', 'produit', 'telepro', 'societe', 'pieces', 'signature'] as const;
export type MessageVariable = (typeof VARIABLES)[number];
export const VARIABLE_HELP: Record<MessageVariable, string> = {
  prenom: 'Prénom du client',
  nom: 'Nom du client',
  produit: 'Produit du projet',
  telepro: 'Nom du télépro propriétaire',
  societe: 'Nom de la société',
  pieces: 'Liste des pièces manquantes ou non conformes (une par ligne)',
  signature: 'Signature : télépro et société',
};

export interface MessageTemplate {
  /** `trigger__canal__produit` (produit « all » = tous) : une seule valeur par combinaison. */
  id: string;
  trigger: MessageTrigger;
  channel: MessageChannel;
  /** Produit visé ; vide = tous les produits. Un modèle propre à un produit l'emporte sur le modèle général. */
  product: string;
  subject: string;
  body: string;
  active: boolean;
}

export const SOCIETE = 'Label Énergie';

const productKey = (p: string): string => p.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'all';
export const templateId = (trigger: MessageTrigger, channel: MessageChannel, product: string): string => `${trigger}__${channel}__${productKey(product)}`;

const SIGN = '{{signature}}';
const DEFAULTS: Record<MessageTrigger, { subject: string; email: string; short: string }> = {
  documents_requested: {
    subject: 'Votre dossier {{produit}} : documents à nous transmettre',
    email: 'Bonjour {{prenom}},\n\nMerci pour votre intérêt pour votre projet {{produit}}. Pour avancer, nous avons besoin des documents suivants :\n{{pieces}}\n\nVous pouvez nous les renvoyer en répondant à ce message.\n\n' + SIGN,
    short: 'Bonjour {{prenom}}, {{telepro}} de {{societe}}. Pour votre projet {{produit}}, il nous faut :\n{{pieces}}\nVous pouvez nous les renvoyer ici. Merci !',
  },
  documents_partial: {
    subject: 'Votre dossier {{produit}} : il nous manque encore des documents',
    email: 'Bonjour {{prenom}},\n\nNous avons bien reçu une partie de vos documents, merci. Pour finaliser votre dossier, il nous manque encore :\n{{pieces}}\n\nVous pouvez nous les renvoyer en répondant à ce message.\n\n' + SIGN,
    short: 'Bonjour {{prenom}}, bien reçu pour une partie de vos documents. Il nous manque encore :\n{{pieces}}\nMerci ! {{telepro}}, {{societe}}',
  },
  offer_sent: {
    subject: 'Votre offre {{produit}}',
    email: 'Bonjour {{prenom}},\n\nNous vous avons transmis votre offre pour votre projet {{produit}}. Je reste à votre disposition pour toute question avant votre décision.\n\n' + SIGN,
    short: 'Bonjour {{prenom}}, votre offre {{produit}} vous a été transmise. Une question ? Je reste disponible. {{telepro}}, {{societe}}',
  },
  financing_incomplete: {
    subject: 'Votre financement {{produit}} : une étape reste à compléter',
    email: 'Bonjour {{prenom}},\n\nVotre demande de financement pour votre projet {{produit}} n’est pas encore complète. Je peux vous aider à la terminer : répondez-moi à ce message ou rappelez-moi.\n\n' + SIGN,
    short: 'Bonjour {{prenom}}, votre financement {{produit}} reste à compléter. Je peux vous aider à le terminer. {{telepro}}, {{societe}}',
  },
};

/** Modèles d'origine : quatre déclencheurs × trois canaux. Utilisés tant que rien n'est enregistré. */
export function defaultTemplates(): MessageTemplate[] {
  return MESSAGE_TRIGGERS.flatMap((trigger) =>
    MESSAGE_CHANNELS.map((channel): MessageTemplate => ({
      id: templateId(trigger, channel, ''),
      trigger,
      channel,
      product: '',
      subject: channel === 'email' ? DEFAULTS[trigger].subject : '',
      body: channel === 'email' ? DEFAULTS[trigger].email : DEFAULTS[trigger].short,
      active: true,
    }))
  );
}

// ── Lecture, saisie, validation ──────────────────────────────────────────────

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').slice(0, max) : '');

function templateFrom(raw: unknown): MessageTemplate | null {
  const x = rec(raw);
  const trigger = MESSAGE_TRIGGERS.find((t) => t === x.trigger);
  const channel = MESSAGE_CHANNELS.find((c) => c === x.channel);
  if (!trigger || !channel) return null;
  const product = str(x.product, 80).trim();
  return { id: templateId(trigger, channel, product), trigger, channel, product, subject: str(x.subject, SUBJECT_MAX), body: str(x.body, BODY_MAX[channel]), active: x.active !== false };
}

/** Lecture tolérante de `cl_settings/messages` ; sans enregistrement, les modèles d'origine. */
export function parseMessageTemplates(raw: unknown): MessageTemplate[] {
  const list = rec(raw).templates;
  if (!Array.isArray(list)) return defaultTemplates();
  const seen = new Set<string>();
  const out: MessageTemplate[] = [];
  for (const r of list) {
    const t = templateFrom(r);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.slice(0, MAX_TEMPLATES);
}

/** Saisie de l'écran : mêmes champs, rien n'est corrigé en silence (la validation dit ce qui ne va pas). */
export function coerceMessagesInput(raw: unknown): MessageTemplate[] {
  const list = rec(raw).templates;
  return (Array.isArray(list) ? list : []).map((r): MessageTemplate => {
    const x = rec(r);
    const trigger = x.trigger as MessageTrigger;
    const channel = x.channel as MessageChannel;
    const product = typeof x.product === 'string' ? x.product.trim() : '';
    return { id: templateId(trigger, channel, product), trigger, channel, product, subject: typeof x.subject === 'string' ? x.subject.replace(/\r\n/g, '\n') : '', body: typeof x.body === 'string' ? x.body.replace(/\r\n/g, '\n') : '', active: x.active === true };
  });
}

const VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Variables inconnues d'un texte (une faute de frappe afficherait « {{prenon}} » au client). */
export function unknownVariables(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(VAR)) if (!(VARIABLES as readonly string[]).includes(m[1])) bad.add(m[1]);
  return [...bad];
}

export function validateMessages(list: readonly MessageTemplate[]): string[] {
  const e: string[] = [];
  if (list.length > MAX_TEMPLATES) e.push(`${MAX_TEMPLATES} modèles au plus.`);
  const ids = new Set<string>();
  for (const t of list) {
    const name = `${TRIGGER_INFO[t.trigger]?.label ?? 'Modèle'} · ${CHANNEL_LABELS[t.channel] ?? ''}${t.product ? ` · ${t.product}` : ''}`;
    if (!MESSAGE_TRIGGERS.includes(t.trigger) || !MESSAGE_CHANNELS.includes(t.channel)) {
      e.push('Un modèle a un déclencheur ou un canal inconnu.');
      continue;
    }
    if (ids.has(t.id)) e.push(`${name} : modèle en double (même déclencheur, canal et produit).`);
    ids.add(t.id);
    if (t.product.length > 80) e.push(`${name} : produit trop long.`);
    if (t.body.trim().length < 5) e.push(`${name} : le message est vide.`);
    if (t.body.length > BODY_MAX[t.channel]) e.push(`${name} : ${BODY_MAX[t.channel]} caractères au plus pour ${CHANNEL_LABELS[t.channel]}.`);
    if (t.channel === 'email') {
      if (t.subject.trim().length < 3) e.push(`${name} : l’objet est obligatoire.`);
      if (t.subject.length > SUBJECT_MAX) e.push(`${name} : objet de ${SUBJECT_MAX} caractères au plus.`);
    }
    const bad = unknownVariables(`${t.subject}\n${t.body}`);
    if (bad.length > 0) e.push(`${name} : variable inconnue ${bad.map((b) => `{{${b}}}`).join(', ')}.`);
    if ((t.trigger === 'documents_requested' || t.trigger === 'documents_partial') && t.active && !/\{\{\s*pieces\s*\}\}/.test(t.body)) e.push(`${name} : le message doit citer {{pieces}} (la liste exacte des documents).`);
  }
  return e;
}

export const toStoredMessages = (list: readonly MessageTemplate[]): { templates: MessageTemplate[] } => ({ templates: list.map((t) => ({ ...t })) });

// ── Choix et rendu ───────────────────────────────────────────────────────────

/** Modèle actif le plus précis : celui du produit s'il existe, sinon le modèle général. */
export function pickTemplate(list: readonly MessageTemplate[], trigger: MessageTrigger, channel: MessageChannel, product: string | null): MessageTemplate | null {
  const mine = list.filter((t) => t.active && t.trigger === trigger && t.channel === channel);
  const key = product ? productKey(product) : null;
  return (key ? mine.find((t) => t.product && productKey(t.product) === key) : undefined) ?? mine.find((t) => t.product === '') ?? null;
}

export interface MessageContext {
  prenom: string;
  nom: string;
  produit: string;
  telepro: string;
  /** Une ligne par pièce (sans tiret) : le rendu ajoute les tirets. */
  pieces: readonly string[];
}

export function signatureOf(telepro: string): string {
  return [telepro ? `Cordialement,\n${telepro}` : 'Cordialement,', SOCIETE].join('\n');
}

export function renderText(text: string, ctx: MessageContext): string {
  const values: Record<MessageVariable, string> = {
    prenom: ctx.prenom.trim() || 'Madame, Monsieur',
    nom: ctx.nom.trim(),
    produit: ctx.produit.trim() || 'votre projet',
    telepro: ctx.telepro.trim(),
    societe: SOCIETE,
    pieces: ctx.pieces.map((p) => `- ${p}`).join('\n'),
    signature: signatureOf(ctx.telepro.trim()),
  };
  return text.replace(VAR, (m, name: string) => ((VARIABLES as readonly string[]).includes(name) ? values[name as MessageVariable] : m)).replace(/\n{3,}/g, '\n\n').trim();
}

export function renderTemplate(t: Pick<MessageTemplate, 'subject' | 'body'>, ctx: MessageContext): { subject: string; body: string } {
  return { subject: renderText(t.subject, ctx), body: renderText(t.body, ctx) };
}

// ── Quel message pour quel lead ──────────────────────────────────────────────

export interface LeadMessageInput {
  status: string;
  documentsState: string;
  commercialState?: string | null;
  financialState?: string | null;
}

/** Déclencheurs qui s'appliquent à un lead dans son état actuel (§24.5), du plus urgent au moins urgent. */
export function triggersFor(l: LeadMessageInput): MessageTrigger[] {
  const out: MessageTrigger[] = [];
  if (l.documentsState === 'requested' && ['awaiting_documents', 'missing_info'].includes(l.status)) out.push('documents_requested');
  if (['partial', 'received_to_check', 'incomplete_non_conform'].includes(l.documentsState) && ['awaiting_documents', 'missing_info'].includes(l.status)) out.push('documents_partial');
  if (l.commercialState === 'offer_sent') out.push('offer_sent');
  if (l.financialState === 'financing_in_progress' && l.commercialState !== 'cancelled' && l.commercialState !== 'retracted') out.push('financing_incomplete');
  return out;
}

export const statusText = (status: string): string => (LEAD_STATUS_LABELS as Record<string, string>)[status] ?? status;

// ── Ouverture du canal ───────────────────────────────────────────────────────

const digits = (phone: string): string => phone.replace(/[^\d+]/g, '');

/** Lien qui ouvre la messagerie, le téléphone ou WhatsApp du télépro avec le message prêt ; null sans coordonnée adaptée. */
export function channelLink(channel: MessageChannel, contact: { email: string | null; phone: string | null }, msg: { subject: string; body: string }): string | null {
  if (channel === 'email') return contact.email ? `mailto:${encodeURIComponent(contact.email)}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.body)}` : null;
  const phone = contact.phone ? digits(contact.phone) : '';
  if (!phone) return null;
  if (channel === 'sms') return `sms:${phone}?body=${encodeURIComponent(msg.body)}`;
  // WhatsApp attend l'indicatif sans « + » ; un numéro français « 06… » devient « 336… ».
  const intl = phone.startsWith('+') ? phone.slice(1) : phone.startsWith('00') ? phone.slice(2) : phone.startsWith('0') ? `33${phone.slice(1)}` : phone;
  return `https://wa.me/${intl}?text=${encodeURIComponent(msg.body)}`;
}
