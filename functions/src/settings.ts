// Lecture des réglages d'administration (cl_settings) par les fonctions serveur. Une seule source pour la
// qualification d'appel, les documents, le planificateur et l'ingestion : ce que l'administrateur règle à l'écran
// est ce qui s'applique. Si aucun réglage n'a jamais été enregistré, on rend null et l'appelant garde son
// comportement d'origine (valeurs du cahier, ou anciens documents cl_config).

import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { COL } from '../../src/domain/collections';
import type { CallRules } from '../../src/domain/call/plan';
import type { DocumentRules } from '../../src/domain/documents/plan';
import type { SchedulerRules } from '../../src/domain/scheduler/plan';
import { callRulesFrom, documentRulesFrom, schedulerRulesFrom } from '../../src/domain/settings/runtime';
import { catalogOf, DEFAULT_REASON_CATALOG, parseReasonSettings, type ReasonCatalog } from '../../src/domain/settings/reasons';
import { effectiveSla, parseConversionSettings, parseRulesSettings, parseSlaOverride, parseSlaSettings, type ConversionSettings, type RulesSettings, type SlaOverride, type SlaSettings } from '../../src/domain/settings/settings';

export const SLA_DOC = 'sla';
export const RULES_DOC = 'rules';
export const CONVERSION_DOC = 'conversion';
export const REASONS_DOC = 'reasons';
/** Réglages d'une campagne : cl_settings/sla_<campaignId>. */
export const campaignSlaDoc = (campaignId: string) => `sla_${campaignId}`;

export interface LoadedSettings {
  sla: SlaSettings;
  rules: RulesSettings;
}

/** null = aucun réglage enregistré (ni généraux ni règles). */
export async function loadSettings(db: Firestore): Promise<LoadedSettings | null> {
  const [sla, rules] = await Promise.all([db.collection(COL.settings).doc(SLA_DOC).get(), db.collection(COL.settings).doc(RULES_DOC).get()]);
  if (!sla.exists && !rules.exists) return null;
  return { sla: parseSlaSettings(sla.data() as DocumentData | undefined), rules: parseRulesSettings(rules.data() as DocumentData | undefined) };
}

export async function loadCallRules(db: Firestore): Promise<CallRules | null> {
  const s = await loadSettings(db);
  return s ? callRulesFrom(s.rules, s.sla) : null;
}

export async function loadDocumentRules(db: Firestore): Promise<DocumentRules | null> {
  const s = await loadSettings(db);
  return s ? documentRulesFrom(s.rules, s.sla) : null;
}

export async function loadSchedulerRules(db: Firestore): Promise<{ rules: SchedulerRules; settings: LoadedSettings } | null> {
  const s = await loadSettings(db);
  return s ? { rules: schedulerRulesFrom(s.rules, s.sla), settings: s } : null;
}

/** Règle de réattribution d'une campagne : réglages généraux surchargés par ceux de la campagne. */
export async function loadCampaignSla(db: Firestore, general: SlaSettings, campaignId: string | null): Promise<SlaSettings> {
  if (!campaignId) return general;
  const snap = await db.collection(COL.settings).doc(campaignSlaDoc(campaignId)).get();
  return snap.exists ? effectiveSla(general, parseSlaOverride(snap.data())) : general;
}

export type { SlaOverride };

/** Verrous de conversion : le réglage enregistré, sinon les valeurs du cahier (jamais d'échec faute de réglage). */
export async function loadConversionRules(db: Firestore): Promise<ConversionSettings> {
  const snap = await db.collection(COL.settings).doc(CONVERSION_DOC).get();
  return parseConversionSettings(snap.exists ? (snap.data() as DocumentData) : undefined);
}

/** Listes de motifs : le réglage enregistré, sinon les valeurs d'origine (jamais d'échec faute de réglage). */
export async function loadReasonCatalog(db: Firestore): Promise<ReasonCatalog> {
  const snap = await db.collection(COL.settings).doc(REASONS_DOC).get();
  return snap.exists ? catalogOf(parseReasonSettings(snap.data() as DocumentData)) : DEFAULT_REASON_CATALOG;
}
