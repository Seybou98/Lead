// Horaires de travail (§5.3, §20.6). Toutes les dates sont des epoch ms (UTC) ;
// le calcul de l'heure locale passe par Intl, donc gère l'heure d'été sans table maison.

export interface WorkSlotLike {
  /** 0 = dimanche … 6 = samedi */
  day: number;
  /** "HH:mm", début inclus */
  start: string;
  /** "HH:mm", fin exclue */
  end: string;
}

export interface ScheduleLike {
  timezone: string;
  weekly: readonly WorkSlotLike[];
  breaks?: readonly WorkSlotLike[];
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

/** Jour de la semaine (0-6) et minutes depuis minuit, dans le fuseau demandé. */
export function localDayAndMinutes(atMs: number, timezone: string): { day: number; minutes: number } {
  const parts = formatterFor(timezone).formatToParts(new Date(atMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS[get('weekday')];
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  if (day === undefined || Number.isNaN(minutes)) {
    throw new Error(`Fuseau horaire invalide : ${timezone}`);
  }
  return { day, minutes };
}

export function parseHHmm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Heure invalide : « ${value} » (attendu HH:mm)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Heure invalide : « ${value} »`);
  return h * 60 + min;
}

function inSlot(slot: WorkSlotLike, day: number, minutes: number): boolean {
  return slot.day === day && minutes >= parseHHmm(slot.start) && minutes < parseHHmm(slot.end);
}

/**
 * Vrai si `atMs` tombe dans un créneau de travail et hors pause.
 * `closedDates` : jours fermés de l'entreprise au format YYYY-MM-DD (dans le fuseau du planning).
 */
export function isWithinSchedule(
  schedule: ScheduleLike,
  atMs: number,
  closedDates: readonly string[] = []
): boolean {
  if (closedDates.length > 0 && closedDates.includes(localDateString(atMs, schedule.timezone))) return false;
  const { day, minutes } = localDayAndMinutes(atMs, schedule.timezone);
  const working = schedule.weekly.some((s) => inSlot(s, day, minutes));
  if (!working) return false;
  return !(schedule.breaks ?? []).some((b) => inSlot(b, day, minutes));
}

/** « 2026-10-06 » dans le fuseau demandé. */
export function localDateString(atMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));
}

/**
 * Premier instant de travail à partir de `atMs` (inclus) : `atMs` lui-même s'il est dans un créneau, sinon
 * l'ouverture du prochain créneau. Sert à ne JAMAIS programmer une tentative hors horaires (§8.1, §5.3).
 * Renvoie null si aucun créneau n'existe dans les 14 jours (planning vide) : l'appelant décide quoi faire.
 */
export function nextWorkingTime(
  schedule: ScheduleLike,
  atMs: number,
  closedDates: readonly string[] = []
): number | null {
  if (schedule.weekly.length === 0) return null;
  if (isWithinSchedule(schedule, atMs, closedDates)) return atMs;
  const STEP = 5 * 60_000;
  const LIMIT = 14 * 24 * 60 * 60_000;
  for (let t = atMs + STEP; t <= atMs + LIMIT; t += STEP) {
    if (isWithinSchedule(schedule, t, closedDates)) {
      // On a dépassé l'ouverture de quelques minutes au plus : on revient à la minute exacte.
      let exact = t;
      while (exact - 60_000 > atMs && isWithinSchedule(schedule, exact - 60_000, closedDates)) exact -= 60_000;
      return exact;
    }
  }
  return null;
}
