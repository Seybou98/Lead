// Portefeuille d'un télépro, absences et transfert (§20.6 à §20.9, figs. 22 à 24). Fonctions PURES, sans Firestore :
// charge par famille, conséquences d'une absence, et simulation d'un transfert (qui reçoit quoi, charge avant/après,
// saturations, éléments non attribués). La même simulation sert à l'écran (avant confirmation) et à l'envoi, donc
// ce que le manager voit est exactement ce qui sera appliqué.

import { CLOSED_LEAD_STATUSES, type LeadStatus } from '../enums';
import { callbackLevel, isCallbackAction } from '../alerts/engine';
import { slaAgeMs, slaLevel, type LeadListItem } from '../leads/leadList';
import { normalizeText } from '../engine/normalize';
import type { UserRow } from '../admin/userRows';

const HOUR = 3_600_000;

// ── Familles de charge ───────────────────────────────────────────────────────

export const FAMILIES = ['newLeads', 'callbacks', 'interested', 'documents', 'filesToBuild', 'recycling'] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABELS: Record<Family, string> = {
  newLeads: 'Nouveaux leads',
  callbacks: 'Rappels',
  interested: 'Intéressés',
  documents: 'Documents',
  filesToBuild: 'Dossiers à monter',
  recycling: 'Recyclage',
};

/** Libellés de la fig. 23 (colonne « Élément »). */
export const FAMILY_ELEMENT_LABELS: Record<Family, string> = {
  newLeads: 'Nouveaux leads non traités',
  callbacks: 'Rappels promis',
  interested: 'Leads intéressés',
  documents: 'Documents attendus',
  filesToBuild: 'Dossiers à monter',
  recycling: 'Recyclage',
};

const FAMILY_OF: Partial<Record<LeadStatus, Family>> = {
  new: 'newLeads',
  nr: 'newLeads',
  callback: 'callbacks',
  interested: 'interested',
  awaiting_documents: 'documents',
  missing_info: 'documents',
  file_ready_to_build: 'filesToBuild',
  file_building: 'filesToBuild',
  recycling: 'recycling',
};

export const familyOf = (status: LeadStatus): Family | null => FAMILY_OF[status] ?? null;

export type Portfolio = Record<Family, LeadListItem[]>;

/** Éléments ouverts d'un télépro, rangés par famille (un lead = une famille, d'après son statut). */
export function portfolioOf(items: readonly LeadListItem[], uid: string): Portfolio {
  const out: Portfolio = { newLeads: [], callbacks: [], interested: [], documents: [], filesToBuild: [], recycling: [] };
  for (const l of items) {
    if (l.ownerId !== uid || l.excluded || CLOSED_LEAD_STATUSES.includes(l.status)) continue;
    const f = familyOf(l.status);
    if (f) out[f].push(l);
  }
  return out;
}

export const portfolioTotal = (p: Portfolio): number => FAMILIES.reduce((n, f) => n + p[f].length, 0);

// ── Conséquences d'une absence (fig. 23, « Conséquences ») ───────────────────

export interface Consequences {
  /** Rappels promis dans les 24 prochaines heures, ou déjà en retard. */
  callbacksSoon: number;
  /** Nouveaux leads dont le SLA est dépassé ou proche. */
  nearSla: number;
  /** Promesses documentaires échues ou à échoir dans les 24 heures. */
  promisedDocs: number;
  /** Dossiers prêts à monter. */
  urgentFiles: number;
}

export function consequencesOf(p: Portfolio, nowMs: number, windowMs = 24 * HOUR): Consequences {
  return {
    callbacksSoon: p.callbacks.filter((l) => isCallbackAction(l) && l.nextAction !== null && l.nextAction.dueAtMs <= nowMs + windowMs).length,
    nearSla: p.newLeads.filter((l) => {
      const age = slaAgeMs(l, nowMs);
      return age !== null && slaLevel(age) !== 'ok';
    }).length,
    promisedDocs: p.documents.filter((l) => l.nextAction?.type === 'promised_docs_missing' && l.nextAction.dueAtMs <= nowMs + windowMs).length,
    urgentFiles: p.filesToBuild.filter((l) => l.status === 'file_ready_to_build').length,
  };
}

