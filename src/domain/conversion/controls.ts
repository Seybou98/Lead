// Verrou de conversion (§11.2) et exceptions (§11.6). Fonction pure : à partir du brouillon, du lead et du résumé
// documentaire, rend la liste des contrôles et ce qu'il faut pour créer la vente.
//
//   blocking    contrôle obligatoire manquant : le télépro corrige, personne ne peut passer outre ;
//   to_confirm  exception (remise hors seuil, éligibilité incertaine, réserve sur une pièce, produit hors
//               catalogue, consentement manquant) : une demande de validation est adressée au manager.

import { computeRecap, formatEuros, type Recap } from './finance';
import type { MontageDraft, MontageStep } from './montage';

export interface ConversionRules {
  /** Remise maximale, en % du prix TTC, au-delà de laquelle une validation manager est exigée. */
  maxDiscountPct: number;
  /** Éligibilité aux aides : sans résultat validé, la vente passe par une exception manager. */
  requireEligibility: boolean;
  requireRge: boolean;
  /** Consentement du client : absent, la vente passe par une exception manager. */
  requireConsent: boolean;
}

export const DEFAULT_CONVERSION_RULES: ConversionRules = { maxDiscountPct: 5, requireEligibility: true, requireRge: true, requireConsent: true };

export type ControlLevel = 'ok' | 'to_confirm' | 'blocking';
export type ControlKey = 'identity' | 'project' | 'eligibility' | 'offer' | 'documents' | 'consent' | 'discount' | 'catalog' | 'cee' | 'rge' | 'amounts';

export interface Control {
  key: ControlKey;
  label: string;
  level: ControlLevel;
  /** Explication visible : ce qui manque, ou ce qui est validé. */
  detail: string;
  step: MontageStep;
  /** Exception : « moyenne » ou « bloquante » pour l'affichage du manager (fig. 2). */
  severity?: 'medium' | 'high';
}

export interface ControlInput {
  lead: { consent: boolean | null; productCode: string | null };
  draft: MontageDraft;
  docs: { mandatory: number; mandatoryConform: number; withReserve: number };
  /** Champs obligatoires de qualification du produit encore vides (libellés), calculés par l'appelant. */
  qualificationMissing: readonly string[];
  rules: ConversionRules;
}

export interface ControlReport {
  controls: Control[];
  recap: Recap;
  blocking: Control[];
  toConfirm: Control[];
  validated: number;
  total: number;
  /** Aucun contrôle bloquant : une demande de validation peut être envoyée s'il y a des exceptions. */
  clean: boolean;
  /** Empreinte des exceptions et du prix : une approbation du manager ne vaut que pour cette empreinte. */
  fingerprint: string;
}

const list = (items: readonly string[]) => items.join(', ');

