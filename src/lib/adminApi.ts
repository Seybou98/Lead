// Appels aux fonctions d'administration (functions/src/admin.ts).
// Les règles Firestore interdisent l'écriture directe : c'est le seul chemin pour modifier équipes et profils.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { resolveWriteMode } from './adminErrors';
import { deleteChecklistDirect, deleteSlaOverrideDirect, saveConversionDirect, saveReasonsDirect, saveRulesDirect, saveSlaDirect, saveSlaOverrideDirect, saveAssignmentConfigDirect, saveChecklistDirect, saveCampaignDirect, saveProfileDirect, saveSourceDirect, saveSpendDirect, saveTeamDirect } from './adminWrites';

export interface AdminResult {
  ok: true;
  id: string;
  warnings: string[];
}

export interface WorkSlotInput {
  day: number;
  start: string;
  end: string;
}

export interface TeamInput {
  id?: string;
  name: string;
  managerId: string;
  secondaryManagerId: string | null;
  memberIds: string[];
  productCodes: string[];
  zones: string[];
  fallbackTeamId: string | null;
  active: boolean;
  reason?: string;
}

export interface ProfileInput {
  uid: string;
  scope?: { productCodes: string[]; zones: string[]; campaignIds: string[]; sourceIds: string[] };
  /** null = valeur par défaut. */
  newLeadsCap?: number | null;
  capacityOverride?: { value: number; fromMs: number; untilMs: number; reason: string } | null;
  distributionSuspended?: boolean;
  schedule?: { timezone: string; weekly: WorkSlotInput[]; breaks: WorkSlotInput[] };
  accessEndsAtMs?: number | null;
  reason?: string;
}

export { errorMessage } from './adminErrors';

/**
 * Mode d'écriture (variable VITE_ADMIN_WRITE_MODE) : « direct » par défaut — depuis le navigateur,
 * protégé par les règles Firestore — ou « functions » pour passer par les fonctions Firebase quand
 * elles sont déployées (secours). Les deux appliquent exactement les mêmes règles métier.
 */
const MODE = resolveWriteMode(import.meta.env.VITE_ADMIN_WRITE_MODE);

const call =
  <I>(name: string, direct: (data: I) => Promise<AdminResult>) =>
  async (data: I): Promise<AdminResult> =>
    MODE === 'direct' ? direct(data) : (await httpsCallable<I, AdminResult>(functions, name)(data)).data;

export const saveTeam = call<TeamInput>('adminUpsertTeam', saveTeamDirect);
export const saveProfile = call<ProfileInput>('adminUpdateProfile', saveProfileDirect);

export interface SourceInput {
  id?: string;
  name: string;
  kind: 'meta' | 'google' | 'site' | 'agency' | 'import' | 'manual';
  enabled: boolean;
  reason?: string;
}

export interface CampaignInput {
  id?: string;
  name: string;
  sourceId: string;
  externalId: string | null;
  productCode: string | null;
  zones: string[];
  status: 'draft' | 'active' | 'suspended' | 'ended';
  budgetCents: number | null;
  startsAtMs: number | null;
  endsAtMs: number | null;
  eligibleTeamIds: string[];
  eligibleUserIds: string[];
  fallbackTeamId: string | null;
  maxReassignments: number | null;
  autoEligible?: boolean;
  receptionSchedule?: { timezone: string; weekly: WorkSlotInput[] } | null;
  reason?: string;
}

export interface AssignmentConfigInput {
  autoDistribution?: boolean;
  defaultNewLeadsCap?: number;
  criteria?: Record<string, boolean>;
  rankingOrder?: string[];
}

export interface SpendInput {
  /** Absent = nouvelle dépense ; présent = correction (motif obligatoire). */
  id?: string;
  campaignId: string;
  amountCents: number;
  dateMs: number;
  note?: string;
  reason?: string;
}

export const saveSpend = call<SpendInput>('adminSaveSpend', saveSpendDirect);
export const saveSource = call<SourceInput>('adminUpsertSource', saveSourceDirect);
export const saveCampaign = call<CampaignInput>('adminUpsertCampaign', saveCampaignDirect);
export const saveAssignmentConfig = call<{ campaignId: string; config: AssignmentConfigInput; reason?: string }>('adminUpdateAssignmentConfig', saveAssignmentConfigDirect);

export interface ChecklistInput {
  /** null = checklist « par défaut ». */
  productCode: string | null;
  items: { code?: string; label: string; mandatory: boolean }[];
  reason?: string;
}

/** Les checklists n'ont pas de fonction de secours : écriture directe, protégée par les règles Firestore. */
export const saveChecklist = (input: ChecklistInput): Promise<AdminResult> => saveChecklistDirect(input);
export const deleteChecklist = (key: string): Promise<AdminResult> => deleteChecklistDirect(key);

/** Réglages d'administration (SLA et horaires, cycles NR) : écriture directe, protégée par les règles Firestore. */
export const saveSla = (input: unknown): Promise<AdminResult> => saveSlaDirect(input);
export const saveRules = (input: unknown): Promise<AdminResult> => saveRulesDirect(input);
export const saveConversion = (input: unknown): Promise<AdminResult> => saveConversionDirect(input);
export const saveReasons = (input: unknown): Promise<AdminResult> => saveReasonsDirect(input);
export const saveSlaOverride = (input: unknown): Promise<AdminResult> => saveSlaOverrideDirect(input);
export const deleteSlaOverride = (campaignId: string): Promise<AdminResult> => deleteSlaOverrideDirect(campaignId);
