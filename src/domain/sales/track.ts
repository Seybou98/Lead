// Suivi d'une vente après sa création (§23.7 à §23.9) : les axes commercial et financier avancent indépendamment, et une
// vente n'est « sécurisée » qu'après signature ET confirmation du paiement ou acceptation du financement.
//
// Le CRM ne signe, n'encaisse ni ne finance lui-même (prestataires de signature et organismes de financement hors
// périmètre à ce stade) : le télépro ou le manager ENREGISTRE ce qui s'est passé, avec trace, et le CRM contrôle la
// cohérence de l'enchaînement. Fonctions pures, sans Firestore.

import { CLOSED_LEAD_STATUSES, type Role } from '../enums';

export const OFFER_CHANNELS = ['email', 'sms', 'whatsapp', 'other'] as const;
export type OfferChannel = (typeof OFFER_CHANNELS)[number];
export const OFFER_CHANNEL_LABELS: Record<OfferChannel, string> = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp', other: 'Autre moyen' };

export type SaleAction =
  | { kind: 'offer_sent'; channel: OfferChannel }
  | { kind: 'signed'; note?: string }
  | { kind: 'deposit_expected'; amountCents: number }
  | { kind: 'deposit_received' }
  | { kind: 'payment_confirmed' }
  | { kind: 'financing_started'; organism: string }
  | { kind: 'financing_accepted' }
  | { kind: 'financing_refused'; reason: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'retract'; reason: string }
  | { kind: 'reminder'; note?: string };

export const SALE_ACTION_KINDS = ['offer_sent', 'signed', 'deposit_expected', 'deposit_received', 'payment_confirmed', 'financing_started', 'financing_accepted', 'financing_refused', 'cancel', 'retract', 'reminder'] as const;

export const SALE_ACTION_LABELS: Record<SaleAction['kind'], string> = {
  offer_sent: "Marquer l'offre envoyée",
  signed: 'Marquer signée',
  deposit_expected: 'Acompte attendu',
  deposit_received: 'Acompte reçu',
  payment_confirmed: 'Paiement confirmé',
  financing_started: 'Financement demandé',
  financing_accepted: 'Financement accepté',
  financing_refused: 'Financement refusé',
  cancel: 'Annuler la vente',
  retract: 'Rétractation du client',
  reminder: "J'ai relancé",
};

const FIN_SECURED = ['payment_confirmed', 'financing_accepted'];

/** Sécurisée = signée ET (paiement confirmé OU financement accepté) ; un financement demandé ou refusé n'en est pas un (§23.11). */
export const isSecured = (commercial: string, financial: string): boolean => commercial === 'signed' && FIN_SECURED.includes(financial);

export interface SaleTrackLead {
  id: string;
  status: string;
  ownerId: string | null;
  managerIds: string[];
  fullName: string;
  saleId: string | null;
  commercialState: string;
  financialState: string;
  securedAtMs: number | null;
}

export interface SaleTrackContext {
  lead: SaleTrackLead;
  saleNumber: string;
  /** Reste à charge de la vente, en centimes : plafond de l'acompte attendu. */
  remainderCents: number;
  actorId: string;
  actorRole: Role;
  nowMs: number;
}

export interface SaleTrackEvent {
  key: string;
  note: string;
  reason?: string;
  meta: Record<string, unknown>;
}

export interface SaleTrackNotification {
  key: string;
  recipientIds: string[];
  title: string;
  description: string;
  sound: 'critical' | null;
}

export interface SaleTrackPlan {
  action: SaleAction['kind'];
  commercialState: string;
  financialState: string;
  /** Posé une seule fois, à l'instant où la vente devient sécurisée ; null = rien à changer. */
  newlySecuredAtMs: number | null;
  /** Champs de suivi à écrire sous `saleTrack.` (lead) et sur la vente. */
  trackPatch: Record<string, string | number | null>;
  events: SaleTrackEvent[];
  notifications: SaleTrackNotification[];
  message: string;
}

export type SaleTrackResult =
  | { ok: true; plan: SaleTrackPlan }
  | { ok: false; code: 'forbidden' | 'unavailable' | 'invalid'; message: string };

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Actions proposées pour un état donné : l'écran n'affiche que celles que le serveur acceptera. Un état terminal
 * (annulée, rétractée) n'en propose aucune.
 */
