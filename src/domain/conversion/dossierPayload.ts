// Création d'un dossier du CRM principal à partir d'une vente du CRM Leads (§11.3, §11.8, §24.7).
//
// Ce fichier REPREND la logique du CRM principal sans la réinventer : `handleImportedDossierSubmit` de
// src/components/clients/components/new-client-modal.tsx (charge utile du dossier et de la subvention),
// src/lib/utils/dossier-status.ts (statut du dossier), src/lib/dossier-auto-calculations.ts (zones, catégories,
// complétude) et src/lib/utils/search-index.ts (index de recherche). Les noms de champs sont ceux du CRM principal :
// ses écrans lisent ce document tel quel. En cas d'évolution côté CRM principal, mettre ce fichier à jour.
//
// Fonctions pures : aucune lecture ni écriture Firestore ici (functions/src/transmission.ts s'en charge).

import { splitFullName } from '../engine/normalize';
import { lineHtCents, lineTtcCents } from './finance';
import type { MontageDraft } from './montage';

// ── Zones et catégories (dossier-auto-calculations.ts) ───────────────────────

const getDepartmentFromPostalCode = (postalCode: unknown): string => {
  const raw = String(postalCode || '').trim();
  if (raw.length < 2) return '';
  return raw.startsWith('97') || raw.startsWith('98') ? raw.slice(0, 3) : raw.slice(0, 2);
};

export const getGeographicZoneFromPostalCode = (postalCode: unknown): string => {
  const department = getDepartmentFromPostalCode(postalCode);
  if (!department) return '';
  return ['75', '77', '78', '91', '92', '93', '94', '95'].includes(department) ? 'IDF' : 'Hors IDF';
};

export const getClimateZoneFromPostalCode = (postalCode: unknown): string => {
  const department = getDepartmentFromPostalCode(postalCode);
  if (!department) return '';
  const h1 = ['01', '02', '03', '05', '08', '10', '14', '15', '19', '21', '23', '25', '27', '28', '38', '39', '42', '43', '45', '51', '52', '54', '55', '57', '58', '59', '60', '61', '62', '63', '67', '68', '69', '70', '71', '73', '74', '75', '76', '77', '78', '80', '87', '88', '89', '90', '91', '92', '93', '94', '95'];
  const h2 = ['04', '07', '09', '12', '16', '17', '18', '22', '24', '26', '29', '31', '32', '33', '35', '36', '37', '40', '41', '44', '46', '47', '48', '49', '50', '53', '56', '64', '65', '72', '79', '81', '82', '84', '85', '86'];
  const h3 = ['06', '11', '13', '30', '34', '66', '83', '20'];
  if (h1.includes(department)) return 'H1';
  if (h2.includes(department)) return 'H2';
  if (h3.includes(department)) return 'H3';
  return '';
};

const IDF_MPR_THRESHOLDS = [[1, 23768, 28933, 40404], [2, 34884, 42463, 59281], [3, 41893, 51000, 71046], [4, 48914, 59549, 82839], [5, 55961, 68123, 94615]];
const OTHER_MPR_THRESHOLDS = [[1, 17363, 22259, 31185], [2, 25393, 32553, 45842], [3, 30540, 39148, 55196], [4, 35676, 45735, 64550], [5, 40835, 52348, 73907]];
const IDF_MPR_EXTRA = [7116, 8663, 12257];
const OTHER_MPR_EXTRA = [5151, 6598, 9357];

const getMprCategory = (rfr: unknown, persons: unknown, zone: string): string => {
  const income = Number(rfr || 0);
  if (!income) return '';
  const count = Math.max(1, Math.min(Number.parseInt(String(persons || 1), 10) || 1, 99));
  const idf = zone === 'IDF';
  const thresholds = idf ? IDF_MPR_THRESHOLDS : OTHER_MPR_THRESHOLDS;
  const extra = idf ? IDF_MPR_EXTRA : OTHER_MPR_EXTRA;
  const row = count <= 5 ? thresholds[count - 1] : [count, thresholds[4][1] + (count - 5) * extra[0], thresholds[4][2] + (count - 5) * extra[1], thresholds[4][3] + (count - 5) * extra[2]];
  if (income <= row[1]) return 'Bleu';
  if (income <= row[2]) return 'Jaune';
  if (income <= row[3]) return 'Violet';
  return 'Rose';
};

