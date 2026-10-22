// Brouillons de réglages (§21.9) : enregistrement d'un brouillon, publication, abandon. Fonctions pures, partagées par les
// écritures du navigateur et les tests. Un brouillon passe par les MÊMES contrôles que la publication (le plan du module) : on
// ne peut pas enregistrer un brouillon que la publication refuserait pour une raison de forme.

import { AdminRuleError, planConversionSave, planMessagesSave, planProductsSave, planReasonsSave, planRulesSave, planSlaSave, type AuditDraft } from './plans';
import { draftDocId, isDraftModule, isStale, parseDraft, publishedDocId, type DraftModule } from '../settings/publication';

type Doc = Record<string, unknown>;
type Plan = (args: { input: unknown; before: Doc | null; actorId: string; nowMs: number }) => { doc: Doc; audit: AuditDraft };

const PLANS: Record<DraftModule, Plan> = {
  sla: planSlaSave as Plan,
  rules: planRulesSave as Plan,
  conversion: planConversionSave as Plan,
  reasons: planReasonsSave as Plan,
  messages: planMessagesSave as Plan,
  products: planProductsSave as Plan,
};

const ms = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | Date | number | null | undefined;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return t && typeof (t as { toMillis?: () => number }).toMillis === 'function' ? ((t as { toMillis: () => number }).toMillis()) : 0;
};

const moduleOf = (m: unknown): DraftModule => {
  if (!isDraftModule(m)) throw new AdminRuleError('invalid-argument', 'Module de réglage inconnu.');
  return m;
};

/** Valide la saisie et prépare le document `draft_<module>` : la saisie, et le réglage qu'elle produirait. */
export function planDraftSave(args: { module: unknown; input: unknown; before: Doc | null; actorId: string; nowMs: number }): { id: string; doc: Doc; audit: AuditDraft } {
  const module = moduleOf(args.module);
  const plan = PLANS[module]({ input: args.input, before: args.before, actorId: args.actorId, nowMs: args.nowMs });
  const doc: Doc = {
    module,
    // La saisie est conservée telle quelle (JSON simple) : la publication la rejoue contre le réglage publié du moment.
    input: JSON.parse(JSON.stringify(args.input ?? {})),
    doc: JSON.parse(JSON.stringify({ ...plan.doc, updatedAt: null })),
    atMs: args.nowMs,
    byId: args.actorId,
    baseMs: ms(args.before?.updatedAt),
  };
  return { id: draftDocId(module), doc, audit: { action: 'settings.draft.save', entityType: 'settings_draft', entityId: module, before: null, after: { module }, reason: null } };
}

/**
 * Publie le brouillon : le réglage publié devient ce qu'il produit, avec la même trace d'audit que n'importe quel
 * enregistrement (versions et retour arrière). Refus si le réglage publié a changé depuis le brouillon.
 */
export function planDraftPublish(args: { module: unknown; draft: Doc | null; before: Doc | null; actorId: string; nowMs: number; reason: string; force?: boolean }): { id: string; draftId: string; doc: Doc; audit: AuditDraft } {
  const module = moduleOf(args.module);
  const draft = parseDraft(args.draft);
  if (!args.draft || !draft) throw new AdminRuleError('not-found', 'Aucun brouillon à publier.');
  if (args.reason.trim().length < 3) throw new AdminRuleError('invalid-argument', 'La justification de la publication est obligatoire.');
  if (!args.force && isStale(draft, ms(args.before?.updatedAt) || null)) throw new AdminRuleError('failed-precondition', 'Le réglage publié a changé depuis ce brouillon : ouvrez le brouillon, vérifiez-le et enregistrez-le de nouveau avant de publier.');
  const input = { ...(args.draft.input as Doc), reason: args.reason.trim() };
  const plan = PLANS[module]({ input, before: args.before, actorId: args.actorId, nowMs: args.nowMs });
  return { id: publishedDocId(module), draftId: draftDocId(module), doc: plan.doc, audit: plan.audit };
}

export function planDraftDiscard(args: { module: unknown; draft: Doc | null; actorId: string }): { draftId: string; audit: AuditDraft } {
  const module = moduleOf(args.module);
  if (!args.draft) throw new AdminRuleError('not-found', 'Aucun brouillon à abandonner.');
  return { draftId: draftDocId(module), audit: { action: 'settings.draft.discard', entityType: 'settings_draft', entityId: module, before: null, after: { module }, reason: null } };
}
