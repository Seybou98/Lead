import { describe, expect, it } from 'vitest';
import { isWithinSchedule, localDateString, localDayAndMinutes, parseHHmm } from './schedule';

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

describe('heure locale (heure d\'été incluse)', () => {
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
  it('pause déclarée à l\'intérieur d\'un créneau', () => {
    expect(isWithinSchedule(schedule, wednesday(10, 5))).toBe(false);
    expect(isWithinSchedule(schedule, wednesday(10, 15))).toBe(true);
  });
  it('week-end : hors horaires', () => {
    const saturday = Date.UTC(2026, 9, 10, 8, 0);
    expect(isWithinSchedule(schedule, saturday)).toBe(false);
  });
  it('jour fermé de l\'entreprise', () => {
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
