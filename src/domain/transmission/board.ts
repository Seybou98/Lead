// Écran « Transmission vers le CRM principal » (fig. 44, §24.7, §24.10). Fonctions pures, sans Firestore.
//
// Une ligne par dossier qui a quitté la file de travail du télépro : prêt à devenir une vente, bloqué (contrôle manquant
// ou transmission en échec), en attente (validation du manager, transmission en cours) ou transmis. Les chiffres des
// cartes viennent des mêmes lignes que celles du tableau.

import type { LeadRow } from '../leads/leadList';

export type TxStatus = 'ready' | 'blocked' | 'pending' | 'done';

export const TX_STATUS_LABELS: Record<TxStatus, string> = { ready: 'Prêt', blocked: 'Bloqué', pending: 'En attente', done: 'Transmis' };
export const TX_STATUS_ORDER: readonly TxStatus[] = ['blocked', 'ready', 'pending', 'done'];

/** Statut d'une ligne ; null = le lead n'est pas (ou plus) concerné par la transmission. */
export function txStatusOf(l: Pick<LeadRow, 'status' | 'montage' | 'conversion'>): TxStatus | null {
  switch (l.status) {
    case 'converted':
      return l.conversion?.state === 'confirmed' ? 'done' : l.conversion ? 'pending' : null;
    case 'transmitting':
      return 'pending';
    case 'transmission_error':
      return 'blocked';
    case 'manager_validation':
      return 'pending';
    case 'file_ready':
      return 'ready';
    case 'file_building':
      // Un brouillon avec des contrôles bloquants attend une correction ; sans, il attend d'être enregistré ou validé.
      return l.montage && l.montage.blocking > 0 ? 'blocked' : 'pending';
    default:
      return null;
  }
}

/** Date de référence de la ligne : celle de la transmission réussie, sinon la dernière mise à jour du dossier. */
export const txDateOf = (l: Pick<LeadRow, 'conversion' | 'montage' | 'receivedAtMs'>): number => l.conversion?.convertedAtMs ?? l.montage?.updatedAtMs ?? l.receivedAtMs;

export interface TxFilters {
  status: TxStatus | '';
  product: string;
  /** uid du télépro ; vide = tous. */
  owner: string;
  /** Période incluse (instants) ; null = sans borne. */
  fromMs: number | null;
  toMs: number | null;
}

export const NO_TX_FILTERS: TxFilters = { status: '', product: '', owner: '', fromMs: null, toMs: null };

export interface TxKpis {
  /** Transmis dans la période (par défaut le mois). */
  done: number;
  /** Rapport transmis / (transmis + en erreur) sur la période ; null sans aucune tentative. */
  successRate: number | null;
  pending: number;
  blocked: number;
}

export interface TxBoard {
  rows: LeadRow[];
  /** Lignes après filtres (avant pagination). */
  filtered: LeadRow[];
  kpis: TxKpis;
  products: string[];
  /** Dernière transmission réussie (la plus récente). */
  lastDone: LeadRow | null;
}

const inPeriod = (ms: number, f: Pick<TxFilters, 'fromMs' | 'toMs'>) => (f.fromMs === null || ms >= f.fromMs) && (f.toMs === null || ms <= f.toMs);

export function buildTxBoard(all: readonly LeadRow[], filters: TxFilters, period: Pick<TxFilters, 'fromMs' | 'toMs'>): TxBoard {
  const rows = all.filter((l) => !l.excluded && txStatusOf(l) !== null);
  const status = (l: LeadRow) => txStatusOf(l) as TxStatus;

  const inRange = rows.filter((l) => inPeriod(txDateOf(l), period));
  const done = inRange.filter((l) => status(l) === 'done').length;
  const failing = inRange.filter((l) => l.status === 'transmission_error').length;
  const kpis: TxKpis = {
    done,
    successRate: done + failing > 0 ? Math.round((done / (done + failing)) * 1000) / 10 : null,
    // « En attente » et « bloqué » comptent tout ce qui attend une action, quelle que soit la période.
    pending: rows.filter((l) => status(l) === 'pending').length,
    blocked: rows.filter((l) => status(l) === 'blocked').length,
  };

  const filtered = rows
    .filter((l) => (!filters.status || status(l) === filters.status) && (!filters.product || l.productCode === filters.product) && (!filters.owner || l.ownerId === filters.owner) && inPeriod(txDateOf(l), filters))
    .sort((a, b) => TX_STATUS_ORDER.indexOf(status(a)) - TX_STATUS_ORDER.indexOf(status(b)) || txDateOf(b) - txDateOf(a));

  const dones = rows.filter((l) => status(l) === 'done').sort((a, b) => txDateOf(b) - txDateOf(a));
  return {
    rows,
    filtered,
    kpis,
    products: [...new Set(rows.map((l) => l.productCode).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, 'fr')),
    lastDone: dones[0] ?? null,
  };
}

/** Début du mois de `nowMs` et début du suivant (borne exclue côté appelant : on retire 1 ms). */
export function monthRange(nowMs: number): { fromMs: number; toMs: number } {
  const d = new Date(nowMs);
  return { fromMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), toMs: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1 };
}

/** Parcours d'un dossier (fig. 44 : Lead qualifié, Documents complets, Dossier validé, Client créé). */
export type StepState = 'done' | 'current' | 'todo';
export interface TxStep {
  key: 'lead' | 'documents' | 'validated' | 'client';
  label: string;
  state: StepState;
  /** « Validé », « En cours », « À faire » : mot affiché sous le libellé. */
  caption: string;
}

export function txSteps(l: Pick<LeadRow, 'status' | 'docs' | 'conversion'>): TxStep[] {
  const docsOk = !!l.docs && l.docs.mandatory > 0 && l.docs.mandatoryConform === l.docs.mandatory;
  const validated = l.status === 'file_ready' || l.status === 'transmitting' || l.status === 'transmission_error' || l.status === 'converted';
  const client = l.status === 'converted' && l.conversion?.state === 'confirmed';
  const raw: [TxStep['key'], string, boolean][] = [
    ['lead', 'Lead qualifié', true],
    ['documents', 'Documents complets', docsOk || validated],
    ['validated', 'Dossier validé', validated],
    ['client', 'Client créé', client],
  ];
  const firstTodo = raw.findIndex(([, , ok]) => !ok);
  return raw.map(([key, label, ok], i): TxStep => ({ key, label, state: ok ? 'done' : i === firstTodo ? 'current' : 'todo', caption: ok ? 'Validé' : i === firstTodo ? 'En cours' : 'À faire' }));
}