/** Rappels déjà en retard : à signaler en premier dans l'écran d'absence. */
export const lateCallbacks = (p: Portfolio, nowMs: number): number =>
  p.callbacks.filter((l) => l.nextAction !== null && ['orange', 'red'].includes(callbackLevel(l.nextAction.dueAtMs, nowMs) ?? '')).length;

// ── Traitement du portefeuille pendant une absence (§20.6) ───────────────────

export interface Handling {
  newLeads: 'reassign_now' | 'keep';
  callbacks: 'transfer' | 'keep';
  interested: 'case_by_case' | 'transfer';
  documents: 'transfer_temporarily' | 'keep';
  filesToBuild: 'reassign' | 'keep';
  recycling: 'suspend' | 'redistribute';
}

/** Comportements recommandés par le cahier (§20.6). */
export const DEFAULT_HANDLING: Handling = {
  newLeads: 'reassign_now',
  callbacks: 'transfer',
  interested: 'case_by_case',
  documents: 'transfer_temporarily',
  filesToBuild: 'keep',
  recycling: 'suspend',
};

export const HANDLING_OPTIONS: { [F in Family]: { value: Handling[F]; label: string }[] } = {
  newLeads: [{ value: 'reassign_now', label: 'Réattribuer immédiatement' }, { value: 'keep', label: 'Conserver' }],
  callbacks: [{ value: 'transfer', label: 'Transférer avec historique' }, { value: 'keep', label: 'Conserver' }],
  interested: [{ value: 'case_by_case', label: 'Examiner au cas par cas' }, { value: 'transfer', label: 'Transférer' }],
  documents: [{ value: 'transfer_temporarily', label: 'Transférer temporairement' }, { value: 'keep', label: 'Conserver' }],
  filesToBuild: [{ value: 'reassign', label: 'Réattribuer' }, { value: 'keep', label: 'Conserver' }],
  recycling: [{ value: 'suspend', label: 'Suspendre jusqu’au retour' }, { value: 'redistribute', label: 'Redistribuer en période creuse' }],
};

/** Valeurs acceptées pour chaque famille : tout le reste est refusé (jamais de décision « devinée »). */
export function parseHandling(raw: unknown): Handling | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FAMILIES) {
    const ok = HANDLING_OPTIONS[f].find((o) => o.value === r[f]);
    if (!ok) return null;
    out[f] = ok.value;
  }
  return out as unknown as Handling;
}

/** Familles à transférer d'après les décisions (« examiner au cas par cas », « suspendre », « conserver » : non). */
export function familiesToTransfer(h: Handling): Family[] {
  const out: Family[] = [];
  if (h.newLeads === 'reassign_now') out.push('newLeads');
  if (h.callbacks === 'transfer') out.push('callbacks');
  if (h.interested === 'transfer') out.push('interested');
  if (h.documents === 'transfer_temporarily') out.push('documents');
  if (h.filesToBuild === 'reassign') out.push('filesToBuild');
  if (h.recycling === 'redistribute') out.push('recycling');
  return out;
}

// ── Simulation d'un transfert (fig. 24) ──────────────────────────────────────

/** Un destinataire possible, tel que le moteur le voit à cet instant. */
export interface Target {
  uid: string;
  name: string;
  /** Compte actif, profil de distribution, ni suspendu ni absent ni indisponible. */
  canReceive: boolean;
  newLeads: number;
  cap: number;
  /** Charge totale en main. */
  total: number;
  /** '*' = tous les produits ; liste vide = aucun. */
  productCodes: readonly string[];
  teamIds: readonly string[];
}

export type Destination = { kind: 'users'; uids: readonly string[] } | { kind: 'team'; teamId: string } | { kind: 'engine' };

