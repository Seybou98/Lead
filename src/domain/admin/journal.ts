// Journal de distribution (fig. 19, §19.5) : transforme les entrées cl_distributionLog en lignes de
// tableau et en explication « Pourquoi Sarah ? ». Fonctions pures, sans Firestore.
//
// Une entrée contient les valeurs de charge FIGÉES au moment du calcul : l'explication est donc
// reconstituée à partir de ce qui a été enregistré, jamais de l'état actuel de la base.

import { DISTRIBUTION_EVENT_LABELS, ENGINE_REASON_LABELS, EXCLUSION_LABELS } from '../labels';
import { normalizeText } from '../engine/normalize';
import { toCsv } from '../csv';
import type { ExclusionCode } from '../engine/assignment';

export interface JournalCandidate {
  uid: string;
  eligible: boolean;
  exclusions: string[];
  activeLoad: number;
  newLeads: number;
  cap: number | null;
}

export interface JournalEntry {
  id: string;
  atMs: number;
  leadId: string;
  leadName: string | null;
  campaignId: string | null;
  event: string;
  mode: 'real' | 'simulation';
  chosenOwnerId: string | null;
  previousOwnerId: string | null;
  actorId: string;
  reason: string | null;
  ruleApplied: string;
  candidates: JournalCandidate[];
}

export interface JournalNames {
  users: ReadonlyMap<string, string>;
  campaigns: ReadonlyMap<string, string>;
}

export type JournalStatus = 'success' | 'pending';

export interface JournalRow {
  id: string;
  atMs: number;
  leadId: string;
  /** « LEAD-ab12cd — Jean Dupont » : identifiant court + nom quand il est connu. */
  leadLabel: string;
  campaignName: string;
  eventLabel: string;
  ownerName: string;
  motif: string;
  status: JournalStatus;
  event: string;
  campaignId: string | null;
  ownerId: string | null;
}

export const shortLeadId = (id: string) => `LEAD-${id.slice(0, 6).toUpperCase()}`;

/** Un motif connu du moteur est traduit ; un motif libre saisi par un manager est affiché tel quel. */
export function motifLabel(reason: string | null): string {
  if (!reason) return '—';
  return ENGINE_REASON_LABELS[reason] ?? reason;
}

const nameOf = (names: JournalNames, uid: string | null) => (uid ? (names.users.get(uid) ?? uid) : '—');

export function buildJournalRows(entries: readonly JournalEntry[], names: JournalNames): JournalRow[] {
  return [...entries]
    .sort((a, b) => b.atMs - a.atMs)
    .map((e) => ({
      id: e.id,
      atMs: e.atMs,
      leadId: e.leadId,
      leadLabel: e.leadName ? `${shortLeadId(e.leadId)} — ${e.leadName}` : shortLeadId(e.leadId),
      campaignName: e.campaignId ? (names.campaigns.get(e.campaignId) ?? e.campaignId) : '—',
      eventLabel: DISTRIBUTION_EVENT_LABELS[e.event] ?? e.event,
      ownerName: nameOf(names, e.chosenOwnerId),
      motif: motifLabel(e.reason),
      // « En attente » = personne n'a reçu le lead (file tampon) ; sinon la décision a abouti.
      status: e.chosenOwnerId ? 'success' : 'pending',
      event: e.event,
      campaignId: e.campaignId,
      ownerId: e.chosenOwnerId,
    }));
}

// ── Filtres ──────────────────────────────────────────────────────────────────

export interface JournalFilters {
  fromMs: number | null;
  toMs: number | null;
  campaignId: string | 'all';
  ownerId: string | 'all';
  event: string | 'all';
  search: string;
}

export const NO_JOURNAL_FILTERS: JournalFilters = { fromMs: null, toMs: null, campaignId: 'all', ownerId: 'all', event: 'all', search: '' };

export function filterJournalRows(rows: readonly JournalRow[], f: JournalFilters): JournalRow[] {
  const q = normalizeText(f.search);
  return rows.filter((r) => {
    if (f.fromMs !== null && r.atMs < f.fromMs) return false;
    if (f.toMs !== null && r.atMs >= f.toMs) return false;
    if (f.campaignId !== 'all' && r.campaignId !== f.campaignId) return false;
    if (f.ownerId !== 'all' && r.ownerId !== f.ownerId) return false;
    if (f.event !== 'all' && r.event !== f.event) return false;
    if (q && !normalizeText(`${r.leadId} ${r.leadLabel}`).includes(q)) return false;
    return true;
  });
}

// ── « Pourquoi ce lead a-t-il été attribué à cette personne ? » ─────────────

export interface EvaluatedCandidate {
  uid: string;
  name: string;
  /** « 4/10 » ; « — » quand le plafond n'a pas été enregistré (anciennes entrées). */
  load: string;
  tag: 'retained' | 'excluded' | 'eligible';
  /** Exclusions en clair, ou « Disponible » pour un éligible. */
  detail: string;
}

