import { describe, expect, it } from 'vitest';
import { formatHour, formatWeeklySchedule } from './scheduleFormat';

const slot = (day: number, start: string, end: string) => ({ day, start, end });
const weekdays = (start: string, end: string) => [1, 2, 3, 4, 5].map((d) => slot(d, start, end));

describe('formatHour', () => {
  it('retire le zéro initial', () => {
    expect(formatHour('08:00')).toBe('8h00');
    expect(formatHour('18:30')).toBe('18h30');
    expect(formatHour('00:00')).toBe('0h00');
  });
  it('valeur inattendue : renvoyée telle quelle', () => expect(formatHour('9h')).toBe('9h'));
});

describe('formatWeeklySchedule', () => {
  it('exemple de la maquette (fig. 16)', () => {
    expect(formatWeeklySchedule([...weekdays('08:00', '20:00'), slot(6, '09:00', '18:00')])).toBe('Lun.–Ven. : 8h00–20h00, Sam. : 9h00–18h00');
  });
  it('un seul jour', () => expect(formatWeeklySchedule([slot(3, '09:00', '12:00')])).toBe('Mer. : 9h00–12h00'));
  it('jours non consécutifs avec les mêmes heures : deux groupes distincts', () => {
    expect(formatWeeklySchedule([slot(1, '09:00', '18:00'), slot(3, '09:00', '18:00')])).toBe('Lun. : 9h00–18h00, Mer. : 9h00–18h00');
  });
  it('le dimanche vient en dernier, après le samedi (semaine française)', () => {
    expect(formatWeeklySchedule([slot(0, '10:00', '12:00'), slot(6, '10:00', '12:00')])).toBe('Sam.–Dim. : 10h00–12h00');
  });
  it('plusieurs plages le même jour : toutes affichées, dans l\'ordre', () => {
    expect(formatWeeklySchedule([slot(1, '14:00', '18:00'), slot(1, '09:00', '12:00')])).toBe('Lun. : 9h00–12h00 et 14h00–18h00');
  });
  it('l\'ordre d\'entrée n\'a pas d\'importance', () => {
    const a = formatWeeklySchedule([slot(5, '09:00', '18:00'), slot(1, '09:00', '18:00'), slot(3, '09:00', '18:00'), slot(2, '09:00', '18:00'), slot(4, '09:00', '18:00')]);
    expect(a).toBe('Lun.–Ven. : 9h00–18h00');
  });
  it('aucun horaire', () => expect(formatWeeklySchedule([])).toBe('Aucun horaire défini'));
});
