// Retour des statuts du CRM principal (§24.8) : relit, SANS rien y modifier, les dossiers déjà transmis (`dossiers`, leur
// client et leur subvention), en déduit l'étape (src/domain/mainSync/mainStatus.ts) et répercute chaque changement sur le
// lead et la vente : historique, notification, jalons (validé, installé, facturé), retrait des ventes nettes si annulé.
// Ne rouvre jamais une étape commerciale : le statut du lead (« Converti ») n'est pas touché.
//
// Idempotent : l'étape déjà répercutée est lue dans la transaction ; rejouer un passage ne double rien.

import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import { describeChange, isTerminalStage, MAIN_STAGE_LABELS, resolveMainStage, type MainStage } from '../../src/domain/mainSync/mainStatus';

export interface MainSyncReport {
  read: number;
  changed: number;
  cancelled: number;
  errors: string[];
}

const READ_LIMIT = 300;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function syncMainStatuses(db: Firestore, nowMs: number): Promise<MainSyncReport> {
  const report: MainSyncReport = { read: 0, changed: 0, cancelled: 0, errors: [] };
  const at = new Date(nowMs);
  const snap = await db.collection(COL.conversions).where('state', '==', 'confirmed').limit(READ_LIMIT).get();

  for (const conv of snap.docs) {
    if (conv.get('mainTerminal') === true) continue; // facturé ou annulé : plus rien à surveiller
    const leadId = conv.id;
    const dossierId = conv.get('dossierId');
    if (typeof dossierId !== 'string' || !dossierId) continue;
    report.read += 1;
    try {
      // ── lecture seule du CRM principal ──
      const dossierSnap = await db.collection('dossiers').doc(dossierId).get();
      if (!dossierSnap.exists) continue; // dossier supprimé côté CRM principal : on garde la dernière étape connue
      const dossier = dossierSnap.data() as DocumentData;
      let clientId: string | null = (typeof dossier.clientId === 'string' && dossier.clientId) || (typeof dossier.promotedClientId === 'string' && dossier.promotedClientId) || null;
      if (!clientId) {
        const found = await db.collection('clients').where('sourceDossierId', '==', dossierId).limit(1).get();
        clientId = found.empty ? null : found.docs[0].id;
      }
      const clientSnap = clientId ? await db.collection('clients').doc(clientId).get() : null;
      const subId = typeof dossier.subventionId === 'string' && dossier.subventionId ? dossier.subventionId : null;
      const subSnap = subId ? await db.collection('subventions').doc(subId).get() : null;

      const result = resolveMainStage({
        dossierStatus: dossier.status,
        hasClient: !!clientSnap?.exists,
        clientStatus: clientSnap?.exists ? clientSnap.get('status') : null,
        subventionStatus: subSnap?.exists ? (subSnap.get('dossier') as DocumentData | undefined)?.statut : null,
      });

      // ── écriture côté CRM Leads, en une transaction ──
      const outcome = await db.runTransaction(async (tx) => {
        const leadRef = db.collection(COL.leads).doc(leadId);
        const [c, lead, sale] = await Promise.all([tx.get(conv.ref), tx.get(leadRef), tx.get(db.collection(COL.sales).doc(leadId))]);
        const previous = (typeof c.get('mainStage') === 'string' ? c.get('mainStage') : null) as MainStage | null;
        if (!lead.exists) return 'skip' as const;
        const rawChanged = JSON.stringify(c.get('mainRaw') ?? null) !== JSON.stringify(result.raw);
        if (previous === result.stage && !rawChanged) return 'same' as const;

        const seq = Number(c.get('mainSeq') ?? 0) + 1;
        const who = String(lead.get('fullName') || 'Contact sans nom');
        const change = previous === result.stage ? null : describeChange(previous, result.stage, who);
        const terminal = isTerminalStage(result.stage);
        const dates: Record<string, Date> = {};
        if (change?.milestone) dates[`mainStatus.${change.milestone}At`] = at;

        tx.update(conv.ref, { mainStage: result.stage, mainRaw: result.raw, mainSeq: seq, mainSyncedAt: at, mainTerminal: terminal, updatedAt: at });
        const leadPatch: Record<string, unknown> = {
          'mainStatus.stage': result.stage,
          'mainStatus.label': result.label,
          'mainStatus.raw': result.raw,
          'mainStatus.changedAt': change ? at : (lead.get('mainStatus.changedAt') ?? at),
          'mainStatus.syncedAt': at,
          ...dates,
          updatedAt: at,
          version: FieldValue.increment(1),
        };
        // Annulation côté CRM principal : la vente sort des ventes nettes (motif, date). Une vente déjà annulée ou rétractée ne bouge pas.
        let cancelledSale = false;
        const commercial = String(lead.get('commercialState') ?? 'none');
        if (change?.cancelsSale && commercial !== 'cancelled' && commercial !== 'retracted') {
          cancelledSale = true;
          leadPatch.commercialState = 'cancelled';
          leadPatch['saleTrack.cancelledAt'] = at;
          leadPatch['saleTrack.cancelReason'] = 'Annulé dans le CRM principal';
          if (sale.exists) tx.update(sale.ref, { commercialState: 'cancelled', 'track.cancelledAt': at, 'track.cancelReason': 'Annulé dans le CRM principal', updatedAt: at });
        }
        tx.update(leadRef, leadPatch);

        if (change) {
          const ev = leadRef.collection(SUB.events).doc(`main_${leadId}_${seq}`);
          tx.set(ev, { id: ev.id, type: 'conversion', at, actorId: 'system', note: change.note, before: previous ? { mainStage: previous } : {}, after: { mainStage: result.stage }, meta: { op: 'main_status', ...result.raw } });
          if (cancelledSale) {
            const audit = db.collection(COL.audit).doc(`main_cancel_${leadId}`);
            tx.set(audit, { id: audit.id, at, actorId: 'system', action: 'sale.cancel_from_main', entityType: 'lead', entityId: leadId, before: { commercialState: commercial }, after: { commercialState: 'cancelled' }, reason: 'Annulé dans le CRM principal' });
          }
          const recipients = [...new Set([lead.get('ownerId'), ...arr(lead.get('managerIds'))].filter((x): x is string => typeof x === 'string' && !!x))];
          if (change.notify && recipients.length > 0) {
            const n = db.collection(COL.notifications).doc(`main_${leadId}_${seq}`);
            tx.set(n, { id: n.id, type: 'conversion', title: change.notify.title, description: change.notify.description.slice(0, 300), leadId, recipientIds: recipients, sound: change.notify.sound, readBy: [], createdAt: at });
          }
        }
        return cancelledSale ? ('cancelled' as const) : ('changed' as const);
      });
      if (outcome === 'changed' || outcome === 'cancelled') report.changed += 1;
      if (outcome === 'cancelled') report.cancelled += 1;
    } catch (e) {
      // Un dossier en échec ne bloque pas les autres.
      report.errors.push(`${leadId} : ${(e as Error).message}`.slice(0, 200));
    }
  }
  return report;
}

export { MAIN_STAGE_LABELS };
