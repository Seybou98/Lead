// Couche Firestore de l'enregistrement des réponses au formulaire de qualification (§21.3). Elle lit le lead et le
// formulaire PUBLIÉ du produit, appelle l'évaluation pure (src/domain/qualification/form.ts), puis écrit en une
// transaction (réponses, résumé, historique). Les réponses sont toujours contrôlées contre le formulaire publié :
// un navigateur ne peut pas enregistrer un champ masqué, un champ inconnu ou une valeur hors format.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import { CLOSED_LEAD_STATUSES, type Role } from '../../src/domain/enums';
import { qualificationKey } from '../../src/domain/admin/plans';
import { answersToKeep, evaluate, normalizeForm, type QualificationForm } from '../../src/domain/qualification/form';

export interface QualificationArgs {
  uid: string;
  role: Role;
  leadId: string;
  answers: unknown;
  requestId: string;
  nowMs: number;
}

export type QualificationOutcome =
  | { ok: true; message: string; status: string; version: number; eligibility: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'lead_closed' | 'invalid' | 'no_form'; message: string };

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const STATUS_TEXT: Record<string, string> = { complete: 'complète', incomplete: 'incomplète', blocked: 'bloquée' };

/** Formulaire publié d'un produit : le sien, sinon celui par défaut ; null si aucun n'est publié. */
export async function readPublishedForm(read: (key: string) => Promise<Record<string, unknown> | undefined>, productCode: string | null): Promise<{ form: QualificationForm; version: number; key: string } | null> {
  const keys = productCode ? [qualificationKey(productCode), qualificationKey(null)] : [qualificationKey(null)];
  for (const key of keys) {
    const d = await read(key);
    if (d && isObj(d.published)) {
      const form = normalizeForm(d.published);
      if (form.fields.length > 0) return { form, version: typeof d.version === 'number' ? d.version : 0, key };
    }
  }
  return null;
}

export async function saveQualificationAnswers(db: Firestore, args: QualificationArgs): Promise<QualificationOutcome> {
  const leadRef = db.collection(COL.leads).doc(args.leadId);
  if (!isObj(args.answers)) return { ok: false, code: 'invalid', message: 'Réponses illisibles.' };
  const answers = args.answers;

  return db.runTransaction(async (tx): Promise<QualificationOutcome> => {
    const leadSnap = await tx.get(leadRef);
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    const lead = leadSnap.data()!;
    const allowed = args.role === 'admin' || (args.role === 'manager' && arr(lead.managerIds).includes(args.uid)) || (args.role === 'telepro' && lead.ownerId === args.uid);
    if (!allowed) return { ok: false, code: 'forbidden', message: 'Seul le propriétaire du lead, son manager ou un administrateur peut renseigner la qualification.' };
    if (CLOSED_LEAD_STATUSES.includes(lead.status)) return { ok: false, code: 'lead_closed', message: 'Ce lead est clôturé : sa qualification ne peut plus être modifiée.' };

    const productCode: string | null = typeof lead.productCode === 'string' && lead.productCode ? lead.productCode : null;
    const keys = productCode ? [qualificationKey(productCode), qualificationKey(null)] : [qualificationKey(null)];
    const snaps = await Promise.all(keys.map((k) => tx.get(db.collection(COL.settings).doc(k))));
    const byKey = new Map(keys.map((k, i) => [k, snaps[i].exists ? (snaps[i].data() as Record<string, unknown>) : undefined]));
    const published = await readPublishedForm(async (k) => byKey.get(k), productCode);
    if (!published) return { ok: false, code: 'no_form', message: "Aucun formulaire de qualification n'est publié pour ce produit." };

    const kept = answersToKeep(published.form, answers, productCode);
    const ev = evaluate(published.form, kept, productCode);
    const bad = ev.fields.find((s) => s.error);
    if (bad) return { ok: false, code: 'invalid', message: `${bad.def.label} : ${bad.error}` };

    const at = new Date(args.nowMs);
    const summary = {
      key: published.key,
      version: published.version,
      answers: kept,
      status: ev.status,
      eligibility: ev.eligibility,
      alerts: ev.alerts,
      missing: ev.missing,
      blocked: ev.blocked,
      savedAt: at,
      savedBy: args.uid,
    };
    tx.update(leadRef, { qualificationForm: summary, updatedAt: at, version: FieldValue.increment(1) });

    const eventRef = leadRef.collection(SUB.events).doc(`${args.requestId}_qualification`);
    const message = `Qualification ${STATUS_TEXT[ev.status]} (formulaire v${published.version})${ev.eligibility === 'refused' ? ' · éligibilité refusée' : ev.eligibility === 'to_confirm' ? ' · éligibilité à confirmer' : ''}.`;
    tx.set(eventRef, { id: eventRef.id, type: 'qualification', at, actorId: args.uid, note: message, meta: { version: published.version, status: ev.status, eligibility: ev.eligibility } });
    return { ok: true, message, status: ev.status, version: published.version, eligibility: ev.eligibility };
  });
}
