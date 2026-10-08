import { describe, expect, it } from 'vitest';
import { isWithinSchedule, localDateString, localDayAndMinutes, nextWorkingTime, parseHHmm, workingElapsedMs, type ScheduleLike } from './schedule';

const PARIS = 'Europe/Paris';
// Lundi à vendredi 09:00-12:30 et 14:00-18:00
const weekdays = [1, 2, 3, 4, 5];
const schedule = {
  timezone: PARIS,
  weekly: weekdays.flatMap((day) => [
    { day, start: '09:00', end: '12:30' },
    { day, start: '14:00', end: '18:00' },
  ]),
  breaks: [{ day: 3, start: '10:00', end: '10:15' }], // pause du mercredi
};

describe("heure locale (heure d\'été incluse)", () => {
  it('été : Paris = UTC+2', () => {
    // lundi 6 juillet 2026, 07:30 UTC = 09:30 à Paris
    expect(localDayAndMinutes(Date.UTC(2026, 6, 6, 7, 30), PARIS)).toEqual({ day: 1, minutes: 9 * 60 + 30 });
  });
  it('hiver : Paris = UTC+1', () => {
    // lundi 7 décembre 2026, 08:30 UTC = 09:30 à Paris
    expect(localDayAndMinutes(Date.UTC(2026, 11, 7, 8, 30), PARIS)).toEqual({ day: 1, minutes: 9 * 60 + 30 });
  });
  it('minuit : jamais « 24:00 »', () => {
    // dimanche 4 octobre 2026, 22:00 UTC = lundi 5 octobre 00:00 à Paris
    expect(localDayAndMinutes(Date.UTC(2026, 9, 4, 22, 0), PARIS)).toEqual({ day: 1, minutes: 0 });
  });
  it('fuseau inconnu : erreur explicite', () => {
    expect(() => localDayAndMinutes(0, 'Nulle/Part')).toThrow();
  });
  it('date locale', () => {
    expect(localDateString(Date.UTC(2026, 9, 4, 22, 30), PARIS)).toBe('2026-10-05');
  });
});

describe('isWithinSchedule', () => {
  // lundi 5 octobre 2026 (heure d'été : UTC+2)
  const monday = (h: number, m = 0) => Date.UTC(2026, 9, 5, h - 2, m);
  const wednesday = (h: number, m = 0) => Date.UTC(2026, 9, 7, h - 2, m);

  it('dans un créneau', () => {
    expect(isWithinSchedule(schedule, monday(9, 0))).toBe(true);
    expect(isWithinSchedule(schedule, monday(12, 29))).toBe(true);
    expect(isWithinSchedule(schedule, monday(17, 59))).toBe(true);
  });
  it('la fin du créneau est exclue, le début inclus', () => {
    expect(isWithinSchedule(schedule, monday(12, 30))).toBe(false);
    expect(isWithinSchedule(schedule, monday(18, 0))).toBe(false);
    expect(isWithinSchedule(schedule, monday(8, 59))).toBe(false);
  });
  it('pause déjeuner entre deux créneaux', () => {
    expect(isWithinSchedule(schedule, monday(13, 0))).toBe(false);
  });
  it("pause déclarée à l\'intérieur d\'un créneau", () => {
    expect(isWithinSchedule(schedule, wednesday(10, 5))).toBe(false);
    expect(isWithinSchedule(schedule, wednesday(10, 15))).toBe(true);
  });
  it('week-end : hors horaires', () => {
    const saturday = Date.UTC(2026, 9, 10, 8, 0);
    expect(isWithinSchedule(schedule, saturday)).toBe(false);
  });
  it("jour fermé de l\'entreprise", () => {
    expect(isWithinSchedule(schedule, monday(10, 0), ['2026-10-05'])).toBe(false);
    expect(isWithinSchedule(schedule, monday(10, 0), ['2026-10-06'])).toBe(true);
  });
  it('planning vide : jamais disponible', () => {
    expect(isWithinSchedule({ timezone: PARIS, weekly: [] }, monday(10, 0))).toBe(false);
  });
});

