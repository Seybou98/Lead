// Clôture ou report d'une alerte du cockpit manager (§12.6, §12.8) — couche Firestore. L'alerte est dérivée de l'état du lead ;
// la décision d'un manager (clôture avec motif, report) est portée par le lead (champ `cockpitAlerts`) et tracée dans l'audit.
// Idempotent (`cl_idempotency/cockpit_<requête>`), une seule transaction. Droits : administrateur, ou manager du lead.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { ALERT_KEYS, ALERT_LABELS, POSTPONABLE, POSTPONE_CHOICES, type AlertKey, type PostponeKey } from '../../src/domain/cockpit/alertStates';
import { loadReasonCatalog } from './settings';

export type AlertAction =
  | { kind: 'close'; reasonCode: string; comment: string }
  | { kind: 'postpone'; choice: PostponeKey; comment: string }
  | { kind: 'reopen' };

export interface AlertArgs {
  uid: string;
  role: Role;
  leadId: string;
  alertKey: AlertKey;
  /** Début de la situation vue par le manager : une situation plus récente est une nouvelle alerte. */
  sinceMs: number;
  action: AlertAction;
  requestId: string;
  nowMs: number;
}

export type AlertOutcome =
  | { ok: true; replay: boolean; message: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid'; message: string };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const isAlertKey = (v: unknown): v is AlertKey => typeof v === 'string' && (ALERT_KEYS as readonly string[]).includes(v);

export async function applyAlertAction(db: Firestore, args: AlertArgs): Promise<AlertOutcome> {
  if (args.role !== 'admin' && args.role !== 'manager') return { ok: false, code: 'forbidden', message: 'Réservé aux managers et aux administrateurs.' };
  if (!isAlertKey(args.alertKey) || !Number.isFinite(args.sinceMs)) return { ok: false, code: 'invalid', message: 'Alerte inconnue.' };
  const a = args.action;

  // Validation de la décision avant toute lecture du lead.
  const comment = a.kind === 'reopen' ? '' : a.comment.replace(/\s+/g, ' ').trim().slice(0, 400);
  let reasonLabel = '';
  if (a.kind === 'close') {
    const catalog = await loadReasonCatalog(db);
    reasonLabel = catalog.active.alert_close[a.reasonCode] ?? '';
    if (!reasonLabel) return { ok: false, code: 'invalid', message: 'Le motif de clôture est obligatoire.' };
    if (catalog.commentRequired.alert_close.includes(a.reasonCode) && comment.length < 3) return { ok: false, code: 'invalid', message: `Motif « ${reasonLabel} » : précisez-le en commentaire.` };
  }
  if (a.kind === 'postpone') {
    if (!POSTPONABLE[args.alertKey]) return { ok: false, code: 'invalid', message: `${ALERT_LABELS[args.alertKey]} : cette alerte ne peut pas être reportée, elle se traite ou se clôture avec un motif.` };
    if (!POSTPONE_CHOICES.some((c) => c.key === a.choice)) return { ok: false, code: 'invalid', message: 'Durée de report inconnue.' };
  }

  const leadRef = db.collection(COL.leads).doc(args.leadId);
  const idemRef = db.collection(COL.idempotency).doc(`cockpit_${args.requestId}`.slice(0, 200));
  return db.runTransaction(async (tx): Promise<AlertOutcome> => {
    const [leadSnap, idemSnap] = await Promise.all([tx.get(leadRef), tx.get(idemRef)]);
    if (idemSnap.exists) {
      if (idemSnap.get('leadId') !== args.leadId || idemSnap.get('uid') !== args.uid) return { ok: false, code: 'invalid', message: 'Identifiant de demande déjà utilisé.' };
      return { ok: true, replay: true, message: String(idemSnap.get('message') ?? '') };
    }
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    if (args.role === 'manager' && !arr(leadSnap.get('managerIds')).includes(args.uid)) return { ok: false, code: 'forbidden', message: 'Ce lead n’est pas dans votre périmètre.' };

    const at = new Date(args.nowMs);
    const field = `cockpitAlerts.${args.alertKey}`;
    let value: unknown;
    let message: string;
    let action: string;
    if (a.kind === 'close') {
      value = { closed: { sinceMs: args.sinceMs, code: a.reasonCode, label: reasonLabel, comment, byId: args.uid, atMs: args.nowMs }, postponed: null };
      message = `Alerte clôturée : ${reasonLabel}.`;
      action = 'cockpit.alert_close';
    } else if (a.kind === 'postpone') {
      const choice = POSTPONE_CHOICES.find((c) => c.key === a.choice)!;
      value = { closed: null, postponed: { sinceMs: args.sinceMs, untilMs: args.nowMs + choice.ms, comment, byId: args.uid, atMs: args.nowMs } };
      message = `Alerte reportée de ${choice.label}.`;
      action = 'cockpit.alert_postpone';
    } else {
      value = FieldValue.delete();
      message = 'Alerte rétablie.';
      action = 'cockpit.alert_reopen';
    }
    tx.update(leadRef, { [field]: value, updatedAt: at });
    const auditRef = db.collection(COL.audit).doc();
    tx.set(auditRef, {
      id: auditRef.id,
      at,
      actorId: args.uid,
      action,
      entityType: 'lead',
      entityId: args.leadId,
      before: null,
      after: { alert: args.alertKey, sinceMs: args.sinceMs, ...(a.kind === 'close' ? { reasonCode: a.reasonCode, reason: reasonLabel } : {}), ...(a.kind === 'postpone' ? { choice: a.choice } : {}) },
      reason: comment || null,
    });
    tx.set(idemRef, { leadId: args.leadId, uid: args.uid, message, createdAt: at });
    return { ok: true, replay: false, message };
  });
}
