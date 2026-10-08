// Couche Firestore du planificateur (§15.1) : lit les leads ouverts, appelle les planificateurs purs
// (src/domain/scheduler/plan.ts), puis applique : escalades vers les managers, entrée en recyclage ou archivage,
// attribution des leads de la file tampon quand une capacité compatible réapparaît. Ce fichier ne décide d'aucune
// règle métier. Chaque effet est idempotent : rejouer un passage (deux exécutions rapprochées, reprise après
// erreur) ne double ni une notification, ni une action, ni une attribution.

import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { COL, SUB } from '../../src/domain/collections';
import { decideAssignment } from '../../src/domain/engine/assignment';
import { parseAssignmentConfig } from '../../src/domain/ingest/configParse';
import { buildCandidates, type AbsenceInput, type PresenceInput, type UserInput } from '../../src/domain/ingest/candidates';
import { toProfileInput } from '../../src/domain/ingest/profileInput';
import { loadDeltaFor } from '../../src/domain/call/plan';
import {
  DEFAULT_SCHEDULER_RULES,
  dueForSlaReassign,
  isEngineBuffered,
  planEscalations,
  planRecycling,
  type SchedLead,
  type SchedulerRules,
} from '../../src/domain/scheduler/plan';
import { displayName, readPublishedConfig, toCampaignInfo } from './ingest';
import { parseCallRules } from './qualify';
import { reassignLead } from './reassign';
import { loadCampaignSla, loadSchedulerRules } from './settings';
import { DEFAULT_SLA_SETTINGS, type SlaSettings } from '../../src/domain/settings/settings';

export interface SchedulerReport {
  atMs: number;
  leadsRead: number;
  escalations: number;
  recycled: number;
  archived: number;
  assigned: number;
  /** Leads réattribués automatiquement faute de prise en charge dans le délai. */
  slaReassigned: number;
  /** Absences dont le statut « Absent » vient d'être posé / levé. */
  absencesStarted: number;
  absencesEnded: number;
  /** Leads revenus à leur propriétaire d'origine à la fin d'un transfert temporaire. */
  returned: number;
  /** Leads en file tampon réévalués sans qu'aucun télépro ne puisse encore les recevoir. */
  stillWaiting: number;
  errors: string[];
}

const OPEN_STATUSES = ['new', 'callback', 'awaiting_documents', 'missing_info', 'unreachable_cycle_end'];
const READ_LIMIT = 1000;
/** Attributions maximales par passage : le reste attend le suivant, plutôt qu'une transaction interminable. */
const ASSIGN_LIMIT = 50;

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ms = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

/** Réglages facultatifs (cl_config/schedulerRules) ; horaires repris de callRules. Valeur absente ou invalide : défaut. */
export function parseSchedulerRules(raw: DocumentData | undefined, callRaw: DocumentData | undefined): SchedulerRules {
  const base = DEFAULT_SCHEDULER_RULES;
  const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback);
  const calls = parseCallRules(callRaw);
  return {
    callbackEscalationMin: num(raw?.callbackEscalationMin, base.callbackEscalationMin, 1, 24 * 60),
    slaMs: base.slaMs,
    criticalMs: base.criticalMs,
    suspendOutsideHours: base.suspendOutsideHours,
    bufferWarnMin: num(raw?.bufferWarnMin, base.bufferWarnMin, 1, 24 * 60),
    bufferAnomalyHours: num(raw?.bufferAnomalyHours, base.bufferAnomalyHours, 1, 24 * 30),
    maxRecycleCycles: num(raw?.maxRecycleCycles, base.maxRecycleCycles, 1, 20),
    schedule: calls.schedule,
  };
}

