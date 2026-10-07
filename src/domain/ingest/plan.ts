// Planificateur d'ingestion d'un lead (§4.1, §4.2, §4.3, §24.2, §24.3, §24.4).
//
// Fonction PURE : reçoit tout ce qui a été lu en base, retourne tout ce qu'il faut écrire.
// Elle ne lit rien, n'écrit rien et ne dépend pas de Firebase. La couche Cloud Functions n'a plus
// qu'à lire les données, appeler `planIngestion`, puis appliquer le résultat dans UNE transaction.

import type { DeepDate } from '../dates';
import type { CampaignStatus } from '../enums';
import type { Action, ClNotification, DistributionLogEntry, Lead, LeadEvent, RawLead } from '../models';
import {
  decideAssignment,
  type AssignmentConfig,
  type AssignmentDecision,
  type Candidate,
} from '../engine/assignment';
import { findDuplicates, type DuplicateResult, type ExistingLeadSummary } from '../engine/duplicates';
import { isMaintenanceCampaign } from '../engine/normalize';
import type { CandidateProfileInfo } from './candidates';
import type { MappedLead } from './mapPayload';

export interface CampaignInfo {
  id: string;
  name: string;
  status: CampaignStatus;
  productCode: string | null;
  eligibleUserIds: readonly string[];
  eligibleTeamIds: readonly string[];
  fallbackTeamId: string | null;
  autoEligible?: boolean;
}

export interface ExistingLead extends ExistingLeadSummary {
  managerIds: readonly string[];
}

export interface PlanInput {
  nowMs: number;
  /** Identifiant réservé pour le nouveau lead (utilisé seulement s'il est créé). */
  leadId: string;
  rawLeadId: string;
  sourceId: string | null;
  channel: RawLead['channel'];
  mapped: MappedLead;
  campaign: CampaignInfo | null;
  /** Texte de campagne reçu mais introuvable en base ; consigné dans l'historique. */
  unresolvedCampaignRef: string | null;
  existing: readonly ExistingLead[];
  candidates: readonly Candidate[];
  profileInfo: Readonly<Record<string, CandidateProfileInfo>>;
  /** Managers des équipes de la campagne : voient les leads non attribués. */
  campaignManagerIds: readonly string[];
  config: AssignmentConfig;
}

type Dated<T> = DeepDate<T>;

export interface CounterUpdate {
  uid: string;
  newLeadsDelta: number;
  lastAssignedAtMs: number;
}

export type IngestionPlan =
  | { kind: 'rejected'; code: 'no_contact'; reason: string }
  | { kind: 'replay'; leadId: string; duplicate: DuplicateResult }
  | {
      kind: 'attached';
      outcome: 'attached_to_open_lead' | 'known_client';
      targetLeadId: string;
      duplicate: DuplicateResult;
      event: Dated<LeadEvent>;
      notifications: Dated<ClNotification>[];
    }
  | {
      kind: 'created';
      lead: Dated<Lead>;
      events: Dated<LeadEvent>[];
      action: Dated<Action> | null;
      distribution: Dated<DistributionLogEntry>;
      notifications: Dated<ClNotification>[];
      /** Identifiants de documents cl_idempotency à écrire, pointant vers le lead. */
      idempotencyKeys: string[];
      counterUpdates: CounterUpdate[];
      duplicate: DuplicateResult;
      decision: AssignmentDecision | null;
    };

/** Pourquoi un lead créé n'a pas de propriétaire. */
export type HoldReason = 'campaign_not_active' | 'duplicate_review' | 'auto_distribution_off';

