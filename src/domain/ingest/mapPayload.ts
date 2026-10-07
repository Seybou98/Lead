// Transformation d'un payload entrant (Pabbly, Meta, formulaire, import) en lead normalisé (§24.2 étapes 3-4).
// Reprend les synonymes de champs déjà gérés par l'ancien webhook, pour que les automatisations
// Pabbly existantes puissent être rebranchées sans être reconfigurées.

import { joinFullName, normalizeEmail, normalizePhone, normalizePostalCode, splitFullName } from '../engine/normalize';

export interface MappedLead {
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  /** Valeurs brutes, conservées pour comprendre un rejet. */
  phoneRaw: string | null;
  emailRaw: string | null;
  address: { line: string; postalCode: string | null; city: string };
  zone: string | null;
  productCode: string | null;
  campaign: { id: string | null; externalId: string | null; name: string | null };
  externalId: string | null;
  platform: string | null;
  adsetId: string | null;
  adId: string | null;
  formId: string | null;
  costCents: number | null;
  consent: boolean | null;
  /** Réponses de qualification connues (logement, foyer…). */
  qualification: Record<string, unknown>;
}

/** Champ normalisé → noms acceptés dans le payload (le premier présent l'emporte). */
const SYNONYMS: Record<string, string[]> = {
  fullName: ['fullName', 'full_name', 'name', 'nom_complet'],
  firstName: ['firstName', 'first_name', 'prenom', 'Prénom', 'Prenom'],
  lastName: ['lastName', 'last_name', 'nom', 'Nom'],
  email: ['email', 'Email', 'email_address', 'emailAddress', 'e-mail'],
  phone: ['phone', 'Phone', 'phone_number', 'phoneNumber', 'mobile', 'telephone', 'téléphone', 'tel'],
  addressLine: ['address', 'addressLine', 'street_address', 'adresse', 'workAddress'],
  postalCode: ['postalCode', 'postal_code', 'zip', 'zip_code', 'code_postal', 'cp'],
  city: ['city', 'ville'],
  zone: ['zone', 'Zone'],
  productCode: ['productCode', 'product', 'produit'],
  campaignId: ['campaignId', 'campaign_id'],
  campaignExternalId: ['campaignExternalId', 'campaign_external_id'],
  campaignName: ['campaign', 'campaign_name', 'campagne'],
  externalId: ['externalId', 'external_id', 'leadgen_id', 'lead_id'],
  platform: ['platform', 'plateforme'],
  adsetId: ['adsetId', 'adset_id', 'ad_set_id'],
  adId: ['adId', 'ad_id'],
  formId: ['formId', 'form_id'],
  cost: ['cost', 'costEuros', 'cout'],
  consent: ['consent', 'Consentement', 'consentement'],
};

/**
 * Champs de qualification repris dans `qualification` : nom normalisé → noms acceptés en entrée.
 * Couvre tous les champs que l'ancien webhook lisait, pour qu'aucune donnée envoyée par les
 * sources existantes ne soit perdue.
 */
const QUALIFICATION_FIELDS: Record<string, string[]> = {
  isHomeOwner: ['isHomeOwner'],
  ownerType: ['ownerType'],
  currentHeatingType: ['currentHeatingType'],
  heatingMode: ['heatingMode'],
  hotWaterMode: ['hotWaterMode'],
  houseSurface: ['houseSurface'],
  constructionYear: ['constructionYear'],
  electricalTension: ['electricalTension'],
  numberOfPersons: ['numberOfPersons'],
  rfr: ['rfr'],
  anneeRevenu: ['anneeRevenu'],
  numeroFiscal: ['numeroFiscal'],
  montantFacturesEnergetiques: ['montantFacturesEnergetiques'],
  apartmentSituation: ['apartmentSituation', 'apartment_situation'],
  climInstallationTiming: ['climInstallationTiming', 'clim_installation_timing'],
  lastMaintenanceDate: ['Last_maintenance_date', 'lastMaintenanceDate', 'last_maintenance_date'],
  estimationMin: ['estimationMin', 'estimation_min', 'Estimation min'],
  estimationMax: ['estimationMax', 'estimation_max', 'Estimation max'],
  consentTimestamp: ['consentTimestamp', 'consent_timestamp', 'Horodatage consentement'],
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pabbly enveloppe parfois le contenu dans `data` ou `payload`. */
export function unwrapPayload(raw: unknown): Record<string, unknown> {
  const top = asRecord(raw) ?? {};
  return asRecord(top.data) ?? asRecord(top.payload) ?? top;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function pick(source: Record<string, unknown>, target: string): string | null {
  for (const key of SYNONYMS[target] ?? [target]) {
    const v = str(source[key]);
    if (v !== null) return v;
  }
  return null;
}

/** « 12,50 » ou 12.5 → 1250 centimes ; null si illisible ou négatif. */
export function parseCostCents(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.').replace(/€/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function parseConsent(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  if (['true', '1', 'oui', 'yes', 'y', 'accepted', 'accepté'].includes(s)) return true;
  if (['false', '0', 'non', 'no', 'n', 'refused', 'refusé'].includes(s)) return false;
  return null;
}

/**
 * @param fieldMapping mapping propre à la source : { champEntrant: champNormalisé } (Source.fieldMapping).
 *   Il a priorité sur les synonymes.
 */
export function mapPayload(rawPayload: unknown, fieldMapping: Record<string, string> = {}): MappedLead {
  const payload = unwrapPayload(rawPayload);

  // Le mapping de la source est appliqué d'abord : il écrase les synonymes.
  const source: Record<string, unknown> = { ...payload };
  for (const [incoming, target] of Object.entries(fieldMapping)) {
    if (payload[incoming] !== undefined && payload[incoming] !== null) source[target] = payload[incoming];
  }

  const phoneRaw = pick(source, 'phone');
  const emailRaw = pick(source, 'email');

  let firstName = pick(source, 'firstName') ?? '';
  let lastName = pick(source, 'lastName') ?? '';
  let fullName = pick(source, 'fullName') ?? '';
  if (fullName && !firstName && !lastName) ({ firstName, lastName } = splitFullName(fullName));
  if (!fullName) fullName = joinFullName(firstName, lastName);

  const qualification: Record<string, unknown> = {};
  for (const [target, names] of Object.entries(QUALIFICATION_FIELDS)) {
    for (const name of names) {
      const v = source[name];
      if (v !== undefined && v !== null && v !== '') {
        qualification[target] = v;
        break;
      }
    }
  }

  const postal = pick(source, 'postalCode');

  return {
    fullName,
    firstName,
    lastName,
    phone: normalizePhone(phoneRaw),
    email: normalizeEmail(emailRaw),
    phoneRaw,
    emailRaw,
    address: { line: pick(source, 'addressLine') ?? '', postalCode: normalizePostalCode(postal), city: pick(source, 'city') ?? '' },
    zone: pick(source, 'zone'),
    productCode: pick(source, 'productCode'),
    campaign: {
      id: pick(source, 'campaignId'),
      externalId: pick(source, 'campaignExternalId'),
      name: pick(source, 'campaignName'),
    },
    externalId: pick(source, 'externalId'),
    platform: pick(source, 'platform'),
    adsetId: pick(source, 'adsetId'),
    adId: pick(source, 'adId'),
    formId: pick(source, 'formId'),
    costCents: parseCostCents(pick(source, 'cost')),
    consent: parseConsent(pick(source, 'consent')),
    qualification,
  };
}