export interface Explanation {
  /** Étapes de la chronologie de la décision. */
  timeline: { title: string; detail: string }[];
  evaluated: EvaluatedCandidate[];
  /** Titre « Pourquoi Sarah ? » ; null s'il n'y a pas eu d'attribution. */
  whyTitle: string | null;
  why: string[];
}

function exclusionText(codes: readonly string[]): string {
  return codes.map((c) => EXCLUSION_LABELS[c as ExclusionCode] ?? c).join(', ');
}

export function explainDecision(entry: JournalEntry, names: JournalNames): Explanation {
  const chosen = entry.chosenOwnerId;
  const chosenName = chosen ? nameOf(names, chosen) : null;
  const eventLabel = DISTRIBUTION_EVENT_LABELS[entry.event] ?? entry.event;

  const timeline = [
    { title: 'Lead reçu', detail: 'Lead créé et intégré dans le système.' },
    { title: 'Éligibilité analysée', detail: 'Produit, zone et règles de campagne vérifiés.' },
    chosenName
      ? { title: `Attribué à ${chosenName}`, detail: `Décision : ${eventLabel.toLowerCase()}${entry.actorId !== 'engine' ? ' (manuelle)' : ' (moteur)'}.` }
      : { title: 'Mis en file tampon', detail: `Aucune attribution : ${motifLabel(entry.reason).toLowerCase()}.` },
  ];

  const evaluated: EvaluatedCandidate[] = entry.candidates.map((c) => ({
    uid: c.uid,
    name: nameOf(names, c.uid),
    load: c.cap === null ? '—' : `${c.newLeads}/${c.cap}`,
    tag: c.uid === chosen ? 'retained' : c.eligible ? 'eligible' : 'excluded',
    detail: c.eligible ? 'Disponible' : exclusionText(c.exclusions),
  }));
  // Retenu d'abord, puis éligibles, puis exclus.
  const order = { retained: 0, eligible: 1, excluded: 2 } as const;
  evaluated.sort((a, b) => order[a.tag] - order[b.tag] || a.name.localeCompare(b.name, 'fr'));

  if (!chosenName) return { timeline, evaluated, whyTitle: null, why: [] };

  const why: string[] = [];
  const winner = entry.candidates.find((c) => c.uid === chosen);
  const others = entry.candidates.filter((c) => c.eligible && c.uid !== chosen);

  if (entry.actorId !== 'engine') {
    why.push(entry.reason ? `Décision manuelle : ${entry.reason}` : 'Décision manuelle d\'un manager.');
  } else {
    why.push('Aucun critère d\'éligibilité bloquant.');
    const runnerUp = [...others].sort((a, b) => a.activeLoad - b.activeLoad)[0];
    if (!winner || others.length === 0) {
      why.push('Seul télépro éligible à cet instant.');
    } else if (entry.reason === 'lowest_active_load') {
      why.push(`Charge active la plus faible : ${winner.activeLoad} (contre ${runnerUp.activeLoad} pour ${nameOf(names, runnerUp.uid)}).`);
    } else if (entry.reason === 'fewest_new_leads') {
      const r = [...others].sort((a, b) => a.newLeads - b.newLeads)[0];
      why.push(`Charge active à égalité ; moins de nouveaux leads : ${winner.newLeads} (contre ${r.newLeads} pour ${nameOf(names, r.uid)}).`);
    } else if (entry.reason === 'oldest_last_assignment') {
      why.push('Charge et nouveaux leads à égalité ; dernière attribution la plus ancienne.');
    } else if (entry.reason === 'stable_hash') {
      why.push('Égalité parfaite sur tous les critères : départage stable et reproductible.');
    } else if (entry.reason) {
      why.push(motifLabel(entry.reason));
    }
    if (winner && winner.cap !== null) why.push(`Capacité disponible : ${winner.newLeads}/${winner.cap} nouveaux leads.`);
  }

  return { timeline, evaluated, whyTitle: `Pourquoi ${chosenName} ?`, why };
}

// ── Export ───────────────────────────────────────────────────────────────────

/** CSV séparé par des points-virgules, avec BOM UTF-8 (voir ../csv). */
export function journalToCsv(rows: readonly JournalRow[]): string {
  return toCsv(
    ['Date', 'Heure', 'Lead', 'Campagne', 'Événement', 'Télépro', 'Motif', 'Statut'],
    rows.map((r) => {
      const d = new Date(r.atMs);
      return [
        d.toLocaleDateString('fr-FR'),
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        r.leadLabel,
        r.campaignName,
        r.eventLabel,
        r.ownerName,
        r.motif,
        r.status === 'success' ? 'Réussie' : 'En attente',
      ];
    })
  );
}
