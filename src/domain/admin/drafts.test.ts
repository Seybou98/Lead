import { describe, expect, it } from 'vitest';
import { planDraftDiscard, planDraftPublish, planDraftSave } from './drafts';
import { AdminRuleError } from './plans';
import { draftChanges, hasBlocking, impactOf, isStale, parseDraft, simulateDraft } from '../settings/publication';
import { DEFAULT_RULES_SETTINGS, DEFAULT_SLA_SETTINGS } from '../settings/settings';
import { defaultTemplates } from '../messages/templates';
import { BUILTIN_REASONS } from '../settings/reasons';
import type { LeadListItem } from '../leads/leadList';

const NOW = Date.UTC(2026, 9, 22, 10, 0);
const refusal = (fn: () => unknown): AdminRuleError => { try { fn(); } catch (e) { return e as AdminRuleError; } throw new Error('pas de refus'); };
const published = { ...JSON.parse(JSON.stringify(DEFAULT_SLA_SETTINGS)), updatedAt: new Date(NOW - 86_400_000), updatedBy: 'adm' };
const save = (input: unknown, before: Record<string, unknown> | null = published, nowMs = NOW) => planDraftSave({ module: 'sla', input, before, actorId: 'adm', nowMs });
const leadOf = (id: string, over: Partial<LeadListItem> = {}): LeadListItem => ({
  id, fullName: id, phone: null, email: null, city: '', postalCode: '', campaignId: null, productCode: 'PAC', status: 'new', temperature: null, assignmentState: 'assigned', bufferReason: null, ownerId: 'u1',
  receivedAtMs: NOW - 8 * 60_000, slaStartedAtMs: NOW - 8 * 60_000, slaStoppedAtMs: null, nextAction: null, documentsState: 'none', duplicate: false, excluded: false, ...over,
});

describe('enregistrement d’un brouillon', () => {
  it('le brouillon est un document à part : le réglage publié n’est pas touché', () => {
    const p = save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: 8 });
    expect(p.id).toBe('draft_sla');
    expect(p.doc).toMatchObject({ module: 'sla', atMs: NOW, byId: 'adm', baseMs: NOW - 86_400_000 });
    expect((p.doc.doc as { firstAlertMin: number }).firstAlertMin).toBe(8);
    expect(p.audit).toMatchObject({ action: 'settings.draft.save', entityType: 'settings_draft', entityId: 'sla' });
  });
  it('mêmes contrôles de forme que la publication : saisie invalide refusée', () => {
    expect(refusal(() => save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: -3 })).code).toBe('invalid-argument');
  });
  it('module inconnu refusé', () => expect(refusal(() => planDraftSave({ module: 'zzz', input: {}, before: null, actorId: 'a', nowMs: NOW })).code).toBe('invalid-argument'));
  it('sans réglage publié : base à zéro', () => expect(save(DEFAULT_SLA_SETTINGS, null).doc.baseMs).toBe(0));
});

describe('publication', () => {
  const draft = () => save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: 8 }).doc;
  it('publie la saisie du brouillon avec la trace d’un enregistrement ordinaire et la justification', () => {
    const p = planDraftPublish({ module: 'sla', draft: draft(), before: published, actorId: 'adm', nowMs: NOW + 1000, reason: 'Allonger le délai' });
    expect(p.id).toBe('sla');
    expect(p.draftId).toBe('draft_sla');
    expect(p.doc).toMatchObject({ firstAlertMin: 8, updatedBy: 'adm' });
    expect(p.audit).toMatchObject({ action: 'settings.sla.update', entityType: 'settings', entityId: 'sla', reason: 'Allonger le délai' });
  });
  it('justification obligatoire ; pas de brouillon : refusé', () => {
    expect(refusal(() => planDraftPublish({ module: 'sla', draft: draft(), before: published, actorId: 'a', nowMs: NOW, reason: ' ' })).code).toBe('invalid-argument');
    expect(refusal(() => planDraftPublish({ module: 'sla', draft: null, before: published, actorId: 'a', nowMs: NOW, reason: 'x y z' })).code).toBe('not-found');
  });
  it('réglage publié modifié depuis le brouillon : refusé (rien n’est écrasé en silence), sauf décision explicite', () => {
    const changed = { ...published, updatedAt: new Date(NOW - 1000) };
    expect(refusal(() => planDraftPublish({ module: 'sla', draft: draft(), before: changed, actorId: 'a', nowMs: NOW, reason: 'Raison' })).code).toBe('failed-precondition');
    expect(planDraftPublish({ module: 'sla', draft: draft(), before: changed, actorId: 'a', nowMs: NOW, reason: 'Raison', force: true }).id).toBe('sla');
  });
  it('abandon : retire le brouillon, trace ; sans brouillon, refusé', () => {
    expect(planDraftDiscard({ module: 'sla', draft: draft(), actorId: 'a' })).toMatchObject({ draftId: 'draft_sla', audit: { action: 'settings.draft.discard' } });
    expect(refusal(() => planDraftDiscard({ module: 'sla', draft: null, actorId: 'a' })).code).toBe('not-found');
  });
  it('lecture du brouillon et détection du décalage', () => {
    const d = parseDraft({ ...draft(), doc: draft().doc });
    expect(d).not.toBeNull();
    expect(isStale(d!, NOW - 86_400_000)).toBe(false);
    expect(isStale(d!, NOW)).toBe(true);
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft({ doc: {}, atMs: 1 })).toBeNull();
  });
});

