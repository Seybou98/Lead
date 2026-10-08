// Envoi d'un plan de transfert au serveur, par lots (voir netlify/functions/portfolio.ts). Le plan a été simulé à
// l'écran avec les mêmes règles : ce qui part est exactement ce que le manager a vu. Rejouable sans doublon : tous les
// envois d'un même transfert partagent le même identifiant de lot, et chaque élément a sa propre clé d'idempotence.

import { newRequestId } from './qualifyApi';
import { sendTransferChunk, TRANSFER_CHUNK } from './portfolioApi';
import { toSendBatches, type Family, type TransferPlan } from '../domain/portfolio/portfolio';

export interface TransferOutcome {
  /** Éléments transférés. */
  done: number;
  /** Éléments refusés (ou envois en échec). */
  failed: number;
  /** Messages à montrer tels quels : le premier refus de chaque envoi. */
  messages: string[];
}

export async function runTransfer(args: {
  fromUid: string;
  plan: TransferPlan;
  temporaryFamilies?: readonly Family[];
  /** Retour automatique des familles temporaires, à la fin de l'absence. */
  returnAtMs?: number | null;
  reason: string;
  batchBaseId?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<TransferOutcome> {
  const base = args.batchBaseId ?? newRequestId();
  const batches = toSendBatches(args.plan.assignments, args.temporaryFamilies ?? [], TRANSFER_CHUNK);
  const total = batches.reduce((n, b) => n + b.assignments.length, 0);
  const out: TransferOutcome = { done: 0, failed: 0, messages: [] };
  let sent = 0;
  for (const b of batches) {
    const r = await sendTransferChunk({
      fromUid: args.fromUid,
      batchId: `${base}${b.temporary ? 't' : 'd'}`,
      assignments: b.assignments,
      reason: args.reason,
      returnAtMs: b.temporary ? (args.returnAtMs ?? null) : null,
    });
    sent += b.assignments.length;
    if (r.ok) {
      const data = r.data as { done?: string[]; failed?: { message: string }[] } | undefined;
      out.done += data?.done?.length ?? b.assignments.length;
      const failed = data?.failed ?? [];
      out.failed += failed.length;
      if (failed[0]) out.messages.push(failed[0].message);
    } else {
      out.failed += b.assignments.length;
      out.messages.push(r.message);
    }
    args.onProgress?.(sent, total);
  }
  return out;
}