export function toSchedLead(id: string, d: DocumentData): SchedLead {
  return {
    id,
    fullName: typeof d.fullName === 'string' ? d.fullName : '',
    status: d.status,
    assignmentState: typeof d.assignmentState === 'string' ? d.assignmentState : 'assigned',
    ownerId: typeof d.ownerId === 'string' ? d.ownerId : null,
    managerIds: arr(d.managerIds),
    receivedAtMs: ms(d.origin?.receivedAt) ?? ms(d.createdAt) ?? 0,
    slaStartedAtMs: ms(d.sla?.startedAt),
    slaStoppedAtMs: ms(d.sla?.stoppedAt),
    bufferReason: typeof d.bufferReason === 'string' ? d.bufferReason : null,
    nextAction: d.nextAction && ms(d.nextAction.dueAt) !== null ? { type: String(d.nextAction.type), dueAtMs: ms(d.nextAction.dueAt) as number, reason: String(d.nextAction.reason ?? '') } : null,
    nr: { attempt: Number(d.nr?.attempt ?? 0), cycle: Number(d.nr?.cycle ?? 1), nextAtMs: ms(d.nr?.nextAt) },
    campaignId: typeof d.origin?.campaignId === 'string' ? d.origin.campaignId : null,
    productCode: typeof d.productCode === 'string' ? d.productCode : null,
    zone: typeof d.address?.zone === 'string' ? d.address.zone : null,
    reassignCount: Number(d.reassignCount ?? 0),
    lastReassignedAtMs: ms(d.lastReassignedAt),
  };
}

const alreadyExists = (e: unknown) => (e as { code?: number | string })?.code === 6 || /already exists/i.test((e as Error)?.message ?? '');

