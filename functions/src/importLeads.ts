// Import CSV et saisie manuelle d'un lead (§4.1, §24.2). Couche Firestore mince : chaque ligne passe par LA MÊME
// réception que les autres sources (donnée brute conservée, normalisation, doublons, attribution, SLA) ; ce fichier ne
// décide d'aucune règle métier. Un lot est idempotent (rejeu après une coupure réseau : mêmes résultats, rien de
// ré-importé) et une ligne en erreur n'interrompt jamais les suivantes.

import type { Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import type { Role } from '../../src/domain/enums';
import { ingestLead, type IngestResult } from './ingest';

export const MAX_ROWS_PER_BATCH = 20;
/** Une fonction a un délai : au-delà de ce temps, le lot s'arrête et rend ce qui est traité ; l'appelant renvoie la suite. */
export const TIME_BUDGET_MS = 12_000;
const MAX_KEYS = 40;
const MAX_VALUE = 500;

export interface ImportArgs {
  uid: string;
  role: Role;
  channel: 'import' | 'manual';
  sourceId: string | null;
  batchId: string;
  /** Numéro (dans le fichier) de la première ligne du lot : pour retrouver une ligne refusée. */
  startRow: number;
  rows: unknown[];
  nowMs: number;
}

export type ImportRowResult =
  | { row: number; ok: true; kind: 'created' | 'attached' | 'replay'; leadId: string; assignmentState?: string; ownerId?: string | null; bufferReason?: string | null; outcome?: string }
  | { row: number; ok: false; code: string; reason: string };

export type ImportOutcome =
  | { ok: true; replay: boolean; results: ImportRowResult[]; /** Lignes traitées, de la première du lot : moins que demandé si le temps imparti est écoulé. */ processed: number; summary: { created: number; attached: number; rejected: number } }
  | { ok: false; code: 'forbidden' | 'invalid'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Une ligne n'est jamais transmise telle quelle : seules des valeurs simples, de taille bornée, atteignent la réception. */
export function sanitizeRow(raw: unknown): Record<string, string | number | boolean> | null {
  if (!isObj(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_KEYS)) {
    const key = k.trim().slice(0, 60);
    if (!key) continue;
    if (typeof v === 'string') out[key] = v.slice(0, MAX_VALUE);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

const toRowResult = (row: number, r: IngestResult): ImportRowResult =>
  r.ok
    ? r.kind === 'created'
      ? { row, ok: true, kind: 'created', leadId: r.leadId, assignmentState: r.assignmentState, ownerId: r.ownerId, bufferReason: r.bufferReason }
      : r.kind === 'attached'
        ? { row, ok: true, kind: 'attached', leadId: r.leadId, outcome: r.outcome }
        : { row, ok: true, kind: 'replay', leadId: r.leadId }
    : { row, ok: false, code: r.code, reason: r.reason };

export async function importLeads(db: Firestore, args: ImportArgs, deps: { ingest: typeof ingestLead; clock?: () => number; budgetMs?: number } = { ingest: ingestLead }): Promise<ImportOutcome> {
  if (args.role !== 'admin' && args.role !== 'manager') return { ok: false, code: 'forbidden', message: "Seul un manager ou un administrateur peut importer ou saisir un lead." };
  if (!Array.isArray(args.rows) || args.rows.length === 0) return { ok: false, code: 'invalid', message: 'Aucune ligne à traiter.' };
  if (args.rows.length > MAX_ROWS_PER_BATCH) return { ok: false, code: 'invalid', message: `${MAX_ROWS_PER_BATCH} lignes au plus par lot.` };
  if (args.channel === 'manual' && args.rows.length !== 1) return { ok: false, code: 'invalid', message: 'Une saisie manuelle crée un seul lead.' };

  const idemRef = db.collection(COL.idempotency).doc(`import_${args.batchId}_${args.startRow}`.slice(0, 200));
  const idem = await idemRef.get();
  if (idem.exists) {
    // Un autre utilisateur ne peut pas rejouer le lot de quelqu'un d'autre.
    if (idem.get('uid') !== args.uid) return { ok: false, code: 'invalid', message: 'Identifiant de lot déjà utilisé.' };
    const results = (idem.get('results') as ImportRowResult[] | undefined) ?? [];
    return { ok: true, replay: true, results, processed: results.length, summary: summarize(results) };
  }

  const results: ImportRowResult[] = [];
  const clock = deps.clock ?? Date.now;
  const started = clock();
  for (let i = 0; i < args.rows.length; i++) {
    // Au moins une ligne par appel ; ensuite, on s'arrête avant d'atteindre le délai de la fonction.
    if (i > 0 && clock() - started > (deps.budgetMs ?? TIME_BUDGET_MS)) break;
    const row = args.startRow + i;
    const payload = sanitizeRow(args.rows[i]);
    if (!payload) {
      results.push({ row, ok: false, code: 'invalid_row', reason: 'Ligne illisible.' });
      continue;
    }
    try {
      const r = await deps.ingest(db, { channel: args.channel, sourceId: args.sourceId, payload, nowMs: args.nowMs, meta: { actorId: args.uid, batchId: args.batchId, row } });
      results.push(toRowResult(row, r));
    } catch (e) {
      // Une erreur technique n'efface rien : la donnée brute est déjà écrite, la ligne est signalée et peut être rejouée.
      console.error('import : erreur sur une ligne', { row, message: e instanceof Error ? e.message : String(e) });
      results.push({ row, ok: false, code: 'error', reason: 'Erreur technique : ligne à rejouer.' });
    }
  }

  const summary = summarize(results);
  const at = new Date(args.nowMs);
  await idemRef.set({ uid: args.uid, results, createdAt: at });
  const audit = db.collection(COL.audit).doc(`import_${args.batchId}_${args.startRow}`.slice(0, 200));
  await audit.set({ id: audit.id, at, actorId: args.uid, action: args.channel === 'manual' ? 'lead.manual_create' : 'leads.import', entityType: 'lead_batch', entityId: args.batchId, before: null, after: { startRow: args.startRow, rows: results.length, ...summary, sourceId: args.sourceId }, reason: null });
  return { ok: true, replay: false, results, processed: results.length, summary };
}

function summarize(results: readonly ImportRowResult[]): { created: number; attached: number; rejected: number } {
  return {
    created: results.filter((r) => r.ok && r.kind === 'created').length,
    attached: results.filter((r) => r.ok && (r.kind === 'attached' || r.kind === 'replay')).length,
    rejected: results.filter((r) => !r.ok).length,
  };
}
