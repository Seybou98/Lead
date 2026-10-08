// Brouillon du montage d'un dossier (§11.4) : cinq étapes — Identité, Projet & logement, Aides & éligibilité,
// Offre & financement, Vérifications. Le brouillon est enregistrable à tout moment, même incomplet ; seuls les
// contrôles (controls.ts) décident si la vente peut être créée.

import { parseEuroCents, type OfferLine } from './finance';

export const MONTAGE_STEPS = [
  { key: 'identity', label: 'Identité' },
  { key: 'project', label: 'Projet & logement' },
  { key: 'aids', label: 'Aides & éligibilité' },
  { key: 'offer', label: 'Offre & financement' },
  { key: 'checks', label: 'Vérifications' },
] as const;
export type MontageStep = (typeof MONTAGE_STEPS)[number]['key'];

export const ELIGIBILITY = ['validated', 'to_confirm', 'refused'] as const;
export type Eligibility = (typeof ELIGIBILITY)[number];
export const FINANCING_MODES = ['cash', 'credit'] as const;
export type FinancingMode = (typeof FINANCING_MODES)[number];

export interface MontageDraft {
  identity: { fullName: string; phone: string; email: string; addressLine: string; postalCode: string; city: string };
  project: {
    housingType: string;
    occupancy: string;
    livingAreaM2: number | null;
    currentHeating: string;
    climateZone: string;
    cadastralRef: string;
    previsitDate: string;
  };
  aids: {
    mprCents: number;
    ceeCents: number;
    /** Délégataire / mandataire CEE. */
    delegate: string;
    rfrCents: number | null;
    householdSize: number | null;
    eligibility: Eligibility | null;
    /** Contrôle de double valorisation CEE exécuté (§11.5), obligatoire dès qu'un montant CEE est saisi. */
    ceeDoubleChecked: boolean;
  };
  offer: {
    lines: OfferLine[];
    discountCents: number;
    /** Organisme de financement (Floa, Domofinance, Sofinco…) ; libre, utile quand le règlement est un crédit. */
    financing: { mode: FinancingMode; downPaymentCents: number; organism?: string };
    /** Qualification RGE de l'installateur pour l'opération : null = non renseignée. */
    rge: boolean | null;
  };
  /** Consentement du client confirmé pendant le montage (en plus de celui déclaré par la source). */
  consentConfirmed: boolean;
  notes: string;
}

export const emptyDraft = (): MontageDraft => ({
  identity: { fullName: '', phone: '', email: '', addressLine: '', postalCode: '', city: '' },
  project: { housingType: '', occupancy: '', livingAreaM2: null, currentHeating: '', climateZone: '', cadastralRef: '', previsitDate: '' },
  aids: { mprCents: 0, ceeCents: 0, delegate: '', rfrCents: null, householdSize: null, eligibility: null, ceeDoubleChecked: false },
  offer: { lines: [], discountCents: 0, financing: { mode: 'cash', downPaymentCents: 0, organism: '' }, rge: null },
  consentConfirmed: false,
  notes: '',
});

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const cents = (v: unknown, max = 100_000_000): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(max, Math.max(0, n));
};
const optInt = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const MAX_LINES = 30;