const getCeeCategoryFromMprCategory = (mprCategory: unknown): string => {
  const category = String(mprCategory || '').trim().toLowerCase();
  if (category === 'bleu') return 'Précarité';
  if (category === 'jaune') return 'Modeste';
  if (category === 'violet' || category === 'rose') return 'Classique';
  return '';
};

export function getFiscalCategoriesFromValues(v: { rfr?: unknown; persons?: unknown; postalCode?: unknown }) {
  const geographicZone = getGeographicZoneFromPostalCode(v.postalCode);
  const mprCategory = getMprCategory(v.rfr, v.persons, geographicZone);
  const ceeCategory = getCeeCategoryFromMprCategory(mprCategory);
  return { geographicZone, mprCategory, ceeCategory, precarite: ceeCategory };
}

// ── Statut du dossier (dossier-status.ts) ────────────────────────────────────

export type DossierStatusKey = 'incomplet' | 'complet' | 'valide' | 'brouillon' | 'complement_demande' | 'complement_traite' | 'abandonner';
export type DossierSubStatusKey = 'financement_a_faire' | 'comptant_a_payer';

const normalizeText = (value: unknown): string => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

const normalizeDossierType = (value: unknown): string => {
  const normalized = normalizeText(value).replace(/[\s+/-]+/g, '_');
  if (normalized.includes('financement')) return 'financement';
  if (normalized.includes('comptant')) return 'comptant';
  return normalized;
};

export const getDefaultDossierSubStatusByType = (typeDossier: unknown): DossierSubStatusKey | null => {
  const type = normalizeDossierType(typeDossier);
  if (type === 'financement') return 'financement_a_faire';
  if (type === 'comptant') return 'comptant_a_payer';
  return null;
};

function normalizeDossierStatus(value: unknown): DossierStatusKey | null {
  const n = normalizeText(value).replace(/[\s-]+/g, '_');
  if (n === 'complet' || n === 'complete') return 'complet';
  if (n === 'valide' || n === 'validated') return 'valide';
  if (n === 'brouillon' || n === 'draft') return 'brouillon';
  if (n === 'complement_demande' || n === 'complement_a_demander') return 'complement_demande';
  if (n === 'complement_traite' || n === 'complement_traitee') return 'complement_traite';
  if (n === 'abandonner' || n === 'abandonne' || n === 'abandoned') return 'abandonner';
  if (n === 'incomplet' || n === 'incomplet_a_completer') return 'incomplet';
  return null;
}

export function resolveDossierStatus(v: { status?: unknown; subventionStatus?: unknown; completenessScore?: unknown; draft?: boolean }): DossierStatusKey {
  if (v.draft) return 'brouillon';
  if (normalizeText(v.subventionStatus).replace(/\s+/g, '_') === 'controle_admin_valider') return 'valide';
  const status = normalizeDossierStatus(v.status);
  if (status === 'valide' || status === 'brouillon' || status === 'complement_demande' || status === 'complement_traite' || status === 'abandonner') return status;
  const score = Number(v.completenessScore);
  if (Number.isFinite(score) && score >= 100) return 'complet';
  if (status === 'complet') return 'complet';
  return 'incomplet';
}

// ── Index de recherche et numéro de dossier ──────────────────────────────────