describe('parseHHmm', () => {
  it('convertit en minutes', () => {
    expect(parseHHmm('09:30')).toBe(570);
    expect(parseHHmm('9:05')).toBe(545);
    expect(parseHHmm('24:00')).toBe(1440);
  });
  it('refuse les formats invalides', () => {
    expect(() => parseHHmm('9h30')).toThrow();
    expect(() => parseHHmm('25:00')).toThrow();
    expect(() => parseHHmm('12:60')).toThrow();
  });
});

describe('jours fermés du planning', () => {
  const week: ScheduleLike = { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })), closedDates: ['2026-11-11'] };
  it("un jour fermé du planning n'est jamais travaillé", () => {
    expect(isWithinSchedule(week, Date.parse('2026-11-11T10:00:00Z'))).toBe(false); // mercredi férié
    expect(isWithinSchedule(week, Date.parse('2026-11-12T10:00:00Z'))).toBe(true);
  });
  it('la prochaine ouverture saute le jour fermé', () => {
    expect(new Date(nextWorkingTime(week, Date.parse('2026-11-10T19:30:00Z'))!).toISOString()).toBe('2026-11-12T08:00:00.000Z');
  });
});

describe('workingElapsedMs (SLA suspendu hors horaires)', () => {
  const sched: ScheduleLike = { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })) };
  const t = (iso: string) => Date.parse(iso);
  const MIN = 60_000;
  it('pendant les horaires : le temps réel écoulé', () => expect(workingElapsedMs(sched, t('2026-10-07T08:00:00Z'), t('2026-10-07T08:07:00Z'))).toBe(7 * MIN));
  it("hors horaires : rien ne s'écoule", () => {
    expect(workingElapsedMs(sched, t('2026-10-07T18:00:00Z'), t('2026-10-08T05:00:00Z'))).toBe(0); // 20:00 → 07:00 Paris
  });
  it('à cheval sur la fermeture : seule la part ouvrée compte', () => {
    // 18:55 Paris (16:55Z) → lendemain 09:05 Paris (07:05Z) : 5 min avant 19:00, 5 min après 09:00
    expect(workingElapsedMs(sched, t('2026-10-07T16:55:00Z'), t('2026-10-08T07:05:00Z'))).toBe(10 * MIN);
  });
  it('week-end : ignoré ; semaine entière = 5 jours de 10 h', () => {
    expect(workingElapsedMs(sched, t('2026-10-10T08:00:00Z'), t('2026-10-11T20:00:00Z'))).toBe(0);
    expect(workingElapsedMs(sched, t('2026-10-05T00:00:00Z'), t('2026-10-10T00:00:00Z'))).toBe(5 * 10 * 60 * MIN);
  });
  it('pauses et jours fermés déduits', () => {
    const lunch: ScheduleLike = { ...sched, breaks: [{ day: 3, start: '12:00', end: '14:00' }], closedDates: ['2026-10-08'] };
    expect(workingElapsedMs(lunch, t('2026-10-07T00:00:00Z'), t('2026-10-08T22:00:00Z'))).toBe(8 * 60 * MIN); // mercredi 10 h − 2 h de pause ; jeudi fermé
  });
  it("heure d'été : changement d'heure du 25 octobre 2026 pris en compte", () => {
    // dimanche : fermé. Lundi 26 (UTC+1) 09:00 Paris = 08:00Z ; vendredi 23 (UTC+2) 19:00 Paris = 17:00Z
    expect(workingElapsedMs(sched, t('2026-10-23T16:00:00Z'), t('2026-10-26T09:00:00Z'))).toBe(60 * MIN + 60 * MIN);
  });
  it('intervalle vide ou inversé, planning vide : 0', () => {
    expect(workingElapsedMs(sched, t('2026-10-07T09:00:00Z'), t('2026-10-07T09:00:00Z'))).toBe(0);
    expect(workingElapsedMs(sched, t('2026-10-07T10:00:00Z'), t('2026-10-07T09:00:00Z'))).toBe(0);
    expect(workingElapsedMs({ ...sched, weekly: [] }, 0, 1e12)).toBe(0);
  });
});
