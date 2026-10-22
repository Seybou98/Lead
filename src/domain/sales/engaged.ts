// Ventes engagées (« Conclure maintenant », §23.1) : le client a accepté l'offre pendant l'appel, mais la vente n'est PAS
// créée tant que le dossier n'est pas monté et que les pièces obligatoires ne sont pas conformes. Ces leads ne sont donc
// jamais comptés comme des ventes (rapports, colonnes À signer / À sécuriser) : ils ont leur propre liste, avec ce qui
// manque et le temps écoulé depuis l'engagement. Fonctions pures, partagées par l'espace Ventes et le cockpit.

import type { LeadListItem } from '../leads/leadList';

const DAY = 24 * 60 * 60_000;

/** Délai au-delà duquel une vente engagée sans dossier complet devient un point d'attention du cockpit. */
export const ENGAGED_ALERT_DAYS = 3;

type EngagedLead = Pick<LeadListItem, 'directSale' | 'conversion' | 'excluded' | 'status'>;

/** Vente engagée en cours : montage ouvert depuis l'appel, aucune vente créée, lead ni exclu ni clos. */
export function isEngagedSale(l: EngagedLead): boolean {
  return l.directSale === true && !l.conversion && !l.excluded && (l.status === 'file_building' || l.status === 'file_ready');
}

/** Instant de l'engagement : le changement de statut qui a arrêté le SLA (à défaut, la réception du lead). */
export const engagedSinceMs = (l: Pick<LeadListItem, 'slaStoppedAtMs' | 'receivedAtMs'>): number => l.slaStoppedAtMs ?? l.receivedAtMs;

export interface EngagedInfo {
  sinceMs: number;
  /** Pièces obligatoires non encore conformes (null quand aucune pièce n'a été demandée). */
  missingDocs: number | null;
  /** Les pièces obligatoires sont toutes conformes : la vente peut être créée dès que le montage est prêt. */
  readyToCreate: boolean;
  /** Engagement plus ancien que le délai du cockpit, avec un dossier encore incomplet. */
  late: boolean;
}

export function engagedInfo(l: Pick<LeadListItem, 'slaStoppedAtMs' | 'receivedAtMs' | 'docs'>, nowMs: number): EngagedInfo {
  const sinceMs = engagedSinceMs(l);
  const d = l.docs;
  const hasDocs = !!d && d.mandatory > 0;
  const missingDocs = hasDocs ? d.mandatory - d.mandatoryConform : null;
  const readyToCreate = hasDocs && missingDocs === 0;
  return { sinceMs, missingDocs, readyToCreate, late: !readyToCreate && nowMs - sinceMs > ENGAGED_ALERT_DAYS * DAY };
}

/** Ventes engagées, les plus anciennes d'abord ; `ready` en dernier (elles n'attendent plus que le montage). */
export function buildEngagedSales<T extends LeadListItem>(rows: readonly T[], f: { nowMs: number; mineOnly?: boolean; uid?: string; search?: string }): { row: T; info: EngagedInfo }[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return rows
    .filter((r) => isEngagedSale(r) && (!f.mineOnly || r.ownerId === f.uid) && (!q || `${r.fullName} ${r.city}`.toLowerCase().includes(q)))
    .map((row) => ({ row, info: engagedInfo(row, f.nowMs) }))
    .sort((a, b) => Number(a.info.readyToCreate) - Number(b.info.readyToCreate) || a.info.sinceMs - b.info.sinceMs);
}