/** Index `array-contains` de la recherche globale du CRM principal (search-index.ts). */
export function generateClientSearchIndex(firstName: string, lastName: string, email?: string, phone?: string): string[] {
  const terms: string[] = [];
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();
  fullName.toLowerCase().split(' ').forEach((word) => {
    if (word) terms.push(word);
  });
  if (fullName) terms.push(fullName.toLowerCase());
  if (email) terms.push(email.toLowerCase());
  if (phone) {
    terms.push(phone);
    const digitsOnly = phone.replace(/\D/g, '');
    if (digitsOnly) {
      terms.push(digitsOnly);
      for (let i = 2; i <= digitsOnly.length; i++) terms.push(digitsOnly.slice(0, i));
    }
  }
  return [...new Set(terms)];
}

/** Numéro à 7 chiffres : 2 premiers = année (« 26 »), 5 derniers aléatoires (unicité vérifiée par l'appelant). */
export const clientNumberCandidate = (now: Date, random: () => number = Math.random): string =>
  `${String(now.getFullYear() % 100).padStart(2, '0')}${String(Math.floor(random() * 100000)).padStart(5, '0')}`;

// ── Gestes et opérations (new-client-modal.tsx) ──────────────────────────────

const IMPORTED_GESTE_OPERATIONS: Record<string, { operation: string; bareme: string }> = {
  pac_air_eau: { operation: 'PAC air/eau', bareme: 'BAR-TH-171' },
  pac_air_air: { operation: 'PAC air/air', bareme: 'BAR-TH-129' },
  cet: { operation: 'Chauffe-eau thermodynamique (CET)', bareme: 'BAR-TH-148' },
  cesi: { operation: 'Chauffe-eau solaire individuel (CESI)', bareme: 'BAR-TH-101' },
  granules: { operation: 'Chaudière à granulés / bois bûches', bareme: 'BAR-TH-112' },
  poele_granules: { operation: 'Poêle à granulés', bareme: 'BAR-TH-106' },
  ssc: { operation: 'Système solaire combiné (SSC)', bareme: 'BAR-TH-143' },
  dst: { operation: 'DST', bareme: 'BAR-TH-168' },
  pv: { operation: 'Panneaux photovoltaïques', bareme: 'Hors CEE' },
};

const IMPORTED_OPERATION_PRESETS: Record<string, { operation: string; bareme: string; category: string }> = {
  pac_air_eau: { operation: 'Pompe à chaleur', bareme: 'BAR-TH-171', category: 'PAC' },
  pac_air_air: { operation: 'Pac Air Air', bareme: 'BAR-TH-129', category: 'PAC AIR AIR' },
  cet: { operation: 'Ballon thermodynamique', bareme: 'BAR-TH-148', category: 'BTD' },
  cesi: { operation: 'Ballon solaire', bareme: 'BAR-TH-101', category: 'BS' },
  granules: { operation: 'Chaudière à granulés', bareme: 'BAR-TH-112', category: 'CHAUDIERE' },
  poele_granules: { operation: 'Poêle à granulés', bareme: 'BAR-TH-106', category: 'POELE' },
  ssc: { operation: 'Système solaire combiné', bareme: 'BAR-TH-143', category: 'SSC' },
  dst: { operation: 'DST', bareme: 'BAR-TH-168', category: 'DST' },
  pv: { operation: 'PVT', bareme: '', category: 'PVT' },
};

/** Famille du catalogue principal (`products.category`) → geste du CRM principal. Inconnue : la famille en minuscules. */
export function gesteOfCategory(category: string | null | undefined): string {
  const c = normalizeText(category).replace(/\s+/g, ' ');
  if (!c) return 'autre';
  if (c === 'pac') return 'pac_air_eau';
  if (c === 'pac air air' || c === 'pac_ee') return 'pac_air_air';
  if (c === 'btd') return 'cet';
  if (c === 'bs' || c === 'cesi') return 'cesi';
  if (c === 'chaudiere') return 'granules';
  if (c === 'poele') return 'poele_granules';
  if (c === 'ssc') return 'ssc';
  if (c === 'dst') return 'dst';
  if (c === 'pvt' || c === 'pv') return 'pv';
  return c;
}