describe('simulation (données fictives, rien n’est créé)', () => {
  it('SLA : exemples chiffrés et anomalies', () => {
    const s = simulateDraft('sla', { ...DEFAULT_SLA_SETTINGS, firstAlertMin: 30, criticalMin: 40, reassignMin: 50, autoReassign: true, fallbackTeamId: null });
    expect(s.examples[0]).toContain('première alerte après 30 min');
    expect(s.checks.some((c) => c.level === 'warning' && c.text.includes('équipe de secours'))).toBe(true);
    expect(hasBlocking(s)).toBe(false);
    expect(s.checks[0]).toMatchObject({ level: 'ok' });
  });
  it('erreur de cohérence : bloque', () => {
    expect(hasBlocking(simulateDraft('sla', { ...DEFAULT_SLA_SETTINGS, firstAlertMin: 20, criticalMin: 5 }))).toBe(true);
  });
  it('cycles NR, conversion, motifs, messages : exemples et contrôles propres au module', () => {
    expect(simulateDraft('rules', DEFAULT_RULES_SETTINGS).examples[0]).toContain('NR1 → NR2');
    expect(simulateDraft('conversion', { maxDiscountPct: 30, requireEligibility: true, requireRge: false, requireConsent: false }).checks.filter((c) => c.level === 'warning')).toHaveLength(3);
    expect(simulateDraft('reasons', {}).examples.length).toBeGreaterThan(5);
    const none = simulateDraft('messages', { templates: [] });
    expect(none.checks.filter((c) => c.level === 'warning')).toHaveLength(4);
    expect(simulateDraft('messages', { templates: defaultTemplates() }).examples.length).toBeGreaterThan(5);
  });
  it('liste de motifs sans valeur active : bloque (la saisie serait impossible)', () => {
    const lists = { callback: Object.entries(BUILTIN_REASONS.callback).map(([code, label]) => ({ code, label, active: false, requireComment: false })) };
    expect(hasBlocking(simulateDraft('reasons', { lists }))).toBe(true);
  });
});

describe('différences et impact', () => {
  it('différences lisibles, ancienne → nouvelle valeur', () => {
    const d = parseDraft(save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: 8 }).doc)!;
    expect(draftChanges('sla', published, d)).toContain('Première alerte : 5 min → 8 min');
    expect(draftChanges('sla', published, parseDraft(save(DEFAULT_SLA_SETTINGS).doc)!)).toEqual([]);
  });
  it('SLA : leads neufs qui passeraient « dépassé » ou n’y seraient plus', () => {
    const d = parseDraft(save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: 10, criticalMin: 12, reassignMin: 20 }).doc)!;
    const fresh = leadOf('a', { slaStartedAtMs: NOW - 8 * 60_000 }); // 8 min : dépassé à 5 min, plus à 10 min
    const ok = leadOf('b', { slaStartedAtMs: NOW - 2 * 60_000 });
    const i = impactOf('sla', published, d, [fresh, ok, leadOf('c', { status: 'not_interested' })], NOW);
    expect(i.active).toBe(2);
    expect(i.lines.find((l) => l.label.startsWith('Ne seraient plus'))?.count).toBe(1);
    expect(i.lines.find((l) => l.label.startsWith('Passeraient'))?.count).toBe(0);
    const stricter = parseDraft(save({ ...DEFAULT_SLA_SETTINGS, firstAlertMin: 3, criticalMin: 10 }).doc)!;
    expect(impactOf('sla', published, stricter, [ok], NOW).lines.find((l) => l.label.startsWith('Passeraient'))?.count).toBe(0);
    expect(impactOf('sla', published, stricter, [leadOf('d', { slaStartedAtMs: NOW - 4 * 60_000 })], NOW).lines.find((l) => l.label.startsWith('Passeraient'))?.count).toBe(1);
  });
  it('cycles et conversion : dossiers en cours concernés', () => {
    const d = { doc: { ...DEFAULT_RULES_SETTINGS }, meta: { atMs: 1, byId: 'a', baseMs: 0 } };
    const i = impactOf('rules', DEFAULT_RULES_SETTINGS, d, [leadOf('a', { status: 'nr' }), leadOf('b', { status: 'awaiting_documents' }), leadOf('c')], NOW);
    expect(i.lines.map((l) => l.count)).toEqual([1, 1]);
    const c = impactOf('conversion', {}, { doc: {}, meta: d.meta }, [leadOf('m', { status: 'manager_validation' }), leadOf('n', { status: 'file_building' })], NOW);
    expect(c.lines.map((l) => l.count)).toEqual([2, 1]);
  });
  it('motifs : une valeur archivée est comptée parmi les leads qui l’utilisent, jamais supprimée', () => {
    const before = { lists: {} };
    const archived = { lists: { callback: [{ code: 'c_x', label: 'X', active: true }] } };
    void before;
    const i = impactOf('reasons', archived, { doc: { lists: { callback: [{ code: 'c_x', label: 'X', active: false }] } }, meta: { atMs: 1, byId: 'a', baseMs: 0 } }, [leadOf('a', { status: 'not_interested', closure: { kind: 'not_interested', code: 'c_x', label: 'X' } })], NOW);
    expect(i.strategy).toContain('jamais supprimée');
  });
  it('messages : leads dont le message change', () => {
    const tpl = defaultTemplates();
    const off = tpl.map((t) => (t.trigger === 'documents_partial' ? { ...t, active: false } : t));
    const lead = leadOf('p', { status: 'awaiting_documents', documentsState: 'partial' });
    const i = impactOf('messages', { templates: tpl }, { doc: { templates: off }, meta: { atMs: 1, byId: 'a', baseMs: 0 } }, [lead], NOW);
    expect(i.lines).toHaveLength(1);
    expect(i.lines[0]).toMatchObject({ label: 'Dossier partiel', count: 1 });
    expect(impactOf('messages', { templates: tpl }, { doc: { templates: tpl }, meta: { atMs: 1, byId: 'a', baseMs: 0 } }, [lead], NOW).lines[0].label).toBe('Aucun modèle modifié');
  });
});
