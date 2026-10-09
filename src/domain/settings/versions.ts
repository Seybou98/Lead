// Versions de configuration (§21.9, §21.10, fig. 25 « Versions & publication ») : l'historique d'un réglage, déduit du
// journal d'audit — chaque enregistrement y laisse l'ancienne ET la nouvelle valeur, donc rien n'est stocké en double.
// Un « retour arrière » ne détruit aucune version : il enregistre à nouveau l'ancienne valeur, ce qui crée une NOUVELLE
// version (équivalente à l'ancienne), elle-même tracée. Fonctions pures.

import { REASON_LIST_LABELS, type ReasonList } from './reasons';
import { formatWeeklySchedule } from '../admin/scheduleFormat';
import { formatDelay, OUTSIDE_HOURS_LABELS, type OutsideHours } from './settings';

export type VersionModule = 'sla' | 'rules' | 'conversion' | 'reasons' | 'checklist';

export const MODULE_LABELS: Record<VersionModule, string> = { sla: 'SLA et horaires', rules: 'Cycles NR, rappels et documents', conversion: 'Verrous de conversion', reasons: 'Motifs et listes', checklist: 'Checklists documentaires' };

/** Une ligne du journal d'audit (cl_audit), telle que lue. */
export interface AuditRow {
  id: string;
  atMs: number;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface VersionEntry {
  id: string;
  module: VersionModule;
  /** Objet concerné : « sla », « rules », ou la clé de la famille pour une checklist. */
  subject: string;
  number: number;
  atMs: number;
  actorId: string;
  reason: string | null;
  /** Phrases lisibles : ce qui a changé par rapport à la version précédente. */
  changes: string[];
  /** Valeur à enregistrer pour revenir à cette version ; null si la version est une suppression. */
  payload: Record<string, unknown> | null;
  /** Version actuellement en vigueur. */
  current: boolean;
  deleted: boolean;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const yes = (v: unknown) => (v === true ? 'Activée' : 'Désactivée');

export function moduleOf(row: Pick<AuditRow, 'entityType' | 'entityId' | 'action'>): VersionModule | null {
  if (row.entityType === 'settings' && row.entityId === 'sla') return 'sla';
  if (row.entityType === 'settings' && row.entityId === 'rules') return 'rules';
  if (row.entityType === 'settings' && row.entityId === 'conversion') return 'conversion';
  if (row.entityType === 'settings' && row.entityId === 'reasons') return 'reasons';
  if (row.entityType === 'checklist') return 'checklist';
  return null;
}

/** Ce qui a changé d'une version à la suivante, en phrases. Première version : un résumé de son contenu. */
export function describeChanges(module: VersionModule, beforeRaw: unknown, afterRaw: unknown): string[] {
  const before = rec(beforeRaw);
  const after = rec(afterRaw);
  const first = beforeRaw === null || beforeRaw === undefined;
  const out: string[] = [];
  const line = (label: string, a: unknown, b: unknown, fmt: (v: unknown) => string = String) => {
    if (!same(a, b)) out.push(first ? `${label} : ${fmt(b)}` : `${label} : ${fmt(a)} → ${fmt(b)}`);
  };
  const min = (v: unknown) => `${v} min`;

  if (module === 'sla') {
    line('Première alerte', before.firstAlertMin, after.firstAlertMin, min);
    line('Retard critique', before.criticalMin, after.criticalMin, min);
    line('Réattribution', before.reassignMin, after.reassignMin, min);
    line('Réattribution automatique', before.autoReassign, after.autoReassign, yes);
    line('Réattributions maximales', before.maxReassignments, after.maxReassignments);
    line('Équipe de secours', before.fallbackTeamId ?? null, after.fallbackTeamId ?? null, (v) => (v ? 'définie' : 'aucune'));
    line('SLA suspendu hors horaires', before.suspendOutsideHours, after.suspendOutsideHours, yes);
    line('Hors horaires', before.outsideHours, after.outsideHours, (v) => OUTSIDE_HOURS_LABELS[v as OutsideHours]?.toLowerCase() ?? String(v));
    const bs = rec(before.schedule);
    const as = rec(after.schedule);
    if (!same(bs.weekly, as.weekly)) out.push(`Horaires : ${formatWeeklySchedule(arr(as.weekly) as never)}`);
    if (!same(bs.timezone, as.timezone)) out.push(`Fuseau horaire : ${String(as.timezone)}`);
    if (!same(bs.closedDates, as.closedDates)) out.push(`Jours fermés : ${arr(as.closedDates).length ? arr(as.closedDates).join(', ') : 'aucun'}`);
  } else if (module === 'reasons') {
    const b = rec(before.lists);
    const a = rec(after.lists);
    for (const list of Object.keys(a)) {
      const title = REASON_LIST_LABELS[list as ReasonList]?.title ?? list;
      const bi = arr(b[list]).map((i) => rec(i));
      const ai = arr(a[list]).map((i) => rec(i));
      const byCode = new Map(bi.map((i) => [i.code, i]));
      for (const it of ai) {
        const old = byCode.get(it.code);
        if (!old) { if (!first) out.push(`${title} : valeur ajoutée « ${String(it.label)} »`); continue; }
        if (old.label !== it.label) out.push(`${title} : « ${String(old.label)} » renommé « ${String(it.label)} »`);
        if (old.active !== it.active) out.push(`${title} : « ${String(it.label)} » ${it.active === true ? 'réactivée' : 'archivée'}`);
        if ((old.requireComment === true) !== (it.requireComment === true)) out.push(`${title} : commentaire ${it.requireComment === true ? 'obligatoire' : 'facultatif'} pour « ${String(it.label)} »`);
      }
      if (!first && !same(bi.map((i) => i.code), ai.filter((i) => byCode.has(i.code)).map((i) => i.code)) && ai.length === bi.length) out.push(`${title} : ordre modifié`);
    }
    if (first) out.push(`Listes de motifs enregistrées (${Object.keys(a).length} listes)`);
  } else if (module === 'conversion') {
    line('Remise maximale sans validation', before.maxDiscountPct, after.maxDiscountPct, (v) => `${v} %`);
    line('Éligibilité aux aides', before.requireEligibility, after.requireEligibility, (v) => (v === true ? 'exigée (sinon validation du manager)' : 'non exigée'));
    line('Qualification RGE', before.requireRge, after.requireRge, (v) => (v === true ? 'exigée' : 'non exigée'));
    line('Consentement du client', before.requireConsent, after.requireConsent, (v) => (v === true ? 'exigé (sinon validation du manager)' : 'non exigé'));
  } else if (module === 'rules') {
    const bn = arr(before.nrDelaysMinutes) as number[];
    const an = arr(after.nrDelaysMinutes) as number[];
    an.forEach((m, i) => {
      if (first || bn[i] !== m) out.push(first ? `Délai après NR${i + 1} : ${formatDelay(m)}` : `Délai après NR${i + 1} : ${bn[i] === undefined ? '—' : formatDelay(bn[i])} → ${formatDelay(m)}`);
    });
    line('Délai de recyclage', before.recycleAfterDays, after.recycleAfterDays, (v) => `${v} j`);
    line('Cycles avant archivage', before.maxRecycleCycles, after.maxRecycleCycles);
    line('Relances documentaires', before.followUpDays, after.followUpDays, (v) => arr(v).map((d) => `J+${d}`).join(', '));
    line('Délai entre deux décisions', before.decisionRepeatDays, after.decisionRepeatDays, (v) => `${v} j`);
    line('Marge « documents promis »', before.promisedMarginMinutes, after.promisedMarginMinutes, min);
    line('Alerte « rappel non effectué »', before.callbackEscalationMin, after.callbackEscalationMin, min);
    line('Alerte « lead non attribué »', before.bufferWarnMin, after.bufferWarnMin, min);
    line('Anomalie « non attribué »', before.bufferAnomalyHours, after.bufferAnomalyHours, (v) => `${v} h`);
  } else {
    const items = (r: Record<string, unknown>) => arr(r.items).map((i) => rec(i));
    const b = items(before);
    const a = items(after);
    const byCode = new Map(b.map((i) => [i.code, i]));
    const afterCodes = new Set(a.map((i) => i.code));
    for (const it of a) {
      const old = byCode.get(it.code);
      if (!old) out.push(`Pièce ajoutée : ${String(it.label)}${it.mandatory === true ? ' (obligatoire)' : ''}`);
      else {
        if (old.label !== it.label) out.push(`Pièce renommée : ${String(old.label)} → ${String(it.label)}`);
        if (old.mandatory !== it.mandatory) out.push(`${String(it.label)} : ${it.mandatory === true ? 'devient obligatoire' : 'devient facultative'}`);
      }
    }
    for (const it of b) if (!afterCodes.has(it.code)) out.push(`Pièce retirée : ${String(it.label)}`);
    if (!first && out.length === 0 && !same(b.map((i) => i.code), a.map((i) => i.code))) out.push('Ordre des pièces modifié');
    if (first && out.length === 0) out.push('Checklist créée');
  }
  return out.length ? out : [first ? 'Première version' : 'Aucun changement de valeur'];
}

/** Valeur à ré-enregistrer pour revenir à une version : sans les champs propres à l'enregistrement (dates, auteur). */
function payloadOf(module: VersionModule, after: unknown): Record<string, unknown> | null {
  if (after === null || after === undefined) return null;
  const a = rec(after);
  if (module === 'checklist') return { productCode: typeof a.productCode === 'string' ? a.productCode : null, items: arr(a.items).map((i) => ({ code: rec(i).code, label: rec(i).label, mandatory: rec(i).mandatory === true })) };
  const { updatedAt: _u, updatedBy: _b, createdAt: _c, ...rest } = a;
  void _u; void _b; void _c;
  return rest;
}

/**
 * Historique d'un réglage, de la version la plus récente à la plus ancienne. `subject` limite à une checklist
 * (clé de famille). La numérotation suit l'ordre chronologique : v1 est le premier enregistrement.
 */
export function versionsOf(rows: readonly AuditRow[], module: VersionModule, subject?: string): VersionEntry[] {
  const mine = rows.filter((r) => moduleOf(r) === module && (subject === undefined || r.entityId === subject)).sort((a, b) => a.atMs - b.atMs);
  const entries: VersionEntry[] = mine.map((r, i) => ({
    id: r.id,
    module,
    subject: r.entityId,
    number: i + 1,
    atMs: r.atMs,
    actorId: r.actorId,
    reason: r.reason,
    changes: r.action.endsWith('.delete') ? ['Checklist supprimée : le produit reprend la checklist par défaut'] : describeChanges(module, r.before, r.after),
    payload: r.action.endsWith('.delete') ? null : payloadOf(module, r.after),
    current: false,
    deleted: r.action.endsWith('.delete'),
  }));
  const last = entries[entries.length - 1];
  if (last && !last.deleted) last.current = true;
  return entries.reverse();
}