export interface Assignment {
  leadId: string;
  family: Family;
  /** null = non attribué : la capacité ou le périmètre ne le permet pas, le lead reste chez son propriétaire. */
  targetUid: string | null;
}

export interface Projection {
  uid: string;
  name: string;
  cap: number;
  newBefore: number;
  newAfter: number;
  totalBefore: number;
  totalAfter: number;
  /** Nombre d'éléments reçus dans ce transfert. */
  received: number;
  /** Atteint ou dépasse son plafond de nouveaux leads. */
  saturated: boolean;
}

export interface FamilyRow {
  family: Family;
  volume: number;
  assigned: number;
  unassigned: number;
  /** Destinataires et nombre d'éléments reçus dans cette famille. */
  targets: { uid: string; count: number }[];
}

export interface TransferPlan {
  assignments: Assignment[];
  projections: Projection[];
  rows: FamilyRow[];
  /** « Le nombre d'éléments sélectionnés, affectés et non attribués doit toujours être réconcilié » (§20.8). */
  reconcile: { selected: number; assigned: number; unassigned: number };
  warnings: string[];
}

const PRIORITY: readonly Family[] = ['callbacks', 'newLeads', 'interested', 'documents', 'filesToBuild', 'recycling'];

const productAllowed = (t: Target, productCode: string | null): boolean => {
  if (t.productCodes.includes('*') || productCode === null) return true;
  const wanted = normalizeText(productCode);
  return t.productCodes.some((p) => normalizeText(p) === wanted);
};

/**
 * Répartit les éléments sélectionnés. Les nouveaux leads respectent le plafond (au-delà : non attribués, jamais de
 * dépassement silencieux) ; les autres familles ne sont pas plafonnées mais équilibrées sur la charge totale. Un
 * destinataire n'est retenu que si son périmètre produit couvre le lead.
 */
export function planTransfer(args: { leads: readonly LeadListItem[]; fromUid: string; destination: Destination; targets: readonly Target[] }): TransferPlan {
  const { fromUid, destination } = args;
  const pool = args.targets.filter((t) => {
    if (t.uid === fromUid || !t.canReceive) return false;
    if (destination.kind === 'users') return destination.uids.includes(t.uid);
    if (destination.kind === 'team') return t.teamIds.includes(destination.teamId);
    return true;
  });
  const live = new Map(pool.map((t) => [t.uid, { t, newAfter: t.newLeads, totalAfter: t.total, received: 0 }]));

  const selected = args.leads.filter((l) => familyOf(l.status) !== null);
  const byFamily = new Map<Family, LeadListItem[]>();
  for (const l of selected) {
    const f = familyOf(l.status) as Family;
    byFamily.set(f, [...(byFamily.get(f) ?? []), l]);
  }

  const assignments: Assignment[] = [];
  const rowMap = new Map<Family, FamilyRow>();
  for (const family of PRIORITY) {
    const list = (byFamily.get(family) ?? []).slice().sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    if (list.length === 0) continue;
    const row: FamilyRow = { family, volume: list.length, assigned: 0, unassigned: 0, targets: [] };
    const counts = new Map<string, number>();
    for (const l of list) {
      const fits = [...live.values()].filter((c) => productAllowed(c.t, l.productCode) && (family !== 'newLeads' || c.newAfter < c.t.cap));
      // Nouveaux leads : le plus de capacité restante ; autres : la charge totale la plus faible.
      fits.sort((a, b) => (family === 'newLeads' ? b.t.cap - b.newAfter - (a.t.cap - a.newAfter) : 0) || a.totalAfter - b.totalAfter || a.t.name.localeCompare(b.t.name, 'fr'));
      const pick = fits[0];
      if (!pick) {
        assignments.push({ leadId: l.id, family, targetUid: null });
        row.unassigned += 1;
        continue;
      }
      if (family === 'newLeads') pick.newAfter += 1;
      pick.totalAfter += 1;
      pick.received += 1;
      assignments.push({ leadId: l.id, family, targetUid: pick.t.uid });
      counts.set(pick.t.uid, (counts.get(pick.t.uid) ?? 0) + 1);
      row.assigned += 1;
    }
    row.targets = [...counts.entries()].map(([uid, count]) => ({ uid, count })).sort((a, b) => b.count - a.count);
    rowMap.set(family, row);
  }

  const projections: Projection[] = [...live.values()]
    .filter((c) => c.received > 0)
    .map((c) => ({ uid: c.t.uid, name: c.t.name, cap: c.t.cap, newBefore: c.t.newLeads, newAfter: c.newAfter, totalBefore: c.t.total, totalAfter: c.totalAfter, received: c.received, saturated: c.t.cap > 0 && c.newAfter >= c.t.cap }))
    .sort((a, b) => b.received - a.received || a.name.localeCompare(b.name, 'fr'));

  const rows = PRIORITY.map((f) => rowMap.get(f)).filter((r): r is FamilyRow => !!r);
  const assigned = assignments.filter((a) => a.targetUid !== null).length;
  const warnings: string[] = [];
  if (selected.length > 0 && pool.length === 0) warnings.push('Aucun destinataire disponible : ni compte actif avec profil, ni hors absence ou suspension.');
  for (const p of projections) if (p.saturated) warnings.push(`${p.name} atteindra sa capacité maximale (${p.newAfter}/${p.cap}).`);
  for (const r of rows) if (r.unassigned > 0 && pool.length > 0) warnings.push(`${r.unassigned} ${FAMILY_LABELS[r.family].toLowerCase()} non attribué${r.unassigned > 1 ? 's' : ''} : capacité ou périmètre produit insuffisant.`);

  return { assignments, projections, rows, reconcile: { selected: selected.length, assigned, unassigned: selected.length - assigned }, warnings };
}

