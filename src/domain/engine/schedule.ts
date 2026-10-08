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
  /** Jours fermés de l'entreprise (« YYYY-MM-DD » dans le fuseau du planning), en plus de ceux passés à l'appel. */
  closedDates?: readonly string[];
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
  const closed = schedule.closedDates?.length ? [...schedule.closedDates, ...closedDates] : closedDates;
  if (closed.length > 0 && closed.includes(localDateString(atMs, schedule.timezone))) return false;
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

// ── Temps de travail écoulé (SLA suspendu hors horaires, §19.4) ──────────────

/** Décalage du fuseau (ms) à l'instant donné : heure locale − heure UTC. */
function tzOffsetMs(timezone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(atMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(atMs / 1000) * 1000;
}

/** Instant (epoch ms) de « jour y-m-d, `minutes` après minuit » dans le fuseau. 1440 = minuit du lendemain. */
function zonedEpoch(timezone: string, y: number, m: number, d: number, minutes: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - tzOffsetMs(timezone, guess);
  const second = guess - tzOffsetMs(timezone, first);
  return second;
}

/**
 * Durée de TRAVAIL écoulée entre deux instants : seules comptent les plages du planning, hors pauses et jours
 * fermés. Exacte (calculée par plages et par jour, pas par pas), donc assez légère pour un compteur affiché à la
 * seconde. Un planning vide ne compte aucune durée.
 */
export function workingElapsedMs(schedule: ScheduleLike, fromMs: number, toMs: number, closedDates: readonly string[] = []): number {
  if (!(toMs > fromMs) || schedule.weekly.length === 0) return 0;
  const closed = new Set([...(schedule.closedDates ?? []), ...closedDates]);
  const [fy, fm, fd] = localDateString(fromMs, schedule.timezone).split('-').map(Number);
  const last = localDateString(toMs, schedule.timezone);
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(fy, fm - 1, fd + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dateStr > last) break;
    if (closed.has(dateStr)) continue;
    const dow = day.getUTCDay();
    const breaks = (schedule.breaks ?? []).filter((b) => b.day === dow).map((b) => [parseHHmm(b.start), parseHHmm(b.end)] as const);
    for (const slot of schedule.weekly.filter((s) => s.day === dow)) {
      // Plage moins pauses → morceaux continus.
      let pieces: [number, number][] = [[parseHHmm(slot.start), parseHHmm(slot.end)]];
      for (const [bs, be] of breaks) pieces = pieces.flatMap(([a, b]) => (be <= a || bs >= b ? [[a, b]] : [...(bs > a ? [[a, bs] as [number, number]] : []), ...(be < b ? [[be, b] as [number, number]] : [])]));
      for (const [a, b] of pieces) {
        const start = Math.max(zonedEpoch(schedule.timezone, y, m, d, a), fromMs);
        const end = Math.min(zonedEpoch(schedule.timezone, y, m, d, b), toMs);
        if (end > start) total += end - start;
      }
    }
  }
  return total;
}
