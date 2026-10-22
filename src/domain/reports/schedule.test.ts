import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  coerceSchedulesInput,
  dateKey,
  describeSchedule,
  dueOccurrence,
  emailParams,
  emailsSettled,
  localParts,
  manualRunId,
  MAX_EMAIL_ATTEMPTS,
  MAX_RECIPIENTS,
  newScheduleId,
  nextOccurrence,
  parseSchedules,
  rollingRange,
  runId,
  startOfLocalDay,
  validateSchedules,
  zonedToMs,
  type ExportRun,
  type ScheduledExport,
} from './schedule';

const paris = (y: number, m: number, d: number, h = 0, mi = 0) => zonedToMs(y, m, d, h, mi);
const base = (over: Partial<ScheduledExport> = {}): ScheduledExport => ({
  id: 's_1', name: 'Direction du lundi', kind: 'direction', format: 'csv', frequency: 'weekly', weekday: 1, dayOfMonth: 1, time: '08:00', period: 'previous_week',
  mode: 'event', sourceId: '', product: '', corrected: true, detail: false, recipients: ['u1'], active: true, endDate: '', createdAtMs: paris(2026, 10, 1), ...over,
});

describe('fuseau Europe/Paris', () => {
  it('minuit local, été (UTC+2) et hiver (UTC+1)', () => {
    expect(new Date(paris(2026, 7, 14)).toISOString()).toBe('2026-07-13T22:00:00.000Z');
    expect(new Date(paris(2026, 12, 14)).toISOString()).toBe('2026-12-13T23:00:00.000Z');
  });
  it('lecture locale d’un instant : jour, heure, jour de semaine', () => {
    expect(localParts(Date.UTC(2026, 9, 22, 22, 30))).toMatchObject({ y: 2026, m: 10, d: 23, h: 0, mi: 30, weekday: 5 });
  });
  it('jours hors du mois ramenés dans le calendrier', () => {
    expect(dateKey(paris(2026, 10, 32))).toBe('2026-11-01');
    expect(dateKey(paris(2026, 3, 0))).toBe('2026-02-28');
  });
  it('journée de changement d’heure : 23 h ou 25 h, les jours restent entiers', () => {
    const spring = paris(2026, 3, 29);
    expect(addLocalDays(spring, 1) - spring).toBe(23 * 3_600_000);
    const autumn = paris(2026, 10, 25);
    expect(addLocalDays(autumn, 1) - autumn).toBe(25 * 3_600_000);
    expect(startOfLocalDay(paris(2026, 10, 25, 12))).toBe(autumn);
  });
});

describe('période glissante', () => {
  const at = paris(2026, 10, 22, 8); // jeudi 22 octobre 2026
  it('veille et 7 / 30 jours : jours complets, aujourd’hui exclu', () => {
    expect(rollingRange('previous_day', at)).toEqual({ fromMs: paris(2026, 10, 21), toMs: paris(2026, 10, 22) });
    expect(rollingRange('last_7d', at)).toEqual({ fromMs: paris(2026, 10, 15), toMs: paris(2026, 10, 22) });
    expect(rollingRange('last_30d', at)).toEqual({ fromMs: paris(2026, 9, 22), toMs: paris(2026, 10, 22) });
  });
  it('semaine précédente : lundi au dimanche', () => {
    expect(rollingRange('previous_week', at)).toEqual({ fromMs: paris(2026, 10, 12), toMs: paris(2026, 10, 19) });
    // Un lundi : la semaine qui vient de finir, pas la précédente.
    expect(rollingRange('previous_week', paris(2026, 10, 19, 8))).toEqual({ fromMs: paris(2026, 10, 12), toMs: paris(2026, 10, 19) });
    // Un dimanche : la semaine d’avant.
    expect(rollingRange('previous_week', paris(2026, 10, 25, 8))).toEqual({ fromMs: paris(2026, 10, 12), toMs: paris(2026, 10, 19) });
  });
  it('mois précédent, y compris en janvier', () => {
    expect(rollingRange('previous_month', at)).toEqual({ fromMs: paris(2026, 9, 1), toMs: paris(2026, 10, 1) });
    expect(rollingRange('previous_month', paris(2026, 1, 5, 8))).toEqual({ fromMs: paris(2025, 12, 1), toMs: paris(2026, 1, 1) });
  });
  it('mois en cours : jusqu’à l’exécution', () => {
    expect(rollingRange('month_to_date', at)).toEqual({ fromMs: paris(2026, 10, 1), toMs: at });
  });
  it('à 00:30 locale, le jour est déjà le nouveau (pas la veille UTC)', () => {
    const night = paris(2026, 10, 23, 0, 30);
    expect(rollingRange('previous_day', night)).toEqual({ fromMs: paris(2026, 10, 22), toMs: paris(2026, 10, 23) });
  });
});