const toNumber = (value: unknown): number => Number(value || 0) || 0;

const normalizeImportedMprColor = (value: unknown): string => {
  const color = normalizeText(value);
  return color === 'bleu' || color === 'jaune' || color === 'violet' || color === 'rose' ? color : '';
};

export interface ImportedData {
  [key: string]: unknown;
  typeDossier: 'mpr' | 'mpr_cee' | 'cee' | 'financement' | 'comptant';
  gestes: string[];
}

/** Opérations de la subvention : les primes du dossier sont portées par la première opération (comme le CRM principal). */
export function buildImportedSubventionOperations(selectedGestes: string[], importedData: ImportedData) {
  const primeCeeTotal = toNumber(importedData.primeCeeEstimee);
  const shouldComputeMpr = importedData.typeDossier === 'mpr' || importedData.typeDossier === 'mpr_cee';
  const primeMprTotal = shouldComputeMpr ? toNumber(importedData.primeMprEstimee) : 0;
  const racTotal = toNumber(importedData.rac);
  return selectedGestes.map((gesture, index) => {
    const primeCee = index === 0 ? primeCeeTotal : 0;
    const rac = index === 0 ? racTotal : 0;
    const preset = IMPORTED_OPERATION_PRESETS[gesture] || IMPORTED_GESTE_OPERATIONS[gesture];
    const bareme = preset?.bareme || '';
    // Barème MPR automatique du CRM principal (mpr-aid-matrix) non repris : le montant vient du montage.
    const primeMpr = index === 0 ? primeMprTotal : 0;
    return {
      invoiceNumber: '',
      operation: preset?.operation || gesture,
      category: preset && 'category' in preset ? preset.category : '',
      bareme,
      baremeLabel: bareme,
      baremeConcerne: bareme,
      ficheCee: bareme,
      ceeCode: bareme,
      codeCee: bareme,
      codeCEE: bareme,
      prime: primeCee + primeMpr,
      primeCee,
      primeMpr,
      rac,
    };
  });
}

const importedCompletionScore = (data: ImportedData): number => {
  const keys = ['typeDossier', 'nomRegie', 'nomCommercial', 'civilite', 'nomNaissance', 'prenom', 'dateNaissance', 'email', 'tel1', 'spi', 'refAvis', 'rfr', 'nbPersonnes', 'adresse', 'codePostal', 'commune', 'typeLogement', 'surface', 'chauffageActuel', 'ecsActuel', 'dpe', 'gestes'];
  const completed = keys.filter((key) => {
    const value = data[key];
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && String(value).trim() !== '';
  }).length;
  return Math.round((completed / keys.length) * 100);
};

const mapImportedTypeDossierToTag = (typeDossier: unknown): string | null => {
  switch (String(typeDossier || '').trim()) {
    case 'mpr_cee': return 'MPR + CEE';
    case 'cee': return 'CEE';
    case 'financement': return 'Financement';
    case 'comptant': return 'Comptant';
    case 'mpr': return 'MPR';
    default: return null;
  }
};

// ── De la vente du CRM Leads au formulaire « dossier » du CRM principal ──────

export interface SaleToDossierInput {
  leadId: string;
  saleNumber: string;
  draft: MontageDraft;
  totals: { mprCents: number; ceeCents: number; remainderCents: number; totalTtcCents: number; discountCents: number };
  /** Famille du catalogue (`products.category`) de chaque article de l'offre, dans l'ordre des lignes ; null = hors catalogue. */
  lineCategories: (string | null)[];
  /** Pièces conformes du lead (codes). */
  conformDocs: string[];
  /** Pièces obligatoires non conformes (codes) : elles restent listées comme manquantes. */
  missingDocs: string[];
  owner: { id: string; firstName: string; lastName: string } | null;
  campaignName: string | null;
  consent: boolean | null;
  /** Dernière note utile du lead (en plus des notes commerciales du montage). */
  lastNote?: string | null;
  /** Attribution marketing du lead (§24.7) : d'où il vient. */
  marketing?: { campaignId: string | null; sourceId: string | null; platform: string | null; adsetId: string | null; adId: string | null; formId: string | null; externalId: string | null; receivedAtMs: number | null };
}

