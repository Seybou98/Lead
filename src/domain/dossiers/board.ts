// Section « Dossiers » (§12.2, figs. 1-3) : les leads arrivés à la phase de montage, de la pièce complète à la
// transmission au CRM principal. Fonctions pures, sans Firestore : la liste lit les mêmes leads que « Mes leads ».

import type { LeadStatus } from '../enums';
import type { LeadRow } from '../leads/leadList';

/** Statuts d'un dossier, dans l'ordre du parcours (§11.10). */
export const DOSSIER_STATUSES: readonly LeadStatus[] = [
  'file_ready_to_build',
  'file_building',
  'manager_validation',
  'file_ready',
  'transmitting',
  'transmission_error',
  'converted',
];

export type DossierTab = 'all' | 'to_build' | 'building' | 'validation' | 'transmission' | 'converted';

export const DOSSIER_TABS: { key: DossierTab; label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'to_build', label: 'À monter' },
  { key: 'building', label: 'En montage' },
  { key: 'validation', label: 'Validation manager' },
  { key: 'transmission', label: 'Transmission' },
  { key: 'converted', label: 'Convertis' },
];

const TAB_STATUSES: Record<Exclude<DossierTab, 'all'>, readonly LeadStatus[]> = {
  to_build: ['file_ready_to_build'],
  building: ['file_building', 'file_ready'],
  validation: ['manager_validation'],
  transmission: ['transmitting', 'transmission_error'],
  converted: ['converted'],
};

/** Ordre d'urgence : ce qui attend une décision ou a échoué d'abord, les dossiers terminés en dernier. */
const URGENCY: Record<string, number> = {
  manager_validation: 0,
  transmission_error: 1,
  file_ready_to_build: 2,
  file_building: 3,
  file_ready: 4,
  transmitting: 5,
  converted: 6,
};

export const isDossier = (r: Pick<LeadRow, 'status'>): boolean => DOSSIER_STATUSES.includes(r.status);

export function dossierTabCounts(rows: readonly LeadRow[]): Record<DossierTab, number> {
  const out: Record<DossierTab, number> = { all: 0, to_build: 0, building: 0, validation: 0, transmission: 0, converted: 0 };
  for (const r of rows) {
    if (!isDossier(r)) continue;
    out.all += 1;
    for (const [tab, statuses] of Object.entries(TAB_STATUSES)) if (statuses.includes(r.status)) out[tab as DossierTab] += 1;
  }
  return out;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Dossiers de l'onglet, filtrés par la recherche (nom, téléphone, ville, produit, campagne), les plus urgents d'abord. */
export function filterDossiers(rows: readonly LeadRow[], tab: DossierTab, search: string): LeadRow[] {
  const q = norm(search.trim());
  const digits = search.replace(/\D/g, '');
  return rows
    .filter((r) => isDossier(r))
    .filter((r) => tab === 'all' || TAB_STATUSES[tab].includes(r.status))
    .filter((r) => {
      if (!q) return true;
      const hay = norm([r.fullName, r.city, r.postalCode, r.productCode ?? '', r.campaignName, r.ownerName, r.conversion?.clientId ?? ''].join(' '));
      return hay.includes(q) || (digits.length >= 4 && (r.phone ?? '').replace(/\D/g, '').includes(digits));
    })
    .sort((a, b) => (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9) || b.receivedAtMs - a.receivedAtMs);
}

/** Titre de la fiche dossier selon le statut (fil d'Ariane de la maquette : « Dossiers / Jean Dupont / Montage du dossier »). */
export function dossierStage(status: LeadStatus): { title: string; badge: string; tone: 'blue' | 'amber' | 'green' | 'red' } {
  switch (status) {
    case 'file_ready_to_build': return { title: 'Dossier prêt à monter', badge: 'À monter', tone: 'blue' };
    case 'file_building': return { title: 'Montage du dossier', badge: 'En cours', tone: 'blue' };
    case 'file_ready': return { title: 'Montage du dossier', badge: 'Prêt', tone: 'green' };
    case 'manager_validation': return { title: 'Validation de la vente', badge: 'Action requise', tone: 'amber' };
    case 'transmitting': return { title: 'Vente créée', badge: 'Transmission en cours', tone: 'blue' };
    case 'transmission_error': return { title: 'Vente créée', badge: 'Erreur de transmission', tone: 'red' };
    case 'converted': return { title: 'Vente créée', badge: 'Converti', tone: 'green' };
    default: return { title: 'Dossier', badge: status, tone: 'blue' };
  }
}
