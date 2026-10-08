// Point d'entrée des demandes de montage / vente : les actions décidées par le planificateur pur (brouillon,
// validation, vente) et la transmission au CRM principal. Une vente fraîchement créée est transmise tout de suite ;
// si la transmission échoue, la vente reste enregistrée et la reprise se fait automatiquement (planificateur) ou à la
// main (manager, administrateur).

import type { Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import type { ConversionActionInput } from '../../src/domain/conversion/plan';
import { applyConversionAction, type ConversionResult } from './conversion';
import { transmitConversion, type StorageLike } from './transmission';
import { applySaleAction } from './saleTrack';
import type { SaleAction } from '../../src/domain/sales/track';

export type ConversionRequest = ConversionActionInput | { kind: 'transmit'; decision?: 'link' | 'create' } | { kind: 'sale_action'; action: SaleAction };

export const CONVERSION_REQUEST_KINDS = ['save_draft', 'request_validation', 'decide', 'create_sale', 'transmit', 'sale_action'] as const;

export interface ConversionRunArgs {
  uid: string;
  role: Role;
  leadId: string;
  requestId: string;
  input: ConversionRequest;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function runConversionRequest(db: Firestore, storage: StorageLike | null, args: ConversionRunArgs, nowMs: number = Date.now()): Promise<ConversionResult> {
  const { input } = args;

  // Suivi de la vente : signature, règlement, financement, annulation, relance (§23).
  if (input.kind === 'sale_action') {
    const r = await applySaleAction(db, { uid: args.uid, role: args.role, leadId: args.leadId, requestId: args.requestId, action: input.action, nowMs });
    if (!r.ok) return r;
    return { ok: true, replay: r.replay, message: r.message, status: r.secured ? 'secured' : r.commercialState, validationState: r.financialState, saleNumber: null };
  }

  if (input.kind === 'transmit') {
    const leadSnap = await db.collection(COL.leads).doc(args.leadId).get();
    if (!leadSnap.exists) return { ok: false, code: 'not_found', message: 'Lead introuvable.' };
    // Reprise manuelle contrôlée : manager du lead ou administrateur seulement (§11.9).
    const allowed = args.role === 'admin' || (args.role === 'manager' && arr(leadSnap.get('managerIds')).includes(args.uid));
    if (!allowed) return { ok: false, code: 'forbidden', message: 'Seul le manager du lead ou un administrateur peut relancer la transmission.' };
    const r = await transmitConversion(db, { leadId: args.leadId, actorId: args.uid, nowMs, onDuplicate: input.decision ?? null, storage });
    if (r.ok) return { ok: true, replay: r.replay, message: r.message, status: 'converted', validationState: '', saleNumber: null };
    return { ok: false, code: r.code === 'not_found' ? 'not_found' : 'unavailable', message: r.message };
  }

  const result = await applyConversionAction(db, { uid: args.uid, role: args.role, leadId: args.leadId, requestId: args.requestId, input, nowMs });
  if (!(result.ok && input.kind === 'create_sale' && !result.replay)) return result;

  // Vente créée : transmission immédiate. Un échec n'annule rien, la vente est enregistrée.
  try {
    const t = await transmitConversion(db, { leadId: args.leadId, actorId: args.uid, nowMs, storage });
    if (t.ok) return { ...result, status: 'converted', message: `Vente ${result.saleNumber} créée. ${t.message}` };
    return { ...result, status: 'transmission_error', message: `Vente ${result.saleNumber} créée. ${t.message}` };
  } catch (e) {
    console.error('conversion : transmission immédiate impossible', args.leadId, e);
    return { ...result, message: `Vente ${result.saleNumber} créée. La transmission au CRM principal sera reprise automatiquement.` };
  }
}
