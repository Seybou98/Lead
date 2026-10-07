// Conversion d'un document cl_profiles en `ProfileInput`. Partagée par les Cloud Functions (ingestion
// réelle) et l'interface (simulation, fig. 17) : une seule conversion, donc la même décision.

import type { ProfileInput } from './candidates';

type Doc = Record<string, unknown>;

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

/** `toMs` convertit un Timestamp Firestore (SDK Admin ou web) en millisecondes, ou null. */
export function toProfileInput(uid: string, d: Doc, toMs: (v: unknown) => number | null): ProfileInput {
  const load = rec(d.load);
  const cap = rec(d.capacity);
  const o = cap.override ? rec(cap.override) : null;
  const from = o ? toMs(o.from) : null;
  const until = o ? toMs(o.until) : null;
  const scope = rec(d.scope);
  const schedule = rec(d.schedule);
  return {
    uid,
    primaryTeamId: typeof d.primaryTeamId === 'string' ? d.primaryTeamId : null,
    teamIds: arr(d.teamIds),
    managerIds: arr(d.managerIds),
    scope: { productCodes: arr(scope.productCodes), zones: arr(scope.zones) },
    capacity: {
      newLeadsCap: num(cap.newLeadsCap, Number.NaN),
      override: o && from !== null && until !== null ? { value: num(o.value), fromMs: from, untilMs: until } : null,
    },
    operationalStatus: (d.operationalStatus as ProfileInput['operationalStatus']) ?? 'available',
    distributionSuspended: d.distributionSuspended === true,
    accessEndsAtMs: toMs(d.accessEndsAt),
    lastAssignedAtMs: toMs(d.lastAssignedAt),
    load: {
      newLeads: num(load.newLeads),
      callbacks: num(load.callbacks),
      interested: num(load.interested),
      documents: num(load.documents),
      filesToBuild: num(load.filesToBuild),
      recycling: num(load.recycling),
    },
    schedule: {
      timezone: typeof schedule.timezone === 'string' ? schedule.timezone : 'Europe/Paris',
      weekly: Array.isArray(schedule.weekly) ? (schedule.weekly as ProfileInput['schedule']['weekly']) : [],
      breaks: Array.isArray(schedule.breaks) ? (schedule.breaks as NonNullable<ProfileInput['schedule']['breaks']>) : [],
    },
  };
}