export function evaluateControls(input: ControlInput): ControlReport {
  const { draft, rules } = input;
  const recap = computeRecap(draft.offer.lines, draft.aids.mprCents, draft.aids.ceeCents, draft.offer.discountCents);
  const out: Control[] = [];
  const add = (c: Control) => out.push(c);

  // Identité et coordonnées
  const idMissing: string[] = [];
  if (!draft.identity.fullName) idMissing.push('nom');
  if (!draft.identity.phone && !draft.identity.email) idMissing.push('téléphone ou email');
  if (!draft.identity.addressLine) idMissing.push('adresse');
  if (!draft.identity.postalCode) idMissing.push('code postal');
  if (!draft.identity.city) idMissing.push('ville');
  add(idMissing.length ? { key: 'identity', label: 'Identité complète', level: 'blocking', detail: `À compléter : ${list(idMissing)}.`, step: 'identity' } : { key: 'identity', label: 'Identité complète', level: 'ok', detail: 'Nom, coordonnées et adresse renseignés.', step: 'identity' });

  // Projet et logement
  const pr = draft.project;
  const prMissing: string[] = [];
  if (!input.lead.productCode) prMissing.push('produit du lead');
  if (!pr.housingType) prMissing.push('type de logement');
  if (!pr.occupancy) prMissing.push("statut d'occupation");
  if (pr.livingAreaM2 === null) prMissing.push('surface habitable');
  if (!pr.currentHeating) prMissing.push('chauffage actuel');
  prMissing.push(...input.qualificationMissing);
  add(prMissing.length ? { key: 'project', label: 'Projet et logement renseignés', level: 'blocking', detail: `À compléter : ${list(prMissing)}.`, step: 'project' } : { key: 'project', label: 'Projet et logement renseignés', level: 'ok', detail: 'Tous les champs obligatoires du produit sont complétés.', step: 'project' });

  // Éligibilité aux aides
  const el = draft.aids.eligibility;
  if (el === 'validated') add({ key: 'eligibility', label: 'Éligibilité aux aides', level: 'ok', detail: 'Résultat validé.', step: 'aids' });
  else if (el === 'refused') add({ key: 'eligibility', label: 'Éligibilité aux aides', level: 'blocking', detail: 'Le dossier est inéligible : la vente ne peut pas être créée.', step: 'aids' });
  else if (rules.requireEligibility) add({ key: 'eligibility', label: 'Éligibilité aux aides', level: 'to_confirm', severity: 'medium', detail: el === 'to_confirm' ? 'Éligibilité à confirmer : dérogation du manager requise.' : "Aucun résultat d'éligibilité : dérogation du manager requise.", step: 'aids' });
  else add({ key: 'eligibility', label: 'Éligibilité aux aides', level: 'ok', detail: "Contrôle d'éligibilité non exigé.", step: 'aids' });

  // Offre
  const lines = draft.offer.lines;
  const badLine = lines.find((l) => !l.label || l.qty <= 0 || l.unitHtCents <= 0);
  if (lines.length === 0) add({ key: 'offer', label: 'Offre complète', level: 'blocking', detail: "Ajoutez au moins un produit à l'offre.", step: 'offer' });
  else if (badLine) add({ key: 'offer', label: 'Offre complète', level: 'blocking', detail: `La ligne « ${badLine.label || 'sans nom'} » est incomplète (nom, quantité ou prix).`, step: 'offer' });
  else add({ key: 'offer', label: 'Offre complète', level: 'ok', detail: `${lines.length} produit${lines.length > 1 ? 's' : ''} pour ${formatEuros(recap.totalTtcCents)} TTC.`, step: 'offer' });

  // Produit ou tarif hors catalogue
  const offCatalog = lines.filter((l) => l.productId === null && l.label);
  if (offCatalog.length) add({ key: 'catalog', label: 'Produits du catalogue', level: 'to_confirm', severity: 'high', detail: `Hors catalogue : ${list(offCatalog.map((l) => l.label))}. Aucune vente sans accord explicite du manager.`, step: 'offer' });

  // Remise
  if (recap.discountCents > 0) {
    if (recap.discountPct > rules.maxDiscountPct) add({ key: 'discount', label: 'Remise commerciale', level: 'to_confirm', severity: 'medium', detail: `Remise de ${recap.discountPct} % du prix TTC, au-delà du seuil de ${rules.maxDiscountPct} %.`, step: 'offer' });
    else add({ key: 'discount', label: 'Remise commerciale', level: 'ok', detail: `${recap.discountPct} % du prix TTC (seuil ${rules.maxDiscountPct} %).`, step: 'offer' });
  }

  // Cohérence des montants
  if (lines.length > 0 && recap.remainderCents < 0) add({ key: 'amounts', label: 'Montants cohérents', level: 'blocking', detail: `Les aides et la remise dépassent le prix TTC de ${formatEuros(-recap.remainderCents)}.`, step: 'offer' });

  // CEE : délégataire et double valorisation
  if (recap.ceeCents > 0) {
    const ceeMissing: string[] = [];
    if (!draft.aids.delegate) ceeMissing.push('délégataire CEE');
    if (!draft.aids.ceeDoubleChecked) ceeMissing.push('contrôle de double valorisation CEE');
    add(ceeMissing.length ? { key: 'cee', label: 'Opération CEE', level: 'blocking', detail: `À faire avant la vente : ${list(ceeMissing)}.`, step: 'aids' } : { key: 'cee', label: 'Opération CEE', level: 'ok', detail: `Délégataire ${draft.aids.delegate}, double valorisation contrôlée.`, step: 'aids' });
  }

  // Qualification RGE
  if (rules.requireRge && lines.length > 0) {
    if (draft.offer.rge === true) add({ key: 'rge', label: 'Qualification RGE', level: 'ok', detail: "Qualification RGE confirmée pour l'opération.", step: 'offer' });
    else add({ key: 'rge', label: 'Qualification RGE', level: 'blocking', detail: draft.offer.rge === false ? "Pas de qualification RGE pour cette opération : produit, prestation et aide sont incompatibles." : "Confirmez la qualification RGE de l'opération.", step: 'offer' });
  }

  // Documents
  const dMissing = input.docs.mandatory - input.docs.mandatoryConform;
  if (input.docs.mandatory === 0 || dMissing > 0) add({ key: 'documents', label: 'Documents obligatoires', level: 'blocking', detail: input.docs.mandatory === 0 ? "Aucun document obligatoire n'est défini pour ce dossier." : `${input.docs.mandatoryConform} / ${input.docs.mandatory} conformes : ${dMissing} à obtenir ou à corriger.`, step: 'checks' });
  else if (input.docs.withReserve > 0) add({ key: 'documents', label: 'Documents obligatoires', level: 'to_confirm', severity: 'medium', detail: `${input.docs.withReserve} document${input.docs.withReserve > 1 ? 's' : ''} validé${input.docs.withReserve > 1 ? 's' : ''} avec réserve : validation du manager requise.`, step: 'checks' });
  else add({ key: 'documents', label: 'Documents obligatoires', level: 'ok', detail: `${input.docs.mandatoryConform} / ${input.docs.mandatory} conformes.`, step: 'checks' });

  // Consentement
  if (rules.requireConsent) {
    if (input.lead.consent === true || draft.consentConfirmed) add({ key: 'consent', label: 'Consentement du client', level: 'ok', detail: input.lead.consent === true ? 'Consentement déclaré par la source.' : 'Consentement confirmé pendant le montage.', step: 'checks' });
    else add({ key: 'consent', label: 'Consentement du client', level: 'to_confirm', severity: 'high', detail: 'Consentement non confirmé : signature électronique à obtenir avant la vente.', step: 'checks' });
  }

  const blocking = out.filter((c) => c.level === 'blocking');
  const toConfirm = out.filter((c) => c.level === 'to_confirm');
  const exceptionKeys = toConfirm.map((c) => c.key).sort().join(',');
  return {
    controls: out,
    recap,
    blocking,
    toConfirm,
    validated: out.filter((c) => c.level === 'ok').length,
    total: out.length,
    clean: blocking.length === 0,
    fingerprint: `${exceptionKeys}|${recap.totalTtcCents}|${recap.discountCents}|${recap.mprCents}|${recap.ceeCents}`,
  };
}