/** Type de dossier du CRM principal : financement par crédit, sinon MPR / CEE selon les aides, sinon comptant. */
export function dossierTypeOf(draft: MontageDraft, mprCents: number, ceeCents: number): ImportedData['typeDossier'] {
  if (draft.offer.financing.mode === 'credit') return 'financement';
  if (mprCents > 0 && ceeCents > 0) return 'mpr_cee';
  if (mprCents > 0) return 'mpr';
  if (ceeCents > 0) return 'cee';
  return 'comptant';
}

const euros = (cents: number): number => Math.round(cents) / 100;

/** Détail du règlement : mode, apport, organisme, montant financé (reste à charge moins apport quand c'est un crédit). */
function financingOf(i: SaleToDossierInput) {
  const f = i.draft.offer.financing;
  const remainder = Math.max(0, i.totals.remainderCents);
  const down = Math.min(f.downPaymentCents, remainder);
  return {
    mode: f.mode === 'credit' ? 'credit' : 'comptant',
    organisme: f.mode === 'credit' ? (f.organism ?? '') : '',
    apport: euros(down),
    montantFinance: f.mode === 'credit' ? euros(remainder - down) : 0,
    resteACharge: euros(i.totals.remainderCents),
  };
}

/** Prestations et montants de l'offre, ligne par ligne (HT, TVA, TTC), plus la remise. */
function offerOf(i: SaleToDossierInput) {
  return {
    lignes: i.draft.offer.lines.map((l) => ({ designation: l.label, prestation: l.service, quantite: l.qty, prixUnitaireHt: euros(l.unitHtCents), tva: l.vatRate, totalHt: euros(lineHtCents(l)), totalTtc: euros(lineTtcCents(l)), horsCatalogue: l.productId === null })),
    totalTtc: euros(i.totals.totalTtcCents),
    remise: euros(i.totals.discountCents),
    rge: i.draft.offer.rge,
  };
}

function marketingOf(i: SaleToDossierInput) {
  const m = i.marketing;
  return { campagne: i.campaignName ?? '', campagneId: m?.campaignId ?? null, source: m?.sourceId ?? null, plateforme: m?.platform ?? null, adsetId: m?.adsetId ?? null, adId: m?.adId ?? null, formId: m?.formId ?? null, identifiantExterne: m?.externalId ?? null, recuLe: m?.receivedAtMs ? new Date(m.receivedAtMs).toISOString() : null };
}