const FIRST_ALERT_DELAY_MS = 60_000;
const safeKey = (s: string) => s.replace(/\//g, '_');

export function idempotencyKeysFor(m: { phone: string | null; email: string | null; externalId: string | null }, sourceId: string | null): string[] {
  const keys: string[] = [];
  if (sourceId && m.externalId) keys.push(safeKey(`ext_${sourceId}_${m.externalId}`));
  if (m.phone) keys.push(safeKey(`phone_${m.phone}`));
  if (m.email) keys.push(safeKey(`email_${m.email}`));
  return keys;
}

/** Motif de rejet lisible : indique les valeurs reçues pour que la source puisse corriger. */
export function noContactReason(m: Pick<MappedLead, 'phoneRaw' | 'emailRaw'>): string {
  return `Ni téléphone ni email exploitable (téléphone : ${m.phoneRaw ?? 'absent'}, email : ${m.emailRaw ?? 'absent'}).`;
}

export function planIngestion(input: PlanInput): IngestionPlan {
  const { mapped, nowMs } = input;

  if (!mapped.phone && !mapped.email) {
    return { kind: 'rejected', code: 'no_contact', reason: noContactReason(mapped) };
  }

  const duplicate = findDuplicates(
    {
      phone: mapped.phone,
      email: mapped.email,
      externalId: mapped.externalId,
      sourceId: input.sourceId,
      fullName: mapped.fullName,
      addressLine: mapped.address.line,
      postalCode: mapped.address.postalCode,
    },
    input.existing
  );

  if (duplicate.isReplay && duplicate.primaryMatchId) {
    return { kind: 'replay', leadId: duplicate.primaryMatchId, duplicate };
  }

  const at = new Date(nowMs);

  // Lead déjà ouvert, ou client déjà connu : on rattache, on ne crée rien (§24.3).
  if ((duplicate.outcome === 'attached_to_open_lead' || duplicate.outcome === 'known_client') && duplicate.primaryMatchId) {
    const target = input.existing.find((e) => e.id === duplicate.primaryMatchId)!;
    const eventId = `${target.id}_dup_${input.rawLeadId}`;
    const recipients = new Set<string>();
    if (target.ownerId) recipients.add(target.ownerId);
    // Un client connu qui se manifeste de nouveau mérite l'attention du manager (§24.3 « alerte »).
    if (duplicate.outcome === 'known_client') target.managerIds.forEach((m) => recipients.add(m));

    return {
      kind: 'attached',
      outcome: duplicate.outcome,
      targetLeadId: target.id,
      duplicate,
      event: {
        id: eventId,
        type: 'duplicate_interaction',
        at,
        actorId: 'system',
        note: duplicate.explanation,
        meta: {
          rawLeadId: input.rawLeadId,
          sourceId: input.sourceId,
          campaignId: input.campaign?.id ?? null,
          campaignName: input.campaign?.name ?? mapped.campaign.name,
          productCode: mapped.productCode,
          outcome: duplicate.outcome,
          matchedOn: duplicate.matches[0]?.reasons ?? [],
        },
      },
      notifications:
        recipients.size === 0
          ? []
          : [
              {
                id: eventId,
                type: 'lead_interaction',
                title: duplicate.outcome === 'known_client' ? 'Client connu : nouvelle demande' : 'Nouvelle demande d\'un lead ouvert',
                description: `${mapped.fullName || 'Contact'} a de nouveau fait une demande${mapped.campaign.name ? ` (${mapped.campaign.name})` : ''}.`,
                leadId: target.id,
                recipientIds: [...recipients],
                sound: null,
                readBy: [],
                createdAt: at,
              },
            ],
    };
  }

  // ── Création d'un nouveau lead ──────────────────────────────────────────────

  const campaign = input.campaign;
  // Campagne d'entretien : `product` est l'équipement du client, pas le produit de la campagne.
  // Il est rangé dans la qualification (type de chauffage, comme l'ancien CRM) et ne sert PAS
  // à choisir le télépro : seul le produit de la campagne compte.
  const maintenance = isMaintenanceCampaign(campaign?.name) || isMaintenanceCampaign(mapped.campaign.name);
  const productCode = maintenance ? (campaign?.productCode ?? null) : (mapped.productCode ?? campaign?.productCode ?? null);
  const qualification =
    maintenance && mapped.productCode && mapped.qualification.currentHeatingType === undefined
      ? { ...mapped.qualification, currentHeatingType: mapped.productCode }
      : mapped.qualification;

  let holdReason: HoldReason | null = null;
  if (duplicate.outcome === 'probable_duplicate') holdReason = 'duplicate_review';
  else if (campaign && campaign.status !== 'active') holdReason = 'campaign_not_active';
  else if (input.config.autoDistribution === false) holdReason = 'auto_distribution_off';

  const decision: AssignmentDecision | null = holdReason
    ? null
    : decideAssignment({ id: input.leadId, productCode, zone: mapped.zone, campaignId: campaign?.id ?? null }, campaign, input.candidates, nowMs, input.config);

  const ownerId = decision?.chosenUid ?? null;
  const ownerInfo = ownerId ? input.profileInfo[ownerId] : undefined;
  const managerIds = ownerInfo ? [...ownerInfo.managerIds] : [...new Set(input.campaignManagerIds)];
  const teamId = ownerInfo?.primaryTeamId ?? campaign?.eligibleTeamIds[0] ?? null;

  const assignmentState: Lead['assignmentState'] = ownerId ? 'assigned' : holdReason === 'duplicate_review' ? 'to_assign' : 'buffer';
  const bufferReason = ownerId ? null : holdReason ?? decision?.bufferReason ?? 'no_candidate';

  const actionId = `${input.leadId}_take_new_lead`;
  const nextAction: Dated<NonNullable<Lead['nextAction']>> = {
    actionId,
    type: 'take_new_lead',
    dueAt: at,
    priority: 'P1',
    reason: 'Nouveau lead à prendre en charge',
  };

  const lead: Dated<Lead> = {
    id: input.leadId,
    fullName: mapped.fullName,
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    phone: mapped.phone,
    email: mapped.email,
    address: { line: mapped.address.line, postalCode: mapped.address.postalCode ?? '', city: mapped.address.city, zone: mapped.zone },
    origin: {
      sourceId: input.sourceId,
      platform: mapped.platform,
      campaignId: campaign?.id ?? null,
      adsetId: mapped.adsetId,
      adId: mapped.adId,
      formId: mapped.formId,
      externalId: mapped.externalId,
      costCents: mapped.costCents,
      receivedAt: at,
      rawLeadId: input.rawLeadId,
    },
    consent: mapped.consent,
    productCode,
    qualification,
    configVersions: {},
    assignmentState,
    ownerId,
    teamId,
    managerIds,
    bufferReason,
    reassignCount: 0,
    status: 'new',
    subStatus: null,
    temperature: null,
    nextAction: ownerId ? nextAction : null,
    sla: {
      startedAt: at,
      stoppedAt: null,
      nextAlertAt: ownerId ? new Date(nowMs + FIRST_ALERT_DELAY_MS) : null,
      alertCount: 0,
      breachedAt: null,
      pausedMinutes: 0,
    },
    nr: { attempt: 0, cycle: 1, lastAt: null, nextAt: null },
    documents: {
      state: 'none',
      expected: 0,
      received: 0,
      conform: 0,
      mandatory: 0,
      mandatoryConform: 0,
      lastRequestAt: null,
      nextFollowUpAt: null,
      promisedAt: null,
    },
    commercialState: 'none',
    financialState: 'none',
    saleId: null,
    conversion: { state: null, clientId: null, dossierId: null, convertedAt: null },
    quality: {
      duplicateOf: duplicate.outcome === 'probable_duplicate' ? duplicate.primaryMatchId : null,
      duplicateOutcome: duplicate.outcome,
      excluded: false,
      excludedReason: null,
    },
    lastNote: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };

  const events: Dated<LeadEvent>[] = [
    {
      id: `${input.leadId}_created`,
      type: 'created',
      at,
      actorId: 'system',
      meta: {
        channel: input.channel,
        rawLeadId: input.rawLeadId,
        sourceId: input.sourceId,
        campaignId: campaign?.id ?? null,
        duplicateOutcome: duplicate.outcome,
        duplicateOf: lead.quality.duplicateOf,
        ...(input.unresolvedCampaignRef ? { unresolvedCampaignRef: input.unresolvedCampaignRef } : {}),
      },
    },
  ];
  if (ownerId) {
    events.push({
      id: `${input.leadId}_assigned`,
      type: 'assigned',
      at,
      actorId: 'engine',
      before: { ownerId: null },
      after: { ownerId },
      reason: decision!.decidedBy ?? undefined,
      meta: { ruleApplied: decision!.ruleApplied, stage: decision!.stage },
    });
  } else {
    events.push({
      id: `${input.leadId}_held`,
      type: 'alert',
      at,
      actorId: 'engine',
      reason: bufferReason ?? undefined,
      note:
        holdReason === 'duplicate_review'
          ? duplicate.explanation
          : holdReason === 'campaign_not_active'
            ? `Campagne « ${campaign!.name} » non active (${campaign!.status}) : le lead attend une décision.`
            : holdReason === 'auto_distribution_off'
              ? 'Distribution automatique désactivée pour cette campagne : le lead attend une attribution manuelle.'
              : 'Aucun télépro éligible : le lead est en file tampon et réévalué régulièrement.',
      meta: { assignmentState, bufferReason },
    });
  }

  const distribution: Dated<DistributionLogEntry> = {
    id: `${input.leadId}_dist_0`,
    at,
    leadId: input.leadId,
    leadName: mapped.fullName || null,
    teamId,
    managerIds,
    campaignId: campaign?.id ?? null,
    event: ownerId ? 'assign' : 'buffer',
    mode: 'real',
    chosenOwnerId: ownerId,
    previousOwnerId: null,
    actorId: 'engine',
    reason: ownerId ? (decision!.decidedBy ?? null) : bufferReason,
    ruleApplied: holdReason ?? decision?.ruleApplied ?? 'none',
    candidates: (decision?.evaluations ?? []).map((e) => ({
      uid: e.uid,
      eligible: e.eligible,
      exclusions: e.exclusions,
      activeLoad: e.activeLoad,
      newLeads: e.newLeads,
      cap: e.effectiveCap,
      lastAssignedAt: e.lastAssignedAtMs === null ? null : new Date(e.lastAssignedAtMs),
    })),
  };

  const label = `${mapped.fullName || 'Nouveau contact'}${mapped.address.postalCode ? ` — ${mapped.address.postalCode}` : ''}${campaign ? ` (${campaign.name})` : ''}`;
  const notifications: Dated<ClNotification>[] = [];
  if (ownerId) {
    notifications.push({
      id: `${input.leadId}_new`,
      type: 'lead_assigned',
      title: 'Nouveau lead',
      description: label,
      leadId: input.leadId,
      recipientIds: [ownerId],
      sound: 'new_lead',
      readBy: [],
      createdAt: at,
    });
  } else if (managerIds.length > 0) {
    notifications.push({
      id: `${input.leadId}_alert`,
      type: 'lead_unassigned',
      title: holdReason === 'duplicate_review' ? 'Doublon probable à traiter' : 'Lead à attribuer',
      description: `${label} — ${bufferReason}`,
      leadId: input.leadId,
      recipientIds: managerIds,
      sound: 'critical',
      readBy: [],
      createdAt: at,
    });
  }

  const action: Dated<Action> | null = ownerId
    ? {
        id: actionId,
        leadId: input.leadId,
        ownerId,
        teamId,
        managerIds,
        type: 'take_new_lead',
        priority: 'P1',
        state: 'open',
        dueAt: at,
        reason: 'Nouveau lead à prendre en charge',
        result: null,
        completedAt: null,
        snoozedUntil: null,
        dedupeKey: `${input.leadId}:take_new_lead`,
        createdAt: at,
        updatedAt: at,
      }
    : null;

  return {
    kind: 'created',
    lead,
    events,
    action,
    distribution,
    notifications,
    idempotencyKeys: idempotencyKeysFor(mapped, input.sourceId),
    counterUpdates: ownerId ? [{ uid: ownerId, newLeadsDelta: 1, lastAssignedAtMs: nowMs }] : [],
    duplicate,
    decision,
  };
}