/** Reconstruit un brouillon sûr à partir d'une entrée quelconque : types, bornes et longueurs imposés. */
export function sanitizeDraft(raw: unknown): MontageDraft {
  const r = rec(raw);
  const id = rec(r.identity);
  const pr = rec(r.project);
  const ai = rec(r.aids);
  const of = rec(r.offer);
  const fin = rec(of.financing);
  const lines: OfferLine[] = (Array.isArray(of.lines) ? of.lines : []).slice(0, MAX_LINES).map((l, i) => {
    const o = rec(l);
    const vat = typeof o.vatRate === 'number' && o.vatRate >= 0 && o.vatRate <= 30 ? o.vatRate : 20;
    return {
      id: str(o.id, 60) || `line_${i + 1}`,
      productId: typeof o.productId === 'string' && o.productId ? o.productId.slice(0, 80) : null,
      label: str(o.label, 160),
      service: str(o.service, 80),
      qty: typeof o.qty === 'number' && o.qty > 0 && o.qty <= 1000 ? Math.round(o.qty * 100) / 100 : 1,
      unitHtCents: cents(o.unitHtCents),
      vatRate: vat,
    };
  });
  const eligibility = (ELIGIBILITY as readonly unknown[]).includes(ai.eligibility) ? (ai.eligibility as Eligibility) : null;
  const mode = fin.mode === 'credit' ? 'credit' : 'cash';
  return {
    identity: { fullName: str(id.fullName, 120), phone: str(id.phone, 30), email: str(id.email, 120).toLowerCase(), addressLine: str(id.addressLine, 160), postalCode: str(id.postalCode, 10), city: str(id.city, 80) },
    project: {
      housingType: str(pr.housingType, 60),
      occupancy: str(pr.occupancy, 60),
      livingAreaM2: optInt(pr.livingAreaM2, 1, 5000),
      currentHeating: str(pr.currentHeating, 80),
      climateZone: str(pr.climateZone, 10),
      cadastralRef: str(pr.cadastralRef, 60),
      previsitDate: /^\d{4}-\d{2}-\d{2}$/.test(str(pr.previsitDate, 10)) ? str(pr.previsitDate, 10) : '',
    },
    aids: {
      mprCents: cents(ai.mprCents),
      ceeCents: cents(ai.ceeCents),
      delegate: str(ai.delegate, 120),
      rfrCents: ai.rfrCents === null || ai.rfrCents === undefined ? null : cents(ai.rfrCents),
      householdSize: optInt(ai.householdSize, 1, 30),
      eligibility,
      ceeDoubleChecked: ai.ceeDoubleChecked === true,
    },
    offer: { lines, discountCents: cents(of.discountCents), financing: { mode, downPaymentCents: cents(fin.downPaymentCents), organism: str(fin.organism, 80) }, rge: typeof of.rge === 'boolean' ? of.rge : null },
    consentConfirmed: r.consentConfirmed === true,
    notes: str(r.notes, 2000),
  };
}

interface LeadSeed {
  fullName: string;
  phone: string | null;
  email: string | null;
  address: { line?: string; postalCode?: string | null; city?: string };
  qualification: Record<string, unknown>;
}

const OCCUPANCY: Record<string, string> = { owner: 'Propriétaire occupant', oui: 'Propriétaire occupant', true: 'Propriétaire occupant', tenant: 'Locataire', non: 'Locataire' };

/** Premier brouillon : reprend ce que le lead sait déjà, pour qu'il n'y ait aucune ressaisie (§11.4). */
export function draftFromLead(lead: LeadSeed): MontageDraft {
  const d = emptyDraft();
  const q = lead.qualification ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = q[k];
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'non_renseigne') return v;
    }
    return null;
  };
  d.identity = { fullName: lead.fullName ?? '', phone: lead.phone ?? '', email: lead.email ?? '', addressLine: lead.address?.line ?? '', postalCode: lead.address?.postalCode ?? '', city: lead.address?.city ?? '' };
  const owner = pick('isHomeOwner', 'ownerType');
  d.project.occupancy = owner === null ? '' : (OCCUPANCY[String(owner).toLowerCase()] ?? String(owner));
  d.project.currentHeating = String(pick('currentHeatingType', 'heatingMode') ?? '');
  const area = pick('houseSurface', 'livingArea');
  const areaN = area === null ? NaN : Number(area);
  d.project.livingAreaM2 = Number.isFinite(areaN) && areaN > 0 ? areaN : null;
  const persons = Number(pick('numberOfPersons') ?? NaN);
  d.aids.householdSize = Number.isFinite(persons) && persons > 0 ? persons : null;
  const rfr = parseEuroCents(pick('rfr'));
  d.aids.rfrCents = rfr !== null && rfr > 0 ? rfr : null;
  return d;
}
