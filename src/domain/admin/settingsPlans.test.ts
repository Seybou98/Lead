import { describe, expect, it } from 'vitest';
import { AdminRuleError, planChecklistSave, planQualificationDiscard, planQualificationDraftSave, planQualificationPublish, planReasonsSave, planReportsSave, planExportsSave, planRulesSave, qualificationKey, planSlaOverrideSave, planSlaSave } from './plans';
import { versionsOf, type AuditRow } from '../settings/versions';
import { blankField, type QualificationForm } from '../qualification/form';
import { toStored, DEFAULT_REASON_SETTINGS } from '../settings/reasons';
import { DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS } from '../settings/settings';

const NOW = Date.UTC(2026, 9, 8, 10, 0);
const refusal = (fn: () => unknown): AdminRuleError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AdminRuleError) return e;
    throw e;
  }
  throw new Error('un refus était attendu');
};
const sla = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_SLA_SETTINGS, ...over });

describe('planSlaSave', () => {
  it('enregistre, trace l\'auteur et l\'ancienne valeur', () => {
    const before = { firstAlertMin: 5 };
    const p = planSlaSave({ input: sla({ firstAlertMin: 4, reason: 'Test' }), before, actorId: 'adm', nowMs: NOW });
    expect(p.doc).toMatchObject({ firstAlertMin: 4, criticalMin: 10, updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.sla.update', entityType: 'settings', entityId: 'sla', before, reason: 'Test' });
    expect(planSlaSave({ input: sla(), before: null, actorId: 'adm', nowMs: NOW }).audit.action).toBe('settings.sla.create');
  });
  it('saisie texte d\'un formulaire acceptée (« 5 » → 5) ; texte non numérique refusé', () => {
    expect(planSlaSave({ input: sla({ firstAlertMin: '6' }), before: null, actorId: 'a', nowMs: NOW }).doc.firstAlertMin).toBe(6);
    expect(refusal(() => planSlaSave({ input: sla({ firstAlertMin: 'abc' }), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
    expect(refusal(() => planSlaSave({ input: sla({ criticalMin: '' }), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
  it('jamais corrigé en silence : paliers non croissants, plage inversée, fuseau inconnu, plages qui se chevauchent', () => {
    const bad: Record<string, unknown>[] = [
      { criticalMin: 3 },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, weekly: [{ day: 1, start: '19:00', end: '09:00' }] } },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, timezone: 'Mars/Olympus' } },
      { schedule: { ...DEFAULT_SLA_SETTINGS.schedule, weekly: [{ day: 1, start: '09:00', end: '13:00' }, { day: 1, start: '12:00', end: '18:00' }] } },
      { outsideHours: 'bogus' },
      { outsideHours: 'duty_team', fallbackTeamId: null },
    ];
    for (const b of bad) expect(refusal(() => planSlaSave({ input: sla(b), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
  it('jours fermés dédoublonnés et triés', () => {
    const p = planSlaSave({ input: sla({ schedule: { ...DEFAULT_SLA_SETTINGS.schedule, closedDates: ['2026-12-25', '2026-11-11', '2026-12-25'] } }), before: null, actorId: 'a', nowMs: NOW });
    expect((p.doc.schedule as { closedDates: string[] }).closedDates).toEqual(['2026-11-11', '2026-12-25']);
  });
});

describe('planSlaOverrideSave', () => {
  const run = (input: unknown, general = DEFAULT_SLA_SETTINGS) => planSlaOverrideSave({ campaignId: 'c1', input, general, before: null, actorId: 'adm', nowMs: NOW });
  it('enregistre seulement la réattribution de la campagne', () => {
    const p = run({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2', firstAlertMin: 1 });
    expect(p.doc).toMatchObject({ autoReassign: true, reassignMin: 20, maxReassignments: 1, fallbackTeamId: 't2', campaignId: 'c1', updatedBy: 'adm' });
    expect('firstAlertMin' in p.doc).toBe(false);
    expect(p.audit).toMatchObject({ action: 'settings.sla.campaign.create', entityId: 'sla_c1' });
  });
  it('valeurs hors bornes refusées avec un message, pas ignorées', () => {
    expect(refusal(() => run({ reassignMin: 5000 })).message).toMatch(/960/);
    expect(refusal(() => run({ maxReassignments: 30 })).message).toMatch(/0 à 10/);
  });
  it('équipe de garde exigée par les réglages généraux : une campagne ne peut pas retirer l\'équipe de secours', () => {
    const general = { ...DEFAULT_SLA_SETTINGS, outsideHours: 'duty_team' as const, fallbackTeamId: 't1' };
    expect(refusal(() => run({ fallbackTeamId: null }, general)).code).toBe('invalid-argument');
  });
});

describe('planRulesSave', () => {
  const rules = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_RULES_SETTINGS, ...over });
  it('enregistre la matrice NR et les délais', () => {
    const p = planRulesSave({ input: rules({ nrDelaysMinutes: [60, 120, 180, 240], followUpDays: [2, 4, 9] }), before: null, actorId: 'adm', nowMs: NOW });
    expect(p.doc).toMatchObject({ nrDelaysMinutes: [60, 120, 180, 240], followUpDays: [2, 4, 9], updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.rules.create', entityId: 'rules' });
  });
  it('refus : délai NR invalide, cycles, échéances décroissantes, matrice incomplète', () => {
    const bad: Record<string, unknown>[] = [{ nrDelaysMinutes: [0, 1, 1, 1] }, { nrDelaysMinutes: [60, 60] }, { maxRecycleCycles: 0 }, { followUpDays: [5, 3] }, { followUpDays: [1] }, { recycleAfterDays: 'x' }];
    for (const b of bad) expect(refusal(() => planRulesSave({ input: rules(b), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
});

describe('planReasonsSave', () => {
  const withRefusal = (items: unknown[]) => ({ lists: { ...toStored(DEFAULT_REASON_SETTINGS).lists, refusal: items } });
  const origin = toStored(DEFAULT_REASON_SETTINGS).lists.refusal;
  it('enregistre une valeur ajoutée et une valeur archivée', () => {
    const items = [...origin.map((i) => (i.code === 'competitor' ? { ...i, active: false } : i)), { code: 'c_deja_equipe', label: 'Déjà équipé', active: true, requireComment: false }];
    const p = planReasonsSave({ input: withRefusal(items), before: null, actorId: 'adm', nowMs: NOW });
    expect(p.audit).toMatchObject({ action: 'settings.reasons.create', entityId: 'reasons' });
    const stored = (p.doc as { lists: Record<string, { code: string; active: boolean }[]> }).lists.refusal;
    expect(stored.find((i) => i.code === 'competitor')?.active).toBe(false);
    expect(stored.some((i) => i.code === 'c_deja_equipe')).toBe(true);
  });
  it('refuse de supprimer une valeur d’origine ou de tout archiver', () => {
    expect(refusal(() => planReasonsSave({ input: withRefusal(origin.filter((i) => i.code !== 'price')), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
    expect(refusal(() => planReasonsSave({ input: withRefusal(origin.map((i) => ({ ...i, active: false }))), before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument');
  });
});

describe('retour arrière : une version rétablie repasse par la validation et recrée la même valeur', () => {
  // Le journal d'audit stocke les documents après un aller-retour JSON (dates en texte) : on rejoue exactement cela.
  const audited = (a: { audit: { before: unknown; after: unknown; action: string; entityType: string; entityId: string; reason: string | null } }, id: string, atMs: number): AuditRow => ({ id, atMs, actorId: 'adm', ...a.audit, before: JSON.parse(JSON.stringify(a.audit.before)), after: JSON.parse(JSON.stringify(a.audit.after)) } as AuditRow);

  it('SLA et horaires', () => {
    const v1 = planSlaSave({ input: sla({ firstAlertMin: 5 }), before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planSlaSave({ input: sla({ firstAlertMin: 9, criticalMin: 20, reassignMin: 40 }), before: v1.doc, actorId: 'adm', nowMs: NOW + 1000 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'sla');
    expect(versions[0]).toMatchObject({ number: 2, current: true });
    const back = planSlaSave({ input: { ...versions[1].payload, reason: 'Retour à la version v1' }, before: v2.doc, actorId: 'adm', nowMs: NOW + 2000 });
    expect(back.doc).toMatchObject({ firstAlertMin: 5, criticalMin: 10, reassignMin: 15 });
    expect(back.audit.reason).toBe('Retour à la version v1');
    expect(back.audit.action).toBe('settings.sla.update'); // une nouvelle version, pas une suppression de l'ancienne
  });
  it('cycles NR', () => {
    const v1 = planRulesSave({ input: { ...DEFAULT_RULES_SETTINGS, recycleAfterDays: 7 }, before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planRulesSave({ input: { ...DEFAULT_RULES_SETTINGS, recycleAfterDays: 12, followUpDays: [2, 4, 9] }, before: v1.doc, actorId: 'adm', nowMs: NOW + 1 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'rules');
    const back = planRulesSave({ input: versions[1].payload, before: v2.doc, actorId: 'adm', nowMs: NOW + 2 });
    expect(back.doc).toMatchObject({ recycleAfterDays: 7, followUpDays: [1, 3, 5, 7, 14] });
  });
  it('checklist', () => {
    const v1 = planChecklistSave({ input: { productCode: 'PAC', items: [{ label: 'Identité', mandatory: true }] }, before: null, actorId: 'adm', nowMs: NOW });
    const v2 = planChecklistSave({ input: { productCode: 'PAC', items: [{ code: 'identite', label: 'Identité', mandatory: true }, { label: 'RIB', mandatory: false }] }, before: v1.doc, actorId: 'adm', nowMs: NOW + 1 });
    const versions = versionsOf([audited(v1, 'a', 1), audited(v2, 'b', 2)], 'checklist', 'pac');
    const back = planChecklistSave({ input: versions[1].payload, before: v2.doc, actorId: 'adm', nowMs: NOW + 2 });
    expect((back.doc.items as { label: string }[]).map((i) => i.label)).toEqual(['Identité']);
  });
});

describe('constructeur de qualification : brouillon, publication, abandon', () => {
  const form = (over: Partial<QualificationForm> = {}): QualificationForm => ({ fields: [{ ...blankField('yesno', 'q_owner'), label: 'Êtes-vous propriétaire ?', required: true }], rules: [], ...over });
  const asDoc = (d: Record<string, unknown>) => JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  const args = (input: unknown, before: Record<string, unknown> | null = null) => ({ input, before, actorId: 'adm', nowMs: NOW });

  it('clé du document : une famille = un formulaire, « default » à défaut', () => {
    expect(qualificationKey(null)).toBe('qualification_default');
    expect(qualificationKey('PAC')).toBe('qualification_pac');
  });
  it('brouillon : accepté même avec des anomalies, sans toucher à la version publiée', () => {
    const broken = form({ rules: [{ id: 'r_1', match: 'all', clauses: [], action: 'show', targets: ['q_fantome'], message: '', eligibility: null, compute: null }] });
    const p = planQualificationDraftSave(args({ productCode: 'PAC', form: broken }));
    expect(p.key).toBe('qualification_pac');
    expect(p.audit).toMatchObject({ action: 'qualification.draft', entityType: 'settings', entityId: 'qualification_pac' });
    expect((p.doc.draft as QualificationForm).rules).toHaveLength(1);
    expect(p.doc.published).toBeNull();
    expect(p.doc.version).toBe(0);
  });
  it('brouillon sans formulaire : refusé', () => {
    expect(refusal(() => planQualificationDraftSave(args({ productCode: null }))).code).toBe('invalid-argument');
  });
  it('publication : nouvelle version, brouillon vidé, ancien formulaire conservé dans le journal', () => {
    const draft = planQualificationDraftSave(args({ productCode: 'PAC', form: form() })).doc;
    const p1 = planQualificationPublish(args({ productCode: 'PAC', reason: 'première version' }, asDoc(draft)));
    expect(p1.doc).toMatchObject({ version: 1, draft: null, publishedBy: 'adm' });
    expect(p1.audit).toMatchObject({ action: 'qualification.publish', reason: 'première version' });
    const next = form({ fields: [...form().fields, { ...blankField('text', 'q_note'), label: 'Remarque' }] });
    const p2 = planQualificationPublish(args({ productCode: 'PAC', form: next }, asDoc(p1.doc)));
    expect(p2.doc.version).toBe(2);
    expect((p2.audit.before as { published: QualificationForm }).published.fields).toHaveLength(1);
    expect((p2.audit.after as { published: QualificationForm }).published.fields).toHaveLength(2);
  });
  it('publication refusée : aucun brouillon, formulaire vide, anomalie bloquante', () => {
    expect(refusal(() => planQualificationPublish(args({ productCode: null }))).code).toBe('failed-precondition');
    expect(refusal(() => planQualificationPublish(args({ productCode: null, form: form({ fields: [] }) }))).message).toMatch(/aucun champ/i);
    const circular = form({ fields: [{ ...blankField('yesno', 'q_a'), label: 'Champ A' }], rules: [{ id: 'r_1', match: 'all', clauses: [{ fieldId: 'q_a', op: 'eq', value: true }], action: 'show', targets: ['q_a'], message: '', eligibility: null, compute: null }] });
    const r = refusal(() => planQualificationPublish(args({ productCode: null, form: circular })));
    expect(r.code).toBe('failed-precondition');
    expect(r.message).toMatch(/Publication refusée/);
  });
  it('retour arrière : republier un ancien formulaire crée une NOUVELLE version', () => {
    const v1 = planQualificationPublish(args({ productCode: null, form: form() })).doc;
    const v2 = planQualificationPublish(args({ productCode: null, form: form({ fields: [{ ...blankField('text', 'q_x'), label: 'Autre champ' }] }) }, asDoc(v1))).doc;
    const back = planQualificationPublish(args({ productCode: null, form: form() }, asDoc(v2)));
    expect(back.doc.version).toBe(3);
  });
  it('abandon du brouillon : seulement s’il existe', () => {
    expect(refusal(() => planQualificationDiscard(args({ productCode: null }))).code).toBe('not-found');
    const withDraft = asDoc(planQualificationDraftSave(args({ productCode: null, form: form() })).doc);
    const d = planQualificationDiscard(args({ productCode: null }, withDraft));
    expect(d.doc.draft).toBeNull();
    expect(d.audit.action).toBe('qualification.discard');
  });
});

describe('planReportsSave : objectifs et alertes KPI', () => {
  const alert = (over: Record<string, unknown> = {}) => ({ id: 'a_1', metric: 'costPerSale', mode: 'value', op: 'gt', threshold: 500, minVolume: 10, days: 7, level: 'warning', active: true, ...over });
  const objective = (over: Record<string, unknown> = {}) => ({ id: 'o_1', month: '2026-10', scope: 'global', scopeId: '', metric: 'sales', target: 40, active: true, ...over });
  const save = (input: unknown, before: Record<string, unknown> | null = null) => planReportsSave({ input, before, actorId: 'adm', nowMs: NOW });

  it('enregistre alertes et objectifs, avec audit', () => {
    const p = save({ alerts: [alert()], objectives: [objective()], reason: 'Cibles d’octobre' });
    expect(p.doc).toMatchObject({ alerts: [{ id: 'a_1', threshold: 500, minVolume: 10 }], objectives: [{ id: 'o_1', target: 40 }], updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.reports.create', entityType: 'settings', entityId: 'reports', reason: 'Cibles d’octobre' });
    expect(save({ alerts: [], objectives: [] }, p.doc as Record<string, unknown>).audit.action).toBe('settings.reports.update');
  });
  it('liste d’alertes vide : acceptée (l’administrateur peut tout désactiver)', () => {
    expect((save({ alerts: [], objectives: [] }).doc as { alerts: unknown[] }).alerts).toEqual([]);
  });
  it('refus : seuil, volume, cible, périmètre, doublon, coût par télépro', () => {
    const bad: Record<string, unknown>[] = [
      { alerts: [alert({ threshold: 'x' })], objectives: [] },
      { alerts: [alert({ minVolume: -3 })], objectives: [] },
      { alerts: [alert(), alert()], objectives: [] },
      { alerts: [], objectives: [objective({ target: 0 })] },
      { alerts: [], objectives: [objective({ scope: 'campaign' })] },
      { alerts: [], objectives: [objective(), objective({ id: 'o_2' })] },
      { alerts: [], objectives: [objective({ metric: 'costPerSale', scope: 'owner', scopeId: 'u1', target: 400 })] },
    ];
    for (const b of bad) expect(refusal(() => save(b)).code).toBe('invalid-argument');
  });
  it('un retour arrière rejoue la valeur enregistrée (versions et journal)', () => {
    const v1 = save({ alerts: [alert()], objectives: [objective()] });
    const v2 = save({ alerts: [alert({ threshold: 450 })], objectives: [] }, JSON.parse(JSON.stringify(v1.doc)));
    const back = save(JSON.parse(JSON.stringify(v1.doc)), JSON.parse(JSON.stringify(v2.doc)));
    expect(back.doc).toMatchObject({ alerts: [{ threshold: 500 }], objectives: [{ id: 'o_1' }] });
  });
});

describe('planExportsSave : rapports programmés', () => {
  const sched = (over: Record<string, unknown> = {}) => ({ id: 's_1', name: 'Direction du lundi', kind: 'direction', format: 'csv', frequency: 'weekly', weekday: 1, dayOfMonth: 1, time: '08:00', period: 'previous_week', mode: 'event', sourceId: '', product: '', corrected: true, detail: false, recipients: ['u1'], active: true, endDate: '', ...over });
  const save = (input: unknown, before: Record<string, unknown> | null = null, nowMs = NOW) => planExportsSave({ input, before, actorId: 'adm', nowMs });
  type Stored = { schedules: { id: string; createdAtMs: number }[] };

  it('enregistre avec audit ; un rapport nouveau démarre de maintenant', () => {
    const p = save({ schedules: [sched()] });
    expect((p.doc as Stored).schedules[0]).toMatchObject({ id: 's_1', createdAtMs: NOW });
    expect(p.audit).toMatchObject({ action: 'settings.exports.create', entityType: 'settings', entityId: 'exports' });
    expect(save({ schedules: [] }, p.doc as Record<string, unknown>).audit.action).toBe('settings.exports.update');
  });
  it('rapport inchangé : sa date de création est conservée (aucune échéance perdue ni rejouée)', () => {
    const first = save({ schedules: [sched()] }, null, NOW);
    const again = save({ schedules: [sched()] }, first.doc as Record<string, unknown>, NOW + 86_400_000);
    expect((again.doc as Stored).schedules[0].createdAtMs).toBe(NOW);
  });
  it('rapport modifié, suspendu ou réactivé : repart de maintenant, sans rattrapage', () => {
    const first = save({ schedules: [sched()] }, null, NOW);
    for (const change of [{ time: '09:00' }, { active: false }, { recipients: ['u1', 'u2'] }]) {
      const next = save({ schedules: [sched(change)] }, first.doc as Record<string, unknown>, NOW + 5_000);
      expect((next.doc as Stored).schedules[0].createdAtMs).toBe(NOW + 5_000);
    }
  });
  it('refus : sans destinataire, heure fausse, doublon', () => {
    for (const bad of [[sched({ recipients: [] })], [sched({ time: '8h' })], [sched(), sched()]]) expect(refusal(() => save({ schedules: bad })).code).toBe('invalid-argument');
  });
  it('liste vide acceptée : l’administrateur peut tout supprimer', () => {
    expect((save({ schedules: [] }).doc as Stored).schedules).toEqual([]);
  });
});