/** Charge d'un télépro en « x/plafond » pour la barre de simulation. */
export const loadRatio = (used: number, cap: number): number => (cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0);

/**
 * Destinataires possibles d'un transfert d'après l'annuaire : télépros actifs avec profil, ni absents ni indisponibles
 * (la suspension de la distribution n'empêche pas un manager de confier un lead : c'est son choix).
 */
export function buildTargets(rows: readonly UserRow[], items: readonly LeadListItem[]): Target[] {
  return rows
    .filter((r) => r.role === 'telepro' && r.hasProfile && r.accountActive)
    .map((r) => ({
      uid: r.uid,
      name: r.name,
      canReceive: r.operationalStatus !== 'absent' && r.operationalStatus !== 'unavailable',
      newLeads: r.newLeads ?? 0,
      cap: r.cap ?? 0,
      total: portfolioTotal(portfolioOf(items, r.uid)),
      productCodes: r.products,
      teamIds: r.teamIds,
    }));
}

export interface SendBatch {
  /** Transfert temporaire : le retour est programmé à la fin de l'absence. */
  temporary: boolean;
  assignments: { leadId: string; targetUid: string }[];
}

/**
 * Découpe un plan en envois au serveur : les éléments non attribués restent chez leur propriétaire (jamais envoyés),
 * les familles temporaires sont séparées des définitives (le retour automatique ne concerne que les premières), et
 * chaque envoi respecte la taille maximale acceptée par la fonction.
 */
export function toSendBatches(assignments: readonly Assignment[], temporaryFamilies: readonly Family[], size: number): SendBatch[] {
  const make = (temporary: boolean): SendBatch[] => {
    const list = assignments
      .filter((a): a is Assignment & { targetUid: string } => a.targetUid !== null && temporaryFamilies.includes(a.family) === temporary)
      .map((a) => ({ leadId: a.leadId, targetUid: a.targetUid }));
    const out: SendBatch[] = [];
    for (let i = 0; i < list.length; i += size) out.push({ temporary, assignments: list.slice(i, i + size) });
    return out;
  };
  return [...make(false), ...make(true)];
}