export function availableSaleActions(commercial: string, financial: string): SaleAction['kind'][] {
  if (commercial === 'cancelled' || commercial === 'retracted') return [];
  const out: SaleAction['kind'][] = [];
  if (commercial === 'none' || commercial === 'sale_committed') out.push('offer_sent');
  if (commercial === 'none' || commercial === 'sale_committed' || commercial === 'offer_sent') out.push('signed');
  if (financial === 'none' || financial === 'deposit_expected') out.push('deposit_expected');
  if (financial === 'none' || financial === 'deposit_expected') out.push('deposit_received');
  if (!FIN_SECURED.includes(financial)) out.push('payment_confirmed');
  if (['none', 'deposit_expected', 'deposit_received', 'financing_refused'].includes(financial)) out.push('financing_started');
  if (financial === 'financing_in_progress') out.push('financing_accepted', 'financing_refused');
  if (!isSecured(commercial, financial)) out.push('reminder');
  out.push('cancel', 'retract');
  return out;
}

export function planSaleAction(action: SaleAction, ctx: SaleTrackContext): SaleTrackResult {
  const { lead, nowMs } = ctx;
  const fail = (code: 'forbidden' | 'unavailable' | 'invalid', message: string): SaleTrackResult => ({ ok: false, code, message });

  const isOwner = ctx.actorRole === 'telepro' && lead.ownerId === ctx.actorId;
  const isManager = ctx.actorRole === 'manager' && lead.managerIds.includes(ctx.actorId);
  const isAdmin = ctx.actorRole === 'admin';
  if (!(isOwner || isManager || isAdmin)) return fail('forbidden', 'Seul le propriétaire du lead, son manager ou un administrateur peut suivre cette vente.');
  if (!lead.saleId) return fail('unavailable', "Ce lead n'a pas de vente.");
  if (CLOSED_LEAD_STATUSES.includes(lead.status as never) && lead.status !== 'converted') return fail('unavailable', 'Ce lead est clôturé.');
  if (lead.commercialState === 'cancelled' || lead.commercialState === 'retracted') return fail('unavailable', `La vente est ${lead.commercialState === 'cancelled' ? 'annulée' : 'rétractée'} : plus aucune action n'est possible.`);
  if (!availableSaleActions(lead.commercialState, lead.financialState).includes(action.kind)) {
    return fail('unavailable', `Action impossible dans l'état actuel de la vente (${action.kind}).`);
  }
  // Annuler ou constater une rétractation engage Label Énergie : réservé au manager et à l'administrateur.
  if ((action.kind === 'cancel' || action.kind === 'retract') && !(isManager || isAdmin)) return fail('forbidden', 'Seul un manager ou un administrateur peut annuler une vente.');

  let commercial = lead.commercialState;
  let financial = lead.financialState;
  const trackPatch: Record<string, string | number | null> = {};
  const events: SaleTrackEvent[] = [];
  const notifications: SaleTrackNotification[] = [];
  const who = lead.fullName || 'Contact sans nom';
  const everyone = [...new Set([lead.ownerId, ...lead.managerIds].filter((x): x is string => !!x && x !== ctx.actorId))];
  const log = (note: string, op: string, extra: Record<string, unknown> = {}, reason?: string) => events.push({ key: op, note, ...(reason ? { reason } : {}), meta: { op, saleNumber: ctx.saleNumber, ...extra } });
  let message = '';

  switch (action.kind) {
    case 'offer_sent': {
      if (!(OFFER_CHANNELS as readonly string[]).includes(action.channel)) return fail('invalid', "Canal d'envoi inconnu.");
      commercial = 'offer_sent';
      trackPatch.offerSentAt = nowMs;
      trackPatch.offerChannel = action.channel;
      log(`Offre envoyée (${OFFER_CHANNEL_LABELS[action.channel]})`, 'offer_sent', { channel: action.channel });
      message = "Offre marquée envoyée.";
      break;
    }
    case 'signed': {
      commercial = 'signed';
      trackPatch.signedAt = nowMs;
      const note = text(action.note, 300);
      log(`Vente signée${note ? ` — ${note}` : ''}`, 'signed');
      message = 'Signature enregistrée.';
      break;
    }
    case 'deposit_expected': {
      const a = Math.round(Number(action.amountCents));
      if (!Number.isFinite(a) || a <= 0) return fail('invalid', "Indiquez le montant de l'acompte attendu.");
      if (ctx.remainderCents > 0 && a > ctx.remainderCents) return fail('invalid', "L'acompte ne peut pas dépasser le reste à charge.");
      financial = 'deposit_expected';
      trackPatch.depositCents = a;
      log(`Acompte attendu : ${(a / 100).toLocaleString('fr-FR')} €`, 'deposit_expected', { amountCents: a });
      message = 'Acompte attendu enregistré.';
      break;
    }
    case 'deposit_received': {
      financial = 'deposit_received';
      log('Acompte reçu', 'deposit_received');
      message = 'Acompte enregistré comme reçu.';
      break;
    }
    case 'payment_confirmed': {
      financial = 'payment_confirmed';
      log('Paiement confirmé', 'payment_confirmed');
      message = 'Paiement confirmé.';
      break;
    }
    case 'financing_started': {
      const organism = text(action.organism, 80);
      if (organism.length < 2) return fail('invalid', "Indiquez l'organisme de financement.");
      financial = 'financing_in_progress';
      trackPatch.financingOrganism = organism;
      log(`Demande de financement : ${organism}`, 'financing_started', { organism });
      message = 'Demande de financement enregistrée.';
      break;
    }
    case 'financing_accepted': {
      financial = 'financing_accepted';
      log('Financement accepté', 'financing_accepted');
      message = 'Financement accepté.';
      break;
    }
    case 'financing_refused': {
      const reason = text(action.reason, 300);
      if (reason.length < 5) return fail('invalid', 'Indiquez le motif du refus (5 caractères minimum).');
      financial = 'financing_refused';
      trackPatch.financingRefusedReason = reason;
      log('Financement refusé', 'financing_refused', {}, reason);
      // §23.8 : un refus ne marque jamais le prospect comme perdu ; le moteur propose une autre solution.
      if (everyone.length > 0) notifications.push({ key: 'refused', recipientIds: everyone, title: 'Financement refusé', description: `${who} : proposer une autre solution (apport, autre organisme, comptant).`, sound: null });
      message = "Financement refusé enregistré. La vente reste ouverte : proposez une autre solution.";
      break;
    }
    case 'cancel':
    case 'retract': {
      const reason = text(action.reason, 300);
      if (reason.length < 5) return fail('invalid', 'Un motif est obligatoire (5 caractères minimum).');
      commercial = action.kind === 'cancel' ? 'cancelled' : 'retracted';
      trackPatch.cancelledAt = nowMs;
      trackPatch.cancelReason = reason;
      log(action.kind === 'cancel' ? 'Vente annulée' : 'Rétractation du client', action.kind, {}, reason);
      if (everyone.length > 0) notifications.push({ key: 'cancel', recipientIds: everyone, title: action.kind === 'cancel' ? 'Vente annulée' : 'Vente rétractée', description: `${who} : ${reason}`.slice(0, 300), sound: 'critical' });
      message = action.kind === 'cancel' ? 'Vente annulée.' : 'Rétractation enregistrée.';
      break;
    }
    case 'reminder': {
      const note = text(action.note, 300);
      trackPatch.lastReminderAt = nowMs;
      log(`Relance du client${note ? ` — ${note}` : ''}`, 'reminder');
      message = 'Relance enregistrée.';
      break;
    }
    default:
      return fail('invalid', 'Action inconnue.');
  }

  let newlySecuredAtMs: number | null = null;
  if (isSecured(commercial, financial) && lead.securedAtMs === null) {
    newlySecuredAtMs = nowMs;
    log('Vente sécurisée : signature et règlement confirmés', 'secured');
    if (everyone.length > 0) notifications.push({ key: 'secured', recipientIds: everyone, title: 'Vente sécurisée', description: `${who} : signée et réglée.`, sound: null });
    message = `${message} La vente est sécurisée.`;
  }

  return { ok: true, plan: { action: action.kind, commercialState: commercial, financialState: financial, newlySecuredAtMs, trackPatch, events, notifications, message } };
}

