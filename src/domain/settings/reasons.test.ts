import { describe, expect, it } from 'vitest';
import { BUILTIN_REASONS, catalogOf, coerceReasonInput, DEFAULT_REASON_CATALOG, DEFAULT_REASON_SETTINGS, newReasonCode, parseReasonSettings, REASON_LISTS, reasonLabel, toStored, validateReasonSettings, type ReasonSettings } from './reasons';
import { CALLBACK_REASONS, FAKE_LEAD_MOTIVES, INELIGIBLE_MOTIVES, REFUSAL_MOTIVES } from '../call/outcomes';

const clone = (s: ReasonSettings): ReasonSettings => JSON.parse(JSON.stringify(s));

describe('valeurs d’origine', () => {
  it('reprennent exactement les constantes du moteur, liste par liste', () => {
    expect(BUILTIN_REASONS.callback).toEqual(CALLBACK_REASONS);
    expect(BUILTIN_REASONS.refusal).toEqual(REFUSAL_MOTIVES);
    expect(BUILTIN_REASONS.fake_lead).toEqual(FAKE_LEAD_MOTIVES);
    expect(BUILTIN_REASONS.ineligible_technical).toEqual(INELIGIBLE_MOTIVES.technical);
    expect(BUILTIN_REASONS.ineligible_zone).toEqual(INELIGIBLE_MOTIVES.zone);
    expect(Object.keys(BUILTIN_REASONS.document_ko)).toEqual(['unreadable', 'incomplete', 'expired', 'wrong_document', 'inconsistent_info', 'other']);
  });
  it('rien d’enregistré : tout est actif, dans l’ordre d’origine, et le réglage par défaut est valide', () => {
    const s = parseReasonSettings(undefined);
    expect(s).toEqual(DEFAULT_REASON_SETTINGS);
    expect(validateReasonSettings(s)).toEqual([]);
    expect(s.callback.map((i) => i.code)).toEqual(Object.keys(CALLBACK_REASONS));
    expect(s.callback.every((i) => i.active && i.builtin)).toBe(true);
  });
  it('« autre » d’une pièce non conforme exige déjà un commentaire (comportement d’origine)', () => {
    expect(DEFAULT_REASON_SETTINGS.document_ko.find((i) => i.code === 'other')?.requireComment).toBe(true);
    expect(DEFAULT_REASON_CATALOG.commentRequired.document_ko).toEqual(['other']);
  });
});

describe('lecture tolérante', () => {
  const stored = (lists: Record<string, unknown[]>) => ({ lists });
  it('renomme, réordonne et archive une valeur d’origine', () => {
    const s = parseReasonSettings(stored({ callback: [{ code: 'other', label: 'Autre raison', active: false }, { code: 'asked_callback', label: 'Rappel demandé', active: true }] }));
    expect(s.callback.slice(0, 2).map((i) => [i.code, i.label, i.active])).toEqual([['other', 'Autre raison', false], ['asked_callback', 'Rappel demandé', true]]);
  });
  it('les valeurs d’origine absentes du document reviennent toujours, actives', () => {
    const s = parseReasonSettings(stored({ callback: [{ code: 'other', label: 'Autre', active: true }] }));
    expect(s.callback.map((i) => i.code).sort()).toEqual(Object.keys(CALLBACK_REASONS).sort());
    expect(s.callback.find((i) => i.code === 'consult_spouse')?.active).toBe(true);
  });
  it('ajoute une valeur personnalisée valide', () => {
    const s = parseReasonSettings(stored({ refusal: [{ code: 'c_trop_cher', label: 'Trop cher pour lui', active: true }] }));
    const item = s.refusal.find((i) => i.code === 'c_trop_cher');
    expect(item).toMatchObject({ label: 'Trop cher pour lui', builtin: false, active: true });
    expect(s.refusal).toHaveLength(Object.keys(REFUSAL_MOTIVES).length + 1);
  });
  it('ignore ce qui est invalide : code inconnu, code mal formé, libellé vide, doublon, mauvais type', () => {
    const s = parseReasonSettings(stored({ refusal: [{ code: 'inconnu', label: 'x y' }, { code: 'c_Mal Forme', label: 'Ok ok' }, { code: 'c_vide', label: ' ' }, { code: 'c_a', label: 'A b' }, { code: 'c_a', label: 'Doublon' }, 'texte', null, { code: 5 }] }));
    expect(s.refusal.filter((i) => !i.builtin).map((i) => i.code)).toEqual(['c_a']);
  });
  it('libellé d’une valeur d’origine invalide : l’original est conservé', () => {
    expect(parseReasonSettings(stored({ callback: [{ code: 'other', label: '' }] })).callback.find((i) => i.code === 'other')?.label).toBe('Autre');
  });
  it('document absurde : réglage par défaut', () => {
    for (const raw of [null, 'texte', 42, [], { lists: 'x' }, { lists: { callback: 'x' } }]) expect(parseReasonSettings(raw)).toEqual(DEFAULT_REASON_SETTINGS);
  });
  it('au plus 40 valeurs par liste', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ code: `c_v${i}`, label: `Valeur ${i}` }));
    expect(parseReasonSettings(stored({ refusal: many })).refusal.length).toBeLessThanOrEqual(40 + Object.keys(REFUSAL_MOTIVES).length);
  });
  it('exigence de commentaire : seulement là où elle apporte quelque chose', () => {
    const s = parseReasonSettings(stored({ bad_moment: [{ code: 'at_work', label: 'Au travail', active: true, requireComment: true }], callback: [{ code: 'other', label: 'Autre', active: true, requireComment: true }] }));
    expect(s.bad_moment.find((i) => i.code === 'at_work')?.requireComment).toBe(true);
    expect(s.callback.find((i) => i.code === 'other')?.requireComment).toBe(false);
  });
});

