// Historique utile d'un lead transmis au CRM principal (§11.3, §11.8, fig. 44 « Historique »). On ne recopie pas tout le
// journal technique du lead : seulement ce qui raconte la relation commerciale (réception, attribution, appels, notes,
// pièces, changements de statut, vente). Fonctions pures.

import { LEAD_STATUS_LABELS } from '../labels';

export interface LeadEventLike {
  id: string;
  type: string;
  atMs: number;
  actorId: string;
  note?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface HistoryEntry {
  /** Identifiant déterministe dans le CRM principal : retransmettre ne crée jamais de doublon. */
  id: string;
  atMs: number;
  actorId: string;
  text: string;
}

/** Types d'événements qui racontent la relation commerciale ; le reste (alertes, brouillons, doublons) reste dans le CRM Leads. */
const USEFUL = new Set(['created', 'assigned', 'reassigned', 'status_changed', 'call_result', 'note', 'document', 'conversion', 'exception']);

/** Nombre maximal d'entrées reprises (les plus récentes) : l'historique du CRM principal reste lisible. */
export const MAX_HISTORY = 50;

const statusLabel = (v: unknown): string => (typeof v === 'string' ? (LEAD_STATUS_LABELS[v as keyof typeof LEAD_STATUS_LABELS] ?? v) : '—');

function textOf(e: LeadEventLike): string | null {
  const note = e.note?.trim();
  const reason = e.reason?.trim();
  switch (e.type) {
    case 'created': return note || 'Lead reçu';
    case 'assigned': return note || 'Lead attribué à un télépro';
    case 'reassigned': return `Lead réattribué${reason ? ` : ${reason}` : ''}`;
    case 'status_changed': return `Statut : ${statusLabel(e.before?.status)} → ${statusLabel(e.after?.status)}${reason ? ` (${reason})` : ''}`;
    case 'call_result': return note || 'Résultat d’appel enregistré';
    case 'note': return note ? `Note : ${note}` : null;
    case 'document': return note || null;
    case 'conversion': return note || null;
    case 'exception': return note || null;
    default: return null;
  }
}

/** Entrées de l'historique à reprendre, de la plus ancienne à la plus récente, plafonnées aux MAX_HISTORY dernières. */
export function usefulHistory(leadId: string, events: readonly LeadEventLike[], limit: number = MAX_HISTORY): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of events) {
    if (!USEFUL.has(e.type) || !Number.isFinite(e.atMs)) continue;
    const text = textOf(e);
    if (!text) continue;
    out.push({ id: `cl_ev_${leadId}_${e.id}`.slice(0, 200), atMs: e.atMs, actorId: e.actorId, text: text.slice(0, 500) });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out.slice(-limit);
}
