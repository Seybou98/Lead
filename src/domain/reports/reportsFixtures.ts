// Données de test partagées par les rapports (télépros, documents). Réservé aux tests.
import type { LeadListItem } from '../leads/leadList';
import type { ReportCampaign, ReportFilters } from './direction';

export const DAY = 86_400_000;
export const T = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
export const SEP = { fromMs: T(2026, 9, 1, 0), toMs: T(2026, 10, 1, 0) };
export const F: ReportFilters = { ...SEP, mode: 'event', sourceId: '', campaignId: '', product: '', owner: '' };
export const NOW = T(2026, 9, 20);
export const camps: ReportCampaign[] = [{ id: 'c1', name: 'PAC IDF', sourceId: 'meta', productCode: 'PAC' }];

export const docs = (over: Partial<NonNullable<LeadListItem['docs']>> = {}): NonNullable<LeadListItem['docs']> => ({ expected: 4, received: 0, conform: 0, mandatory: 4, mandatoryConform: 0, toCheck: 0, missing: [], lastReceivedAtMs: null, completedAtMs: null, lastRequestAtMs: null, nextFollowUpAtMs: null, promisedAtMs: null, followUpCount: 0, ...over });

export const lead = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: id, phone: null, email: null, city: '', postalCode: '', campaignId: 'c1', productCode: 'PAC', status: 'new', temperature: null, assignmentState: 'assigned', bufferReason: null,
  ownerId: 'u1', receivedAtMs: T(2026, 9, 5), slaStartedAtMs: T(2026, 9, 5), slaStoppedAtMs: null, nextAction: null, documentsState: 'none', duplicate: false, excluded: false, ...over,
});

/** Lead vendu : documents complets le 8, vente le 10. */
export const sold = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => lead(id, {
  status: 'converted', documentsState: 'complete', slaStoppedAtMs: T(2026, 9, 5) + 60_000, docs: docs({ received: 4, conform: 4, mandatoryConform: 4, lastRequestAtMs: T(2026, 9, 6), lastReceivedAtMs: T(2026, 9, 8), completedAtMs: T(2026, 9, 8) }),
  conversion: { state: 'confirmed', clientId: '1', dossierId: 'd', convertedAtMs: T(2026, 9, 10) },
  montage: { validationState: 'none', blocking: 0, toConfirm: 0, totalTtcCents: 1, remainderCents: 0, updatedAtMs: T(2026, 9, 9) }, ...over,
});