describe('validation', () => {
  it('une valeur d’origine ne peut pas disparaître', () => {
    const s = clone(DEFAULT_REASON_SETTINGS);
    s.callback = s.callback.filter((i) => i.code !== 'other');
    expect(validateReasonSettings(s).join(' ')).toMatch(/ne peut pas disparaître/);
  });
  it('au moins une valeur active par liste', () => {
    const s = clone(DEFAULT_REASON_SETTINGS);
    s.interest.forEach((i) => { i.active = false; });
    expect(validateReasonSettings(s).join(' ')).toMatch(/Prospect intéressé : au moins une valeur/);
  });
  it('libellés : 2 à 60 caractères, sans doublon (casse ignorée)', () => {
    const s = clone(DEFAULT_REASON_SETTINGS);
    s.refusal[0].label = 'x';
    expect(validateReasonSettings(s).join(' ')).toMatch(/entre 2 et 60/);
    const d = clone(DEFAULT_REASON_SETTINGS);
    d.refusal[1].label = d.refusal[0].label.toUpperCase();
    expect(validateReasonSettings(d).join(' ')).toMatch(/en double/);
  });
  it('code inventé refusé', () => {
    const s = clone(DEFAULT_REASON_SETTINGS);
    s.refusal.push({ code: 'hack', label: 'Pirate', active: true, builtin: false, requireComment: false });
    expect(validateReasonSettings(s).join(' ')).toMatch(/code invalide/);
  });
});

describe('saisie et forme enregistrée', () => {
  it('aller-retour sans perte', () => {
    const s = clone(DEFAULT_REASON_SETTINGS);
    s.bad_moment[0].requireComment = true;
    s.refusal.push({ code: 'c_perso', label: 'Motif perso', active: true, builtin: false, requireComment: false });
    expect(parseReasonSettings(toStored(coerceReasonInput(toStored(s))))).toEqual(s);
  });
  it('la saisie n’est jamais corrigée en silence', () => {
    const c = coerceReasonInput({ lists: { refusal: [{ code: 'price', label: '  Prix   élevé ', active: 'oui' }] } });
    expect(c.refusal[0]).toMatchObject({ code: 'price', label: 'Prix élevé', active: false });
  });
  it('la forme enregistrée ne porte pas l’indicateur « d’origine »', () => {
    expect(Object.keys(toStored(DEFAULT_REASON_SETTINGS).lists.callback[0]).sort()).toEqual(['active', 'code', 'label', 'requireComment']);
  });
});

describe('nouveau code', () => {
  it('stable, sans accents, unique', () => {
    expect(newReasonCode('Déjà équipé !', new Set())).toBe('c_deja_equipe');
    expect(newReasonCode('Déjà équipé', new Set(['c_deja_equipe']))).toBe('c_deja_equipe_2');
    expect(newReasonCode('???', new Set())).toBe('c_valeur');
  });
  it('toujours conforme au format attendu', () => {
    expect(/^c_[a-z0-9_]{1,40}$/.test(newReasonCode('A'.repeat(100), new Set()))).toBe(true);
  });
});

describe('catalogue lu par les moteurs', () => {
  const s = clone(DEFAULT_REASON_SETTINGS);
  s.refusal.find((i) => i.code === 'competitor')!.active = false;
  s.refusal.find((i) => i.code === 'price')!.label = 'Prix trop élevé';
  const cat = catalogOf(s);
  it('seules les valeurs actives sont acceptées à la saisie', () => {
    expect('competitor' in cat.active.refusal).toBe(false);
    expect(cat.active.refusal.price).toBe('Prix trop élevé');
  });
  it('une valeur archivée reste lisible dans les historiques', () => {
    expect(reasonLabel(cat, 'refusal', 'competitor')).toBe('Concurrent');
    expect(reasonLabel(cat, 'refusal', 'price')).toBe('Prix trop élevé');
  });
  it('code inconnu : le code, jamais « undefined »', () => {
    expect(reasonLabel(cat, 'refusal', 'c_disparu')).toBe('c_disparu');
    expect(reasonLabel(cat, 'refusal', null)).toBe('');
  });
  it('toutes les listes existent', () => {
    for (const l of REASON_LISTS) expect(Object.keys(DEFAULT_REASON_CATALOG.active[l]).length).toBeGreaterThan(0);
  });
});

describe('réattribution et température', () => {
  it('motifs de réattribution : « Autre » exige un commentaire par défaut', () => {
    expect(DEFAULT_REASON_SETTINGS.reassign.map((i) => i.code)).toContain('rebalancing');
    expect(DEFAULT_REASON_CATALOG.commentRequired.reassign).toEqual(['other']);
  });
  it('température : trois codes fixes, aucun ajout possible, libellé et ordre réglables', () => {
    expect(Object.keys(BUILTIN_REASONS.temperature)).toEqual(['hot', 'warm', 'to_work']);
    const s = parseReasonSettings({ lists: { temperature: [{ code: 'c_glacial', label: 'Glacial', active: true }, { code: 'warm', label: 'Moyen', active: true }] } });
    expect(s.temperature.map((i) => i.code)).toEqual(['warm', 'hot', 'to_work']);
    expect(s.temperature[0].label).toBe('Moyen');
    const bad = clone(DEFAULT_REASON_SETTINGS);
    bad.temperature.push({ code: 'c_glacial', label: 'Glacial', active: true, builtin: false, requireComment: false });
    expect(validateReasonSettings(bad).join(' ')).toMatch(/code invalide/);
  });
});