export type ValidationState = 'none' | 'pending' | 'approved' | 'refused' | 'correction';

/**
 * La vente peut être créée : aucun contrôle bloquant, et soit aucune exception, soit une approbation du manager
 * portant sur la situation actuelle (toute modification de prix, d'aide ou d'exception l'annule).
 */
export function canCreateSale(report: ControlReport, validation: { state: ValidationState; fingerprint: string | null }): boolean {
  if (!report.clean) return false;
  if (report.toConfirm.length === 0) return true;
  return validation.state === 'approved' && validation.fingerprint === report.fingerprint;
}

/** Phrase qui explique pourquoi « Créer la vente » est grisé (fig. 1 : « 2 contrôles bloquants »). */
export function lockReason(report: ControlReport, validation: { state: ValidationState; fingerprint: string | null }): string | null {
  if (canCreateSale(report, validation)) return null;
  if (!report.clean) return `${report.blocking.length} contrôle${report.blocking.length > 1 ? 's' : ''} bloquant${report.blocking.length > 1 ? 's' : ''}`;
  if (validation.state === 'pending') return 'En attente de la décision du manager';
  if (validation.state === 'approved') return "L'approbation du manager ne couvre plus le dossier : refaire une demande";
  if (validation.state === 'refused') return 'Validation refusée par le manager';
  if (validation.state === 'correction') return 'Le manager demande une correction';
  return `${report.toConfirm.length} exception${report.toConfirm.length > 1 ? 's' : ''} à faire valider par le manager`;
}