export function saleToImportedData(i: SaleToDossierInput): ImportedData {
  const d = i.draft;
  const { firstName, lastName } = splitFullName(d.identity.fullName);
  const rfr = d.aids.rfrCents === null ? '' : euros(d.aids.rfrCents);
  const gestes = [...new Set(i.lineCategories.map((c) => gesteOfCategory(c)))];
  const fiscal = getFiscalCategoriesFromValues({ rfr, persons: d.aids.householdSize, postalCode: d.identity.postalCode });
  const docs: Record<string, boolean> = {};
  for (const code of i.conformDocs) docs[code] = true;
  for (const code of i.missingDocs) docs[code] = false;
  const typeDossier = dossierTypeOf(d, i.totals.mprCents, i.totals.ceeCents);
  return {
    typeDossier,
    gestes,
    nomRegie: '',
    nomCommercial: i.owner ? `${i.owner.firstName} ${i.owner.lastName}`.trim() : '',
    civilite: '',
    prenom: firstName,
    nomUsage: lastName,
    nomNaissance: lastName,
    email: d.identity.email,
    tel1: d.identity.phone,
    adresse: d.identity.addressLine,
    codePostal: d.identity.postalCode,
    commune: d.identity.city,
    typeLogement: d.project.housingType,
    statutBeneficiaire: d.project.occupancy,
    residencePrincipale: d.project.occupancy === 'Propriétaire occupant' ? 'oui' : '',
    surface: d.project.livingAreaM2 ?? '',
    chauffageActuel: d.project.currentHeating,
    nbPersonnes: d.aids.householdSize ?? '',
    rfr,
    couleurMpr: fiscal.mprCategory,
    ceeProfile: fiscal.ceeCategory,
    delegationCee: d.aids.delegate,
    primeMprEstimee: euros(i.totals.mprCents),
    primeCeeEstimee: euros(i.totals.ceeCents),
    rac: euros(i.totals.remainderCents),
    autorisationRgpd: i.consent === true || d.consentConfirmed,
    cadastre: d.project.cadastralRef,
    parcellesCadastrales: d.project.cadastralRef,
    datePrevisite: d.project.previsitDate,
    docs,
    // Traçabilité vers le CRM Leads (§11.8)
    leadId: i.leadId,
    venteNumero: i.saleNumber,
    campagne: i.campaignName ?? '',
    // Notes commerciales (§11.8) : celles du montage puis la dernière note du lead.
    notesCommerciales: [d.notes.trim(), (i.lastNote ?? '').trim()].filter(Boolean).filter((x, k, a) => a.indexOf(x) === k).join('\n'),
    // Financement et prestations (§11.4, §11.8)
    financement: financingOf(i),
    offre: offerOf(i),
    attributionMarketing: marketingOf(i),
  };
}

// ── Charge utile du dossier et de la subvention (handleImportedDossierSubmit) ─

export interface DossierBuild {
  dossier: Record<string, unknown>;
  subvention: Record<string, unknown>;
  history: { action: string; clientName: string; details: string; newValue: string };
}

/** Retire les champs `undefined` (Firestore les refuse), comme `stripUndefinedForFirestore` du CRM principal. */
export function stripUndefined<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => { const c = stripUndefined(item); return c === undefined ? null : c; }) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = stripUndefined(v);
      if (c !== undefined) out[k] = c;
    }
    return out as T;
  }
  return value;
}