describe('échéances', () => {
  it('hebdomadaire : le lundi à 08:00, heure de Paris', () => {
    const s = base();
    const mondayNoon = paris(2026, 10, 19, 12);
    const occ = dueOccurrence(s, mondayNoon);
    expect(occ).toEqual({ atMs: paris(2026, 10, 19, 8), key: '202610190800' });
    expect(dueOccurrence(s, paris(2026, 10, 19, 7, 59))).toBeNull(); // la veille n’est plus rattrapable : plus de 24 h
  });
  it('pas encore l’heure le jour J : rien (et pas la semaine précédente, trop ancienne)', () => {
    expect(dueOccurrence(base(), paris(2026, 10, 26, 7, 59))).toBeNull();
    expect(dueOccurrence(base(), paris(2026, 10, 26, 8, 0))?.key).toBe('202610260800');
  });
  it('rattrapage limité à 24 h après l’heure prévue', () => {
    const s = base();
    expect(dueOccurrence(s, paris(2026, 10, 20, 7, 59))).not.toBeNull();
    expect(dueOccurrence(s, paris(2026, 10, 20, 8, 1))).toBeNull();
  });
  it('quotidien et mensuel', () => {
    expect(dueOccurrence(base({ frequency: 'daily', time: '06:30' }), paris(2026, 10, 22, 6, 31))?.key).toBe('202610220630');
    const monthly = base({ frequency: 'monthly', dayOfMonth: 5, time: '09:00' });
    expect(dueOccurrence(monthly, paris(2026, 11, 5, 9, 5))?.key).toBe('202611050900');
    expect(dueOccurrence(monthly, paris(2026, 11, 6, 10))).toBeNull();
  });
  it('jamais avant la création du rapport', () => {
    const s = base({ createdAtMs: paris(2026, 10, 19, 9) });
    expect(dueOccurrence(s, paris(2026, 10, 19, 12))).toBeNull();
    expect(dueOccurrence(base({ createdAtMs: paris(2026, 10, 19, 7) }), paris(2026, 10, 19, 12))).not.toBeNull();
  });
  it('suspendu ou terminé : rien', () => {
    expect(dueOccurrence(base({ active: false }), paris(2026, 10, 19, 12))).toBeNull();
    expect(dueOccurrence(base({ endDate: '2026-10-18' }), paris(2026, 10, 19, 12))).toBeNull();
    expect(dueOccurrence(base({ endDate: '2026-10-19' }), paris(2026, 10, 19, 12))).not.toBeNull();
  });
  it('heure d’été : 08:00 à Paris est 06:00 UTC en octobre, 07:00 UTC en décembre', () => {
    expect(new Date(dueOccurrence(base({ frequency: 'daily' }), paris(2026, 10, 22, 9))!.atMs).toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(new Date(dueOccurrence(base({ frequency: 'daily', createdAtMs: paris(2026, 11, 1) }), paris(2026, 12, 3, 9))!.atMs).toISOString()).toBe('2026-12-03T07:00:00.000Z');
  });
  it('prochaine échéance', () => {
    const next = nextOccurrence(base(), paris(2026, 10, 22, 10));
    expect(next).toEqual({ atMs: paris(2026, 10, 26, 8), key: '202610260800' });
    expect(nextOccurrence(base({ endDate: '2026-10-25' }), paris(2026, 10, 22, 10))).toBeNull();
    expect(nextOccurrence(base({ active: false }), paris(2026, 10, 22, 10))).toBeNull();
  });
});

describe('texte', () => {
  it('décrit la fréquence', () => {
    expect(describeSchedule(base())).toBe('Tous les lundis à 08:00');
    expect(describeSchedule(base({ frequency: 'daily' }))).toBe('Tous les jours à 08:00');
    expect(describeSchedule(base({ frequency: 'monthly', dayOfMonth: 1 }))).toBe('Le 1er de chaque mois à 08:00');
    expect(describeSchedule(base({ frequency: 'monthly', dayOfMonth: 15 }))).toBe('Le 15 de chaque mois à 08:00');
  });
});

describe('lecture et validation', () => {
  it('lecture tolérante : le mal formé est ignoré, les valeurs sont bornées', () => {
    const list = parseSchedules({ schedules: [base(), { id: 'x' }, null, { ...base({ id: 's_2' }), time: '25:00' }, { ...base({ id: 's_3' }), weekday: 99, dayOfMonth: 40 }, base()] });
    expect(list.map((s) => s.id)).toEqual(['s_1', 's_3']);
    expect(list[1]).toMatchObject({ weekday: 1, dayOfMonth: 1 });
    expect(parseSchedules(null)).toEqual([]);
    expect(parseSchedules({ schedules: 'x' })).toEqual([]);
  });
  it('un rapport valide ne produit aucune erreur', () => {
    expect(validateSchedules([base()])).toEqual([]);
  });
  it('erreurs lisibles', () => {
    expect(validateSchedules([base({ recipients: [] })])[0]).toMatch(/destinataire/);
    expect(validateSchedules([base({ time: '8h' })])[0]).toMatch(/HH:MM/);
    expect(validateSchedules([base({ name: 'A' })])[0]).toMatch(/nom/);
    expect(validateSchedules([base({ frequency: 'monthly', dayOfMonth: 31 })])[0]).toMatch(/1 à 28/);
    expect(validateSchedules([base({ frequency: 'weekly', weekday: 0 })])[0]).toMatch(/jour de la semaine/);
    expect(validateSchedules([base({ endDate: '18/10/2026' })])[0]).toMatch(/AAAA-MM-JJ/);
    expect(validateSchedules([base(), base()])[0]).toMatch(/double/);
    expect(validateSchedules([base({ recipients: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}`) })])[0]).toMatch(/destinataires/);
  });
  it('la saisie est lue telle quelle, puis refusée si elle est fausse (rien n’est corrigé en silence)', () => {
    const input = coerceSchedulesInput({ schedules: [{ ...base(), weekday: 'lundi' }] });
    expect(Number.isNaN(input[0].weekday)).toBe(true);
    expect(validateSchedules(input)[0]).toMatch(/jour de la semaine/);
  });
  it('identifiant libre suivant', () => {
    expect(newScheduleId(new Set(['s_1', 's_2']))).toBe('s_3');
    expect(newScheduleId(new Set())).toBe('s_1');
  });
});

describe('exécution et message', () => {
  const run = (over: Partial<ExportRun> = {}): ExportRun => ({
    id: 's_1_202610190800', scheduleId: 's_1', scheduleName: 'Direction du lundi', kind: 'direction', format: 'csv', atMs: paris(2026, 10, 19, 8), occurrence: '202610190800', trigger: 'schedule', actorId: null,
    fromMs: paris(2026, 10, 12), toMs: paris(2026, 10, 19), status: 'ready', error: null, notes: [], expiresAtMs: 0,
    files: [{ scope: 'all', path: 'p', filename: 'direction.csv', mime: 'text/csv', bytes: 10, rows: 12, recipients: [{ uid: 'u1', email: 'a@b.fr', status: 'pending', attempts: 0, lastAttemptMs: null, error: null }] }], ...over,
  });
  it('identifiants d’exécution : un par échéance, un par exécution manuelle', () => {
    expect(runId('s_1', '202610190800')).toBe('s_1_202610190800');
    expect(manualRunId('s_1', 5)).toBe('s_1_m5');
  });
  it('paramètres du message : lien, destinataire, période, jamais le fichier', () => {
    const r = run();
    const p = emailParams({ run: r, file: r.files[0], recipient: { name: 'Awa', email: 'a@b.fr' }, link: 'https://crm/rapports/export/x?f=0' });
    expect(p).toMatchObject({ to_email: 'a@b.fr', email: 'a@b.fr', to_name: 'Awa', link: 'https://crm/rapports/export/x?f=0', download_url: 'https://crm/rapports/export/x?f=0', rows: '12', format: 'CSV' });
    expect(p.period).toBe('12/10/2026 au 18/10/2026');
    expect(p.message).toContain('https://crm/rapports/export/x?f=0');
    expect(p.subject).toContain('Direction du lundi');
  });
  it('envois terminés : tous envoyés, ou échec définitif après les tentatives permises', () => {
    expect(emailsSettled(run())).toBe(false);
    const sent = run();
    sent.files[0].recipients[0].status = 'sent';
    expect(emailsSettled(sent)).toBe(true);
    const failing = run();
    Object.assign(failing.files[0].recipients[0], { status: 'error', attempts: MAX_EMAIL_ATTEMPTS - 1 });
    expect(emailsSettled(failing)).toBe(false);
    failing.files[0].recipients[0].attempts = MAX_EMAIL_ATTEMPTS;
    expect(emailsSettled(failing)).toBe(true);
  });
});