export async function runScheduler(db: Firestore, nowMs: number): Promise<SchedulerReport> {
  const report: SchedulerReport = { atMs: nowMs, leadsRead: 0, escalations: 0, recycled: 0, archived: 0, assigned: 0, slaReassigned: 0, absencesStarted: 0, absencesEnded: 0, returned: 0, stillWaiting: 0, errors: [] };
  const at = new Date(nowMs);
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      // Un lead en échec ne bloque jamais les autres ni le passage suivant.
      report.errors.push(`${label} : ${(e as Error).message}`.slice(0, 200));
    }
  };

  const configured = await loadSchedulerRules(db);
  let rules = configured?.rules;
  if (!rules) {
    // Aucun réglage enregistré dans Paramètres : anciens documents cl_config, sinon valeurs du cahier.
    const [rulesSnap, callSnap] = await Promise.all([db.collection(COL.config).doc('schedulerRules').get(), db.collection(COL.config).doc('callRules').get()]);
    rules = parseSchedulerRules(rulesSnap.exists ? rulesSnap.data() : undefined, callSnap.exists ? callSnap.data() : undefined);
  }

  const snap = await db.collection(COL.leads).where('status', 'in', OPEN_STATUSES).limit(READ_LIMIT).get();
  const leads = snap.docs.map((d) => toSchedLead(d.id, d.data()));
  report.leadsRead = leads.length;

  // ── 1. Escalades vers les managers ──
  for (const e of planEscalations(leads, nowMs, rules)) {
    await guard(`escalade ${e.id}`, async () => {
      try {
        await db.collection(COL.notifications).doc(e.id).create({
          id: e.id,
          type: 'manager_alert',
          title: e.title,
          description: e.description.slice(0, 300),
          leadId: e.leadId,
          recipientIds: e.recipientIds,
          sound: e.sound,
          readBy: [],
          createdAt: at,
        });
        report.escalations += 1;
      } catch (err) {
        if (!alreadyExists(err)) throw err; // déjà envoyée par un passage précédent
      }
    });
  }

  // ── 2. Recyclage et archivage ──
  for (const l of leads) {
    const plan = planRecycling(l, nowMs, rules);
    if (!plan) continue;
    await guard(`recyclage ${l.id}`, async () => {
      const leadRef = db.collection(COL.leads).doc(l.id);
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(leadRef);
        // Relu dans la transaction : un télépro a pu agir entre-temps.
        if (!cur.exists || cur.get('status') !== 'unreachable_cycle_end') return;
        const ownerId: string | null = cur.get('ownerId') ?? null;
        const profileRef = ownerId ? db.collection(COL.profiles).doc(ownerId) : null;
        const profileSnap = profileRef ? await tx.get(profileRef) : null;
        const status = plan.kind === 'recycle' ? 'recycling' : 'unreachable_archived';

        const patch: Record<string, unknown> = { status, updatedAt: at, version: FieldValue.increment(1) };
        if (plan.kind === 'recycle') {
          patch.nextAction = { actionId: plan.action.id, type: 'recycle', dueAt: new Date(plan.action.dueAtMs), priority: 'P4', reason: plan.action.reason };
          tx.set(db.collection(COL.actions).doc(plan.action.id), {
            id: plan.action.id,
            leadId: l.id,
            ownerId,
            teamId: cur.get('teamId') ?? null,
            managerIds: arr(cur.get('managerIds')),
            type: 'recycle',
            priority: 'P4',
            state: 'open',
            dueAt: new Date(plan.action.dueAtMs),
            reason: plan.action.reason,
            result: null,
            completedAt: null,
            snoozedUntil: null,
            dedupeKey: `${l.id}:recycle:${plan.cycle}`,
            createdAt: at,
            updatedAt: at,
          });
        } else {
          patch.nextAction = null;
        }
        tx.update(leadRef, patch);

        const evRef = leadRef.collection(SUB.events).doc(`sched_${plan.kind}_${plan.kind === 'recycle' ? plan.cycle : l.nr.cycle}`);
        tx.set(evRef, {
          id: evRef.id,
          type: 'status_changed',
          at,
          actorId: 'engine',
          before: { status: 'unreachable_cycle_end' },
          after: { status },
          reason: plan.kind === 'recycle' ? `Entrée en recyclage (cycle ${plan.cycle})` : plan.reason,
        });

        if (profileRef && profileSnap?.exists) {
          const delta = loadDeltaFor('unreachable_cycle_end', status);
          const upd: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(delta)) upd[`load.${k}`] = FieldValue.increment(v as number);
          if (Object.keys(upd).length) tx.update(profileRef, { ...upd, updatedAt: at });
        }
      });
      if (plan.kind === 'recycle') report.recycled += 1;
      else report.archived += 1;
    });
  }

  // ── 3. File tampon (§24.4) et réattribution au SLA (§19.4) : même moteur d'attribution ──
  const general = configured?.settings.sla ?? DEFAULT_SLA_SETTINGS;
  const campaignSla = new Map<string, SlaSettings>();
  const slaOf = async (campaignId: string | null): Promise<SlaSettings> => {
    const key = campaignId ?? '';
    if (!campaignSla.has(key)) campaignSla.set(key, await loadCampaignSla(db, general, campaignId));
    return campaignSla.get(key) as SlaSettings;
  };
  const waiting = leads.filter(isEngineBuffered).sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const due: { lead: SchedLead; sla: SlaSettings }[] = [];
  for (const l of leads) {
    if (l.status !== 'new' || l.ownerId === null || l.slaStoppedAtMs !== null) continue;
    const sla = await slaOf(l.campaignId);
    if (dueForSlaReassign(l, nowMs, sla, rules)) due.push({ lead: l, sla });
  }
  due.sort((a, b) => (a.lead.slaStartedAtMs ?? 0) - (b.lead.slaStartedAtMs ?? 0));

  if (waiting.length > 0 || due.length > 0) {
    await guard('attribution', async () => {
      const [profileSnaps, absenceSnaps, globalConfig] = await Promise.all([
        db.collection(COL.profiles).get(),
        db.collection(COL.absences).where('to', '>=', at).get(),
        readPublishedConfig(db, 'assignment'),
      ]);
      const uids = profileSnaps.docs.map((d) => d.id);
      const [userSnaps, presenceSnaps] = uids.length
        ? await Promise.all([db.getAll(...uids.map((u) => db.collection('users').doc(u))), db.getAll(...uids.map((u) => db.collection(COL.presence).doc(u)))])
        : [[], []];
      const users: Record<string, UserInput> = {};
      userSnaps.forEach((s) => s.exists && (users[s.id] = { uid: s.id, role: s.get('role') ?? null, status: s.get('status') ?? null, name: displayName(s.data()!) }));
      const presence: Record<string, PresenceInput> = {};
      presenceSnaps.forEach((s) => s.exists && (presence[s.id] = { connected: s.get('connected') === true, lastSeenAtMs: ms(s.get('lastSeenAt')) }));
      const absences: AbsenceInput[] = [];
      absenceSnaps.forEach((s) => {
        const from = ms(s.get('from'));
        const to = ms(s.get('to'));
        if (from !== null && to !== null) absences.push({ userId: s.get('userId'), fromMs: from, toMs: to });
      });
      const { candidates } = buildCandidates({ profiles: profileSnaps.docs.map((d) => toProfileInput(d.id, d.data(), ms)), users, presence, absences, nowMs });
      const live = new Map(candidates.map((c) => [c.uid, { ...c }]));

      const campaigns = new Map<string, { info: ReturnType<typeof toCampaignInfo>; data: DocumentData } | null>();
      const campaignOf = async (id: string | null) => {
        if (!id) return null;
        if (!campaigns.has(id)) {
          const s = await db.collection(COL.campaigns).doc(id).get();
          campaigns.set(id, s.exists ? { info: toCampaignInfo(s.id, s.data()!), data: s.data()! } : null);
        }
        return campaigns.get(id) ?? null;
      };
      /** Un lead vient d'être confié : le télépro compte un nouveau lead de plus pour les décisions suivantes du passage. */
      const took = (uid: string) => {
        const c = live.get(uid);
        if (c) {
          c.newLeads += 1;
          c.activeLoad += 1;
          c.lastAssignedAtMs = nowMs;
        }
      };

      let done = 0;
      for (const l of waiting) {
        if (done >= ASSIGN_LIMIT) break;
        const c = await campaignOf(l.campaignId);
        // Campagne suspendue ou terminée : le lead attend une décision, le moteur n'y touche pas.
        if (c && c.info.status !== 'active') continue;
        const config = parseAssignmentConfig(globalConfig, c?.data.assignmentConfig);
        if (config.autoDistribution === false) continue;
        const decision = decideAssignment({ id: l.id, productCode: l.productCode, zone: l.zone, campaignId: l.campaignId }, c?.info ?? null, [...live.values()], nowMs, config);
        if (!decision.chosenUid) {
          report.stillWaiting += 1;
          continue;
        }
        const target = decision.chosenUid;
        const result = await reassignLead(db, {
          uid: 'engine',
          role: 'admin',
          leadId: l.id,
          targetUid: target,
          reason: `Attribution automatique : une capacité compatible est réapparue (${decision.ruleApplied})`,
          requestId: `sched_${l.id}_${Math.floor(nowMs / 60_000)}`,
          nowMs,
          engine: true,
        });
        if (result.ok) {
          report.assigned += 1;
          done += 1;
          took(target);
        } else if (result.code !== 'invalid') {
          report.errors.push(`attribution ${l.id} : ${result.message}`.slice(0, 200));
        } else {
          report.stillWaiting += 1;
        }
      }

      // Réattribution au SLA : le lead va à un autre télépro que son propriétaire, ou à l'équipe de secours.
      for (const { lead: l, sla } of due) {
        if (done >= ASSIGN_LIMIT) break;
        const c = await campaignOf(l.campaignId);
        if (c && c.info.status !== 'active') continue;
        const config = parseAssignmentConfig(globalConfig, c?.data.assignmentConfig);
        const others = [...live.values()].filter((x) => x.uid !== l.ownerId);
        const campaign = c
          ? { ...c.info, fallbackTeamId: sla.fallbackTeamId ?? c.info.fallbackTeamId }
          : sla.fallbackTeamId
            ? { id: '', name: '', status: 'active' as const, productCode: null, eligibleUserIds: [], eligibleTeamIds: [], fallbackTeamId: sla.fallbackTeamId, autoEligible: true }
            : null;
        const decision = decideAssignment({ id: l.id, productCode: l.productCode, zone: l.zone, campaignId: l.campaignId }, campaign, others, nowMs, config);
        if (!decision.chosenUid) continue; // personne d'autre ne peut le prendre : il reste à son propriétaire
        const result = await reassignLead(db, {
          uid: 'engine',
          role: 'admin',
          leadId: l.id,
          targetUid: decision.chosenUid,
          reason: `SLA dépassé (${sla.reassignMin} min) : réattribution automatique${decision.stage === 'fallback' ? ' vers l’équipe de secours' : ''}`,
          requestId: `sla_${l.id}_${l.reassignCount + 1}`,
          nowMs,
          engine: true,
          expectOwnerId: l.ownerId,
        });
        if (result.ok) {
          report.slaReassigned += 1;
          done += 1;
          took(decision.chosenUid);
          const old = live.get(l.ownerId as string);
          if (old && old.newLeads > 0) old.newLeads -= 1;
        } else if (result.code !== 'invalid') {
          report.errors.push(`réattribution SLA ${l.id} : ${result.message}`.slice(0, 200));
        }
      }
    });
  }

  // ── 4. Absences (§20.6) : « Absent » pendant l'absence, retour à l'heure exacte de la fin ──
  await guard('absences', async () => {
    const snap = await db.collection(COL.absences).where('handled', '==', false).get();
    for (const doc of snap.docs) {
      const from = ms(doc.get('from'));
      const to = ms(doc.get('to'));
      const userId = String(doc.get('userId') ?? '');
      if (from === null || to === null || !userId || from > nowMs) continue; // pas encore commencée
      await guard(`absence ${doc.id}`, async () => {
        const profileRef = db.collection(COL.profiles).doc(userId);
        const profile = await profileRef.get();
        if (!profile.exists) return;
        const status = profile.get('operationalStatus');
        if (nowMs < to) {
          if (status !== 'absent' && status !== 'on_call') {
            await profileRef.update({ operationalStatus: 'absent', operationalStatusSince: at, updatedAt: at });
            report.absencesStarted += 1;
          }
          return;
        }
        // Fin atteinte : le télépro redevient disponible ; sans « rétablir automatiquement », la distribution reste suspendue.
        const upd: Record<string, unknown> = { updatedAt: at };
        if (status === 'absent') {
          upd.operationalStatus = 'available';
          upd.operationalStatusSince = at;
        }
        if (doc.get('restoreDistribution') === false) upd.distributionSuspended = true;
        await profileRef.update(upd);
        await doc.ref.update({ handled: true, handledAt: at });
        const audit = db.collection(COL.audit).doc(`absence_return_${doc.id}`.slice(0, 200));
        await audit.set({ id: audit.id, at, actorId: 'engine', action: 'absence.return', entityType: 'user', entityId: userId, before: { operationalStatus: status }, after: { distributionSuspended: doc.get('restoreDistribution') === false ? true : null }, reason: 'Fin de l’absence' });
        report.absencesEnded += 1;
      });
    }
  });

  // ── 5. Retour des transferts temporaires (§20.6 : « documents attendus : transférer temporairement ») ──
  await guard('retours de transfert', async () => {
    const snap = await db.collection(COL.transfers).where('returned', '==', false).get();
    for (const batch of snap.docs) {
      const returnAt = ms(batch.get('returnAt'));
      if (batch.get('temporary') !== true || returnAt === null || returnAt > nowMs) continue;
      await guard(`retour ${batch.id}`, async () => {
        const fromUid = String(batch.get('fromUid'));
        const toUids = arr(batch.get('toUids'));
        for (const leadId of arr(batch.get('leadIds'))) {
          const lead = await db.collection(COL.leads).doc(leadId).get();
          // Seulement les leads encore chez le destinataire : un lead repris, transféré ailleurs ou clôturé n'est pas touché.
          if (!lead.exists || !toUids.includes(String(lead.get('ownerId'))) || !OPEN_STATUSES.concat(['recycling', 'file_ready_to_build', 'file_building', 'interested', 'nr']).includes(lead.get('status'))) continue;
          const r = await reassignLead(db, { uid: 'engine', role: 'admin', leadId, targetUid: fromUid, reason: 'Retour du transfert temporaire', requestId: `ret_${batch.id}_${leadId}`.slice(0, 100), nowMs });
          if (r.ok) report.returned += 1;
          else report.errors.push(`retour ${leadId} : ${r.message}`.slice(0, 200));
        }
        // Marqué traité dans tous les cas : un propriétaire d'origine devenu inactif ne doit pas bloquer chaque passage.
        await batch.ref.update({ returned: true, returnedAt: at });
      });
    }
  });

  // Trace du dernier passage (lisible par le personnel : cl_config est en lecture seule côté navigateur).
  await guard('trace', async () => {
    await db.collection(COL.config).doc('schedulerStatus').set({ lastRunAt: at, report: { ...report, errors: report.errors.slice(0, 10) } });
  });
  return report;
}