export function buildDossierFromImported(importedData: ImportedData, ctx: { clientNumber: string; now: Date; owner: SaleToDossierInput['owner']; ids: { leadId: string; saleNumber: string; dossierId: string; subventionId: string } }): DossierBuild {
  const { clientNumber, now } = ctx;
  const data = importedData as Record<string, unknown> & ImportedData;
  const numeroDossierMpr = String(data.numeroDossierMpr || data.numeroMpr || '').trim();
  const firstName = String(data.prenom || '').trim();
  const lastName = String(data.nomUsage || data.nomNaissance || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || 'Dossier sans nom';
  const completionScore = importedCompletionScore(data);
  const docsMap = (data.docs && typeof data.docs === 'object' ? data.docs : {}) as Record<string, boolean>;
  const missingDocuments = Object.entries(docsMap).filter(([, v]) => !v).map(([k]) => k);
  const selectedGestes = Array.isArray(data.gestes) ? data.gestes : [];
  const shouldComputeMpr = data.typeDossier === 'mpr' || data.typeDossier === 'mpr_cee';
  const primeMprEstimee = shouldComputeMpr ? data.primeMprEstimee : '';
  const tag = mapImportedTypeDossierToTag(data.typeDossier);
  const operations = buildImportedSubventionOperations(selectedGestes, data);
  const operationLabels = operations.map((o) => o.operation).filter(Boolean).join(', ');
  const postalCode = String(data.codePostal || data.cpZone || '');
  const geographicZone = getGeographicZoneFromPostalCode(postalCode);
  const climateZone = getClimateZoneFromPostalCode(postalCode);
  const initialSubventionStatus = 'incomplet_a_completer';
  const initialSubStatus = getDefaultDossierSubStatusByType(data.typeDossier);
  const dossierStatus = resolveDossierStatus({ status: initialSubventionStatus, completenessScore: completionScore });

  const dossierDetails = {
    importedForm: data,
    client: {
      birthDate: data.dateNaissance || '',
      familyStatus: data.situationFamiliale || data.couple || '',
      householdSize: data.nbPersonnes || '',
      consent: Boolean(data.autorisationRgpd || data.autorisationCommercial),
      leadOrigin: data.campagne || '',
    },
    housing: {
      fullAddress: data.adresse || '',
      postalCode,
      city: data.commune || '',
      climateZone,
      type: data.typeLogement || '',
      usage: data.residencePrincipale || '',
      residencePrincipale: data.residencePrincipale || '',
      beneficiaryStatus: data.statutBeneficiaire || '',
      lieuDit: data.lieuDit || '',
      constructionYear: data.anneeConstruction || '',
      livingArea: data.surface || '',
      currentHeating: data.chauffageActuel || data.chauffageAutre || '',
      heatingOther: data.chauffageAutre || '',
      currentHotWater: data.ecsActuel || data.ecsAutre || '',
      hotWaterOther: data.ecsAutre || '',
      dpe: data.dpe || '',
      energyLabel: data.dpeClasse || '',
      dpeYear: data.dpeAnnee || '',
      cadastralReference: data.cadastre || '',
      cadastralPlots: data.parcellesCadastrales || data.cadastre || '',
    },
    fiscal: {
      declaredRfr: data.rfr || '',
      taxNumber: data.spi || '',
      noticeReference: data.refAvis || '',
      householdSize: data.nbPersonnes || '',
      mprCategory: data.couleurMpr || '',
      ceeCategory: data.ceeProfile || '',
    },
    subvention: {
      type: data.typeDossier || '',
      globalStatus: dossierStatus,
      subStatus: initialSubStatus || '',
      estimatedMpr: primeMprEstimee || '',
      estimatedCee: data.primeCeeEstimee || '',
      estimatedRac: data.rac || '',
      financingRequested: data.typeDossier === 'financement',
    },
    mpr: { numeroDossierMpr, anahEmail: data.emailAnah || '', accountUsed: data.compteAnah || '', status: data.statutDemande || '' },
    cee: { type: data.coupDePouce || '', category: data.ceeProfile || '', delegation: data.delegationCee || '' },
    operation: { type: operationLabels, operation: operationLabels, product: operationLabels, rac: data.rac || '' },
    // Ce que le CRM Leads sait en plus (fig. 44 « Données transmises ») : financement, prestations, notes, attribution marketing.
    financing: data.financement || {},
    offer: data.offre || {},
    commercial: { notes: data.notesCommerciales || '' },
    marketing: data.attributionMarketing || {},
    autoCalculations: { completenessScore: completionScore, missingDocuments, mprCategory: data.couleurMpr || '', ceeCategory: data.ceeProfile || '', geographicZone, climateZone },
  };

  const dossier = stripUndefined({
    id: ctx.ids.dossierId,
    clientNumber,
    numeroDossier: clientNumber,
    numeroDossierMpr,
    numeroMpr: numeroDossierMpr,
    name: fullName,
    contact: {
      civility: '',
      firstName,
      lastName,
      email: data.email || '',
      anahEmail: data.emailAnah || '',
      phone: data.tel1 || '',
      secondaryEmail: '',
      secondaryPhone: data.tel2 || '',
      couple: data.couple || '',
      spouse: { firstName: data.coPrenom || '', lastName: data.coNom || '', birthDate: data.coDateNaissance || '', taxNumber: data.coSpi || '' },
    },
    address: { street: data.adresse || '', postalCode, city: data.commune || '', country: 'France' },
    tag,
    status: dossierStatus,
    ...(initialSubStatus ? { subStatus: initialSubStatus, dossierSubStatus: initialSubStatus } : {}),
    createdAt: now,
    updatedAt: now,
    team: null,
    productsIds: [],
    installation: { totalTime: 0, durationInHours: 0, durationInDays: 0, durationText: '0h (~0j)' },
    regie: data.nomRegie ? { id: '', name: data.nomRegie } : null,
    ...(ctx.owner ? { commercial: { id: ctx.owner.id, firstName: ctx.owner.firstName, lastName: ctx.owner.lastName } } : {}),
    RAC: { hasToCollect: false, amount: Number(data.rac || 0) || 0 },
    comment: String(data.notesCommerciales || ''),
    searchIndex: generateClientSearchIndex(firstName, lastName, String(data.email || ''), String(data.tel1 || '')),
    dossierDetails,
    rfr: data.rfr || '',
    numberOfPersons: data.nbPersonnes || '',
    precarite: data.ceeProfile || '',
    completenessScore: completionScore,
    missingDocuments,
    geographicZone,
    zone: climateZone,
    mprCategory: data.couleurMpr || '',
    couleurMpr: data.couleurMpr || '',
    categorieMpr: data.couleurMpr || '',
    ceeCategory: data.ceeProfile || '',
    questionnaireAnswers: {
      info: {
        housingType: data.typeLogement || '',
        typeLogement: data.typeLogement || '',
        residencePrincipale: data.residencePrincipale || '',
        statutBeneficiaire: data.statutBeneficiaire || '',
        lieuDit: data.lieuDit || '',
        surface: data.surface || '',
        constructionYear: data.anneeConstruction || '',
        anneeConstruction: data.anneeConstruction || '',
        chauffageActuel: data.chauffageActuel || '',
        chauffageAutre: data.chauffageAutre || '',
        ecsActuel: data.ecsActuel || '',
        ecsAutre: data.ecsAutre || '',
        dpe: data.dpe || '',
        dpeClasse: data.dpeClasse || '',
        dpeAnnee: data.dpeAnnee || '',
        // Le CRM principal lit la parcelle ici en premier (qaInfo.parcelCadastrale, puis parcellesCadastrales).
        parcelCadastrale: data.parcellesCadastrales || data.cadastre || '',
        parcellesCadastrales: data.parcellesCadastrales || data.cadastre || '',
        rfr: data.rfr || '',
        numberOfPersons: data.nbPersonnes || '',
      },
      workAddress: { street: data.adresse || '', postalCode, city: data.commune || '', country: 'France' },
    },
    subventionId: ctx.ids.subventionId,
    // Traçabilité : Lead ID → Vente ID → Dossier ID (§11.8). Champs ignorés par les écrans du CRM principal.
    source: 'crm-leads',
    leadId: ctx.ids.leadId,
    saleNumber: ctx.ids.saleNumber,
  }) as Record<string, unknown>;

  const color = normalizeImportedMprColor(data.couleurMpr || data.mprCategory || data.categorieMpr);
  const subvention = stripUndefined({
    id: ctx.ids.subventionId,
    ownerType: 'occupant',
    dossier: { numeroMpr: numeroDossierMpr, statut: initialSubventionStatus },
    numeroDossierMpr,
    numeroMpr: numeroDossierMpr,
    operations,
    color: color || null,
    couleurMpr: data.couleurMpr || '',
    mprCategory: data.couleurMpr || '',
    categorieMpr: data.couleurMpr || '',
    mpr: dossierDetails.mpr,
    cee: dossierDetails.cee,
    subventionDetails: dossierDetails.subvention,
    primeCeeTotal: Number(data.primeCeeEstimee || 0) || 0,
    primeMprTotal: Number(primeMprEstimee || 0) || 0,
    racTotal: Number(data.rac || 0) || 0,
    clientId: ctx.ids.dossierId,
    dossierId: ctx.ids.dossierId,
    createdAt: now,
    updatedAt: now,
  }) as Record<string, unknown>;

  return { dossier, subvention, history: { action: 'client_created', clientName: fullName, details: `Nouveau dossier N°: ${clientNumber}`, newValue: 'Dossier créé' } };
}
