// Décisions du montage et de la création de la vente (§11). Fonction pure : prend la demande et l'état lu en base,
// rend ce qu'il faut écrire (brouillon, validation, vente, statut, événements, notifications) ou un refus motivé.
// Aucune règle métier dans la couche Firestore (functions/src/conversion.ts).

import { CLOSED_LEAD_STATUSES, type LeadStatus, type Role } from '../enums';
import { loadDeltaFor, type LoadBucket } from '../call/plan';
import { canCreateSale, DEFAULT_CONVERSION_RULES, evaluateControls, type ConversionRules, type ControlReport, type ValidationState } from './controls';
import { emptyDraft, sanitizeDraft, type MontageDraft } from './montage';
import type { OfferLine } from './finance';

export type ConversionActionInput =
  | { kind: 'save_draft'; draft: unknown }
  | { kind: 'request_validation'; message: string }
  | { kind: 'decide'; decision: 'approve' | 'refuse' | 'correction'; comment: string; acknowledged: boolean }
  | { kind: 'create_sale' };

export const CONVERSION_KINDS = ['save_draft', 'request_validation', 'decide', 'create_sale'] as const;

export interface ValidationException {
  key: string;
  label: string;
  detail: string;
  severity: 'medium' | 'high';
}

export interface StoredValidation {
  state: ValidationState;
  fingerprint: string | null;
  requestedBy: string | null;
  requestedAtMs: number | null;
  message: string;
  exceptions: ValidationException[];
  decidedBy: string | null;
  decidedAtMs: number | null;
  comment: string;
}

export const noValidation = (): StoredValidation => ({ state: 'none', fingerprint: null, requestedBy: null, requestedAtMs: null, message: '', exceptions: [], decidedBy: null, decidedAtMs: null, comment: '' });

export interface ConversionLead {
  id: string;
  status: LeadStatus;
  ownerId: string | null;
  managerIds: string[];
  fullName: string;
  consent: boolean | null;
  productCode: string | null;
  campaignName: string | null;
}

export interface ConversionContext {
  lead: ConversionLead;
  /** Brouillon enregistré ; null = aucun encore. */
  draft: MontageDraft | null;
  docs: { mandatory: number; mandatoryConform: number; withReserve: number };
  qualificationMissing: readonly string[];
  validation: StoredValidation;
  /** Numéro d'ordre de la prochaine vente de l'année (compteur serveur) ; seulement lu pour `create_sale`. */
  nextSaleSeq: number;
  actorId: string;
  actorRole: Role;
  nowMs: number;
  requestId: string;
  rules?: ConversionRules;
}

export interface PlannedEvent {
  key: string;
  type: 'status_changed' | 'conversion' | 'exception' | 'field_corrected';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  note?: string;
  meta?: Record<string, unknown>;
}

export interface PlannedNotification {
  key: string;
  recipientIds: string[];
  title: string;
  description: string;
  sound: 'critical' | null;
}

export interface SalePlan {
  /** « V-2026-00042 » */
  number: string;
  totalHtCents: number;
  totalTtcCents: number;
  mprCents: number;
  ceeCents: number;
  discountCents: number;
  remainderCents: number;
  lines: OfferLine[];
  financing: MontageDraft['offer']['financing'];
  client: MontageDraft['identity'];
  project: MontageDraft['project'];
  aids: MontageDraft['aids'];
  productCode: string | null;
  campaignName: string | null;
  ownerId: string | null;
  validatedBy: string | null;
}

export interface ConversionPlan {
  action: ConversionActionInput['kind'];
  draft: MontageDraft | null;
  validation: StoredValidation | null;
  status: LeadStatus;
  statusBefore: LeadStatus;
  sale: SalePlan | null;
  events: PlannedEvent[];
  notifications: PlannedNotification[];
  loadDelta: Partial<Record<LoadBucket, number>>;
  /** Résumé recopié sur le lead pour les listes (aucune lecture du brouillon). */
  summary: { validationState: ValidationState; blocking: number; toConfirm: number; totalTtcCents: number; remainderCents: number };
  message: string;
}