/** Message de relance prêt à copier (le CRM n'envoie rien en V1 : le télépro l'envoie lui-même, puis clique « J'ai relancé »). */
export function buildSaleReminderMessage(args: { firstName: string; product: string | null; totalTtcCents: number | null; stage: 'to_sign' | 'to_secure'; financialState: string }): string {
  const hi = args.firstName ? `Bonjour ${args.firstName},` : 'Bonjour,';
  const what = args.product ? `votre projet ${args.product}` : 'votre projet';
  const amount = args.totalTtcCents ? ` d'un montant de ${(args.totalTtcCents / 100).toLocaleString('fr-FR')} € TTC` : '';
  if (args.stage === 'to_sign') return `${hi}\nJe reviens vers vous au sujet de ${what}${amount}. Pour avancer, il ne reste que la signature de l'offre. Avez-vous pu la consulter ? Je reste à votre disposition pour répondre à vos questions.\nCordialement`;
  if (args.financialState === 'financing_refused') return `${hi}\nLa demande de financement de ${what} n'a pas abouti. Je vous propose de regarder ensemble une autre solution (apport, autre organisme ou règlement comptant). Quand pouvons-nous en parler ?\nCordialement`;
  if (args.financialState === 'financing_in_progress') return `${hi}\nJe reviens vers vous au sujet de la demande de financement de ${what}. Avez-vous pu compléter votre dossier auprès de l'organisme ? Dites-moi si vous avez besoin d'aide.\nCordialement`;
  return `${hi}\nJe reviens vers vous au sujet de ${what}${amount}. Votre signature est bien enregistrée ; il reste à finaliser le règlement. Pouvez-vous me confirmer la date prévue ?\nCordialement`;
}