export type ConversionPlanResult =
  | { ok: true; plan: ConversionPlan }
  | { ok: false; code: 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid'; message: string };

const MONTAGE_STATUSES: readonly LeadStatus[] = ['file_building', 'file_ready'];
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const saleNumber = (nowMs: number, seq: number): string => `V-${new Date(nowMs).getUTCFullYear()}-${String(seq).padStart(5, '0')}`;

export function planConversionAction(input: ConversionActionInput, ctx: ConversionContext): ConversionPlanResult {
  const { lead, nowMs } = ctx;
  const rules = ctx.rules ?? DEFAULT_CONVERSION_RULES;
  const fail = (code: 'forbidden' | 'lead_closed' | 'unavailable' | 'invalid', message: string): ConversionPlanResult => ({ ok: false, code, message });

  const isOwner = ctx.actorRole === 'telepro' && lead.ownerId === ctx.actorId;
  const isManager = ctx.actorRole === 'manager' && lead.managerIds.includes(ctx.actorId);
  const isAdmin = ctx.actorRole === 'admin';
  if (CLOSED_LEAD_STATUSES.includes(lead.status) && lead.status !== 'converted') return fail('lead_closed', 'Ce lead est clôturé : son dossier ne peut plus être monté.');
  if (lead.status === 'converted' || lead.status === 'transmitting' || lead.status === 'transmission_error') return fail('unavailable', 'La vente est déjà créée pour ce lead.');

  const draft = ctx.draft ?? emptyDraft();
  const validation = ctx.validation;
  const evaluate = (d: MontageDraft): ControlReport => evaluateControls({ lead: { consent: lead.consent, productCode: lead.productCode }, draft: d, docs: ctx.docs, qualificationMissing: ctx.qualificationMissing, rules });
  const events: PlannedEvent[] = [];
  const notifications: PlannedNotification[] = [];
  const who = lead.fullName || 'Contact sans nom';

  const result = (p: { draft?: MontageDraft | null; validation?: StoredValidation | null; status: LeadStatus; sale?: SalePlan | null; report: ControlReport; message: string; validationState: ValidationState }): ConversionPlanResult => {
    if (p.status !== lead.status) events.unshift({ key: 'status', type: 'status_changed', before: { status: lead.status }, after: { status: p.status } });
    return {
      ok: true,
      plan: {
        action: input.kind,
        draft: p.draft ?? null,
        validation: p.validation ?? null,
        status: p.status,
        statusBefore: lead.status,
        sale: p.sale ?? null,
        events,
        notifications,
        loadDelta: loadDeltaFor(lead.status, p.status),
        summary: { validationState: p.validationState, blocking: p.report.blocking.length, toConfirm: p.report.toConfirm.length, totalTtcCents: p.report.recap.totalTtcCents, remainderCents: p.report.recap.remainderCents },
        message: p.message,
      },
    };
  };

  switch (input.kind) {
    case 'save_draft': {
      if (!(isOwner || isManager || isAdmin)) return fail('forbidden', 'Seul le propriétaire du lead, son manager ou un administrateur peut monter le dossier.');
      if (lead.status === 'manager_validation') return fail('unavailable', 'Le dossier est en attente de la décision du manager : il ne peut plus être modifié.');
      if (!MONTAGE_STATUSES.includes(lead.status)) return fail('unavailable', 'Le dossier doit d’abord passer au montage (toutes les pièces obligatoires conformes).');
      const next = sanitizeDraft(input.draft);
      const report = evaluate(next);
      // Une approbation ne vaut que pour la situation validée : si le prix, les aides ou les exceptions changent, elle tombe.
      let nextValidation = validation;
      if (validation.state === 'approved' && validation.fingerprint !== report.fingerprint) {
        nextValidation = noValidation();
        events.push({ key: 'invalid', type: 'exception', note: "Approbation du manager annulée : le dossier a été modifié depuis la validation.", meta: { op: 'approval_void' } });
      }
      const status: LeadStatus = canCreateSale(report, nextValidation) ? 'file_ready' : 'file_building';
      events.push({ key: 'draft', type: 'field_corrected', note: 'Brouillon du dossier enregistré', meta: { op: 'save_draft', controls: `${report.validated}/${report.total}` } });
      return result({ draft: next, validation: nextValidation === validation ? null : nextValidation, status, report, validationState: nextValidation.state, message: status === 'file_ready' ? 'Brouillon enregistré : le dossier est prêt, la vente peut être créée.' : 'Brouillon enregistré.' });
    }

    case 'request_validation': {
      if (!(isOwner || isManager || isAdmin)) return fail('forbidden', 'Seul le propriétaire du lead, son manager ou un administrateur peut demander une validation.');
      if (!ctx.draft) return fail('unavailable', 'Enregistrez le dossier avant de demander une validation.');
      if (lead.status === 'manager_validation') return fail('unavailable', 'Une validation est déjà en attente.');
      if (!MONTAGE_STATUSES.includes(lead.status)) return fail('unavailable', 'Le dossier doit être en cours de montage.');
      const report = evaluate(draft);
      if (!report.clean) return fail('unavailable', `${report.blocking.length} contrôle${report.blocking.length > 1 ? 's' : ''} bloquant${report.blocking.length > 1 ? 's' : ''} à corriger avant toute demande : ${report.blocking.map((c) => c.label).join(', ')}.`);
      if (report.toConfirm.length === 0) return fail('unavailable', "Aucune exception à valider : la vente peut être créée directement.");
      const message = text(input.message, 1000);
      if (message.length < 10) return fail('invalid', 'Expliquez la situation au manager (10 caractères minimum).');
      const exceptions: ValidationException[] = report.toConfirm.map((c) => ({ key: c.key, label: c.label, detail: c.detail, severity: c.severity ?? 'medium' }));
      const next: StoredValidation = { state: 'pending', fingerprint: report.fingerprint, requestedBy: ctx.actorId, requestedAtMs: nowMs, message, exceptions, decidedBy: null, decidedAtMs: null, comment: '' };
      events.push({ key: 'ask', type: 'exception', note: `Validation manager demandée : ${exceptions.map((e) => e.label).join(', ')}`, reason: message, meta: { op: 'request_validation', exceptions: exceptions.map((e) => e.key) } });
      if (lead.managerIds.length > 0) {
        notifications.push({ key: 'ask', recipientIds: lead.managerIds, title: 'Vente à valider', description: `${who} : ${exceptions.length} exception${exceptions.length > 1 ? 's' : ''} à décider.`, sound: 'critical' });
      }
      return result({ validation: next, status: 'manager_validation', report, validationState: 'pending', message: 'Demande envoyée au manager.' });
    }

    case 'decide': {
      if (!(isManager || isAdmin)) return fail('forbidden', 'Seul le manager du lead ou un administrateur peut décider d’une validation.');
      if (validation.state !== 'pending' || lead.status !== 'manager_validation') return fail('unavailable', "Aucune demande de validation n'est en attente pour ce lead.");
      if (validation.requestedBy === ctx.actorId) return fail('forbidden', 'Vous ne pouvez pas décider de votre propre demande.');
      const comment = text(input.comment, 500);
      if (input.decision !== 'approve' && comment.length < 5) return fail('invalid', 'Un commentaire est obligatoire pour refuser ou demander une correction.');
      const report = evaluate(draft);
      let state: ValidationState;
      let status: LeadStatus;
      let message: string;
      if (input.decision === 'approve') {
        if (input.acknowledged !== true) return fail('invalid', 'Confirmez avoir vérifié les éléments signalés.');
        if (!report.clean || validation.fingerprint !== report.fingerprint) return fail('unavailable', 'Le dossier a changé depuis la demande : refaites une demande de validation.');
        state = 'approved';
        status = 'file_ready';
        message = 'Vente approuvée : le propriétaire peut la créer.';
      } else if (input.decision === 'refuse') {
        state = 'refused';
        status = 'file_building';
        message = 'Validation refusée.';
      } else if (input.decision === 'correction') {
        state = 'correction';
        status = 'file_building';
        message = 'Correction demandée au propriétaire.';
      } else return fail('invalid', 'Décision inconnue.');
      const next: StoredValidation = { ...validation, state, decidedBy: ctx.actorId, decidedAtMs: nowMs, comment };
      events.push({ key: 'decide', type: 'exception', note: `Validation manager : ${state === 'approved' ? 'approuvée' : state === 'refused' ? 'refusée' : 'correction demandée'}${comment ? ` — ${comment}` : ''}`, reason: comment || undefined, meta: { op: 'decide', decision: input.decision } });
      const recipients = [validation.requestedBy, lead.ownerId].filter((x, i, a): x is string => !!x && a.indexOf(x) === i && x !== ctx.actorId);
      if (recipients.length > 0) {
        notifications.push({ key: 'decide', recipientIds: recipients, title: state === 'approved' ? 'Vente approuvée' : state === 'refused' ? 'Vente refusée' : 'Correction demandée', description: `${who}${comment ? ` : ${comment}` : ''}`.slice(0, 300), sound: null });
      }
      return result({ validation: next, status, report, validationState: state, message });
    }

    case 'create_sale': {
      if (!(isOwner || isManager || isAdmin)) return fail('forbidden', 'Seul le propriétaire du lead, son manager ou un administrateur peut créer la vente.');
      if (!ctx.draft) return fail('unavailable', 'Enregistrez le dossier avant de créer la vente.');
      if (lead.status === 'manager_validation') return fail('unavailable', 'Le dossier est en attente de la décision du manager.');
      if (!MONTAGE_STATUSES.includes(lead.status)) return fail('unavailable', 'Le dossier doit être en cours de montage.');
      const report = evaluate(draft);
      if (!canCreateSale(report, validation)) {
        const why = !report.clean ? report.blocking.map((c) => `${c.label} (${c.detail})`).join(' ; ') : 'une validation du manager est requise';
        return fail('unavailable', `La vente ne peut pas être créée : ${why}.`);
      }
      if (!Number.isInteger(ctx.nextSaleSeq) || ctx.nextSaleSeq < 1) return fail('invalid', 'Numéro de vente indisponible.');
      const recap = report.recap;
      const sale: SalePlan = {
        number: saleNumber(nowMs, ctx.nextSaleSeq),
        totalHtCents: recap.totalHtCents,
        totalTtcCents: recap.totalTtcCents,
        mprCents: recap.mprCents,
        ceeCents: recap.ceeCents,
        discountCents: recap.discountCents,
        remainderCents: recap.remainderCents,
        lines: draft.offer.lines,
        financing: draft.offer.financing,
        client: draft.identity,
        project: draft.project,
        aids: draft.aids,
        productCode: lead.productCode,
        campaignName: lead.campaignName,
        ownerId: lead.ownerId,
        validatedBy: validation.state === 'approved' ? validation.decidedBy : null,
      };
      events.push({ key: 'sale', type: 'conversion', note: `Vente ${sale.number} créée`, after: { saleNumber: sale.number, totalTtcCents: sale.totalTtcCents, remainderCents: sale.remainderCents }, meta: { op: 'create_sale' } });
      if (lead.managerIds.length > 0) {
        notifications.push({ key: 'sale', recipientIds: lead.managerIds.filter((m) => m !== ctx.actorId), title: 'Vente créée', description: `${who} : ${sale.number}`, sound: null });
      }
      // Le lead reste « Transmission en cours » jusqu'à la confirmation du CRM principal (§11.10).
      return result({ sale, status: 'transmitting', report, validationState: validation.state, message: `Vente ${sale.number} créée. Transmission au CRM principal en cours.` });
    }

    default:
      return fail('invalid', 'Action inconnue.');
  }
}
