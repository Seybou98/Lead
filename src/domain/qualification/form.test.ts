import { describe, expect, it } from 'vitest';
import { answersToKeep, blankField, diffForms, errorsOf, evaluate, isDiffEmpty, newId, normalizeForm, validateForm, type FieldDef, type QualificationForm, type Rule } from './form';

const f = (id: string, over: Partial<FieldDef> = {}): FieldDef => ({ ...blankField(over.type ?? 'text', id), label: `Champ ${id}`, ...over });
const rule = (id: string, over: Partial<Rule>): Rule => ({ id, match: 'all', clauses: [], action: 'show', targets: [], message: '', eligibility: null, compute: null, ...over });
const yes = (fieldId: string) => ({ fieldId, op: 'eq' as const, value: true });

/** Le formulaire de la fig. 27, réduit : propriétaire → logement ; chauffage fioul → détails de la chaudière. */
const form = (): QualificationForm => ({
  fields: [
    f('q_owner', { type: 'yesno', label: 'Êtes-vous propriétaire ?', required: true }),
    f('q_housing', { type: 'list', label: 'Type de logement', options: [{ value: 'house', label: 'Maison' }, { value: 'flat', label: 'Appartement' }] }),
    f('q_heating', { type: 'list', label: 'Chauffage actuel', options: [{ value: 'fuel', label: 'Fioul' }, { value: 'gas', label: 'Gaz' }] }),
    f('q_consumption', { type: 'number', label: 'Consommation annuelle', required: true, min: 0 }),
    f('q_age', { type: 'number', label: 'Ancienneté de la chaudière' }),
  ],
  rules: [
    rule('r_housing', { action: 'show', targets: ['q_housing'], clauses: [yes('q_owner')] }),
    rule('r_fuel', { action: 'show', targets: ['q_consumption', 'q_age'], clauses: [{ fieldId: 'q_heating', op: 'eq', value: 'fuel' }] }),
  ],
});

describe('lecture tolérante', () => {
  it('ignore ce qui est invalide et borne les tailles', () => {
    const n = normalizeForm({ fields: [{ id: 'q_a', type: 'text', label: '  Nom   complet ' }, { id: 'mauvais id', type: 'text' }, { id: 'q_b', type: 'inconnu' }, 'x', { id: 'q_a', type: 'text', label: 'doublon' }], rules: [{ id: 'r_1', action: 'show' }, { id: 'xx', action: 'show' }] });
    expect(n.fields.map((x) => x.id)).toEqual(['q_a']);
    expect(n.fields[0].label).toBe('Nom complet');
    expect(n.rules.map((r) => r.id)).toEqual(['r_1']);
  });
  it('un champ bloquant est obligatoire', () => expect(normalizeForm({ fields: [{ id: 'q_a', type: 'text', label: 'Ab', blocking: true }] }).fields[0].required).toBe(true));
  it('les choix ne s’appliquent qu’aux listes', () => {
    expect(normalizeForm({ fields: [{ id: 'q_a', type: 'text', label: 'Ab', options: [{ label: 'x', value: 'x' }] }] }).fields[0].options).toEqual([]);
    expect(normalizeForm({ fields: [{ id: 'q_a', type: 'list', label: 'Ab', options: [{ label: 'Un' }, { label: 'Un' }, { label: 'Deux' }] }] }).fields[0].options.map((o) => o.value)).toEqual(['Un', 'Deux']);
  });
  it('document absurde : formulaire vide', () => {
    for (const raw of [null, 'x', 4, [], { fields: 'x' }]) expect(normalizeForm(raw)).toEqual({ fields: [], rules: [] });
  });
  it('aller-retour sans perte', () => expect(normalizeForm(JSON.parse(JSON.stringify(form())))).toEqual(form()));
});

describe('identifiants', () => {
  it('stables, sans accents, uniques', () => {
    expect(newId('q', 'Ancienneté de la chaudière', new Set())).toBe('q_anciennete_de_la_chaudie');
    expect(newId('q', 'Chauffage', new Set(['q_chauffage']))).toBe('q_chauffage_2');
    expect(newId('r', '???', new Set())).toBe('r_champ');
  });
});

describe('validation avant publication', () => {
  it('le formulaire de référence est valide', () => expect(validateForm(form())).toEqual([]));
  it('formulaire vide : avertissement, pas d’erreur', () => {
    const v = validateForm({ fields: [], rules: [] });
    expect(errorsOf(v)).toEqual([]);
    expect(v[0].level).toBe('warning');
  });
  it('libellé trop court, liste sans choix, minimum > maximum', () => {
    const bad = form();
    bad.fields[0].label = 'x';
    bad.fields[1].options = [{ value: 'a', label: 'A' }];
    bad.fields[3].min = 10;
    bad.fields[3].max = 1;
    const codes = errorsOf(validateForm(bad)).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['label', 'options', 'bounds']));
  });
  it('réponse attendue ou valeur par défaut hors des choix', () => {
    const bad = form();
    bad.fields[1].defaultValue = 'villa';
    bad.fields[2].expected = 'wood';
    expect(errorsOf(validateForm(bad)).map((i) => i.code)).toEqual(expect.arrayContaining(['default', 'expected']));
  });
  it('variable inconnue dans une condition ou une cible', () => {
    const bad = form();
    bad.rules[0].clauses = [yes('q_fantome')];
    bad.rules[1].targets = ['q_nulle_part'];
    expect(errorsOf(validateForm(bad)).filter((i) => i.code === 'unknown_field')).toHaveLength(2);
  });
  it('condition sans résultat possible : valeur qui n’existe pas', () => {
    const bad = form();
    bad.rules[1].clauses = [{ fieldId: 'q_heating', op: 'eq', value: 'charbon' }];
    const v = errorsOf(validateForm(bad));
    expect(v.some((i) => i.code === 'impossible')).toBe(true);
    // et le champ obligatoire qu'elle devait afficher ne peut plus jamais l'être
    expect(v.some((i) => i.code === 'invisible_required' && i.fieldId === 'q_consumption')).toBe(true);
  });
  it('comparaison numérique sur un champ non numérique', () => {
    const bad = form();
    bad.rules[0].clauses = [{ fieldId: 'q_owner', op: 'gt', value: 3 }];
    expect(errorsOf(validateForm(bad)).some((i) => i.code === 'bad_value')).toBe(true);
  });
  it('champ obligatoire masqué derrière un champ lui-même invisible', () => {
    const bad = form();
    bad.rules[1].clauses = [{ fieldId: 'q_heating', op: 'eq', value: 'charbon' }];
    bad.rules[0].clauses = [{ fieldId: 'q_consumption', op: 'filled', value: null }];
    bad.fields[1].required = true;
    const v = errorsOf(validateForm(bad));
    expect(v.some((i) => i.code === 'invisible_required' && i.fieldId === 'q_housing')).toBe(true);
  });
  it('champ facultatif rendu invisible : permis', () => {
    const ok = form();
    ok.rules[1].clauses = [{ fieldId: 'q_heating', op: 'eq', value: 'charbon' }];
    ok.fields[3].required = false;
    expect(errorsOf(validateForm(ok)).filter((i) => i.code === 'invisible_required')).toEqual([]);
  });
  it('référence circulaire : A affiche B, B affiche A', () => {
    const bad: QualificationForm = {
      fields: [f('q_a', { type: 'yesno' }), f('q_b', { type: 'yesno' })],
      rules: [rule('r_1', { action: 'show', targets: ['q_b'], clauses: [yes('q_a')] }), rule('r_2', { action: 'show', targets: ['q_a'], clauses: [yes('q_b')] })],
    };
    expect(errorsOf(validateForm(bad)).some((i) => i.code === 'circular')).toBe(true);
  });
  it('un champ qui s’affiche lui-même est circulaire', () => {
    const bad: QualificationForm = { fields: [f('q_a', { type: 'yesno' })], rules: [rule('r_1', { action: 'show', targets: ['q_a'], clauses: [yes('q_a')] })] };
    expect(errorsOf(validateForm(bad)).some((i) => i.code === 'circular')).toBe(true);
  });
  it('règle sans critère, sans cible, alerte sans message, éligibilité sans niveau', () => {
    const bad = form();
    bad.rules.push(rule('r_a', { action: 'show', targets: ['q_age'] }), rule('r_b', { action: 'hide', clauses: [yes('q_owner')] }), rule('r_c', { action: 'alert', clauses: [yes('q_owner')] }), rule('r_d', { action: 'eligibility', clauses: [yes('q_owner')] }));
    expect(errorsOf(validateForm(bad)).map((i) => i.code)).toEqual(expect.arrayContaining(['no_clause', 'no_target', 'no_message', 'no_effect']));
  });
  it('calcul : sources numériques, au moins deux, un seul résultat', () => {
    const base: QualificationForm = { fields: [f('q_a', { type: 'number' }), f('q_b', { type: 'amount' }), f('q_c', { type: 'amount' }), f('q_t', { type: 'text' })], rules: [] };
    const ok = { ...base, rules: [rule('r_1', { action: 'compute', targets: ['q_c'], clauses: [{ fieldId: 'q_a', op: 'filled', value: null }], compute: { op: 'product', sources: ['q_a', 'q_b'] } })] };
    expect(errorsOf(validateForm(ok))).toEqual([]);
    const bad = { ...base, rules: [rule('r_1', { action: 'compute', targets: ['q_t'], clauses: [{ fieldId: 'q_a', op: 'filled', value: null }], compute: { op: 'sum', sources: ['q_a'] } })] };
    expect(errorsOf(validateForm(bad)).filter((i) => i.code === 'compute').length).toBeGreaterThanOrEqual(2);
  });
  it('produit disparu du catalogue : avertissement seulement', () => {
    const w = form();
    w.fields[0].products = ['PAC'];
    const v = validateForm(w, { knownProducts: ['SSC'] });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ level: 'warning', code: 'unknown_product' });
  });
});

describe('évaluation (fig. 27)', () => {
  const ev = (a: Record<string, unknown>, form0 = form()) => evaluate(form0, a);
  const vis = (e: ReturnType<typeof ev>) => e.fields.filter((s) => s.visible).map((s) => s.def.id);
  it('un champ conditionnel n’apparaît que si sa condition est satisfaite', () => {
    expect(vis(ev({}))).toEqual(['q_owner', 'q_heating']);
    expect(vis(ev({ q_owner: false }))).toEqual(['q_owner', 'q_heating']);
    expect(vis(ev({ q_owner: true }))).toEqual(['q_owner', 'q_housing', 'q_heating']);
    expect(vis(ev({ q_heating: 'fuel' }))).toEqual(['q_owner', 'q_heating', 'q_consumption', 'q_age']);
  });
  it('la réponse d’un champ masqué est ignorée par les conditions', () => {
    // chauffage = fioul répondu, mais le logement (et donc le chauffage ici) dépend du propriétaire
    const chain = form();
    chain.rules.push(rule('r_heat', { action: 'show', targets: ['q_heating'], clauses: [yes('q_owner')] }));
    expect(vis(ev({ q_owner: false, q_heating: 'fuel' }, chain))).toEqual(['q_owner']);
    expect(vis(ev({ q_owner: true, q_heating: 'fuel' }, chain))).toEqual(['q_owner', 'q_housing', 'q_heating', 'q_consumption', 'q_age']);
  });
  it('obligatoire visible sans réponse : incomplet ; renseigné : complet', () => {
    expect(ev({}).status).toBe('incomplete');
    expect(ev({}).missing).toEqual(['q_owner']);
    expect(ev({ q_owner: false }).status).toBe('complete');
    expect(ev({ q_owner: true, q_housing: 'house', q_heating: 'fuel' }).missing).toEqual(['q_consumption']);
  });
  it('un obligatoire masqué ne manque pas', () => expect(ev({ q_owner: true, q_heating: 'gas' }).missing).toEqual([]));
  it('règle « rendre obligatoire »', () => {
    const f2 = form();
    f2.rules.push(rule('r_req', { action: 'require', targets: ['q_housing'], clauses: [yes('q_owner')] }));
    expect(ev({ q_owner: true }, f2).missing).toEqual(['q_housing']);
  });
  it('règle « masquer »', () => {
    const f2 = form();
    f2.rules.push(rule('r_hide', { action: 'hide', targets: ['q_owner'], clauses: [{ fieldId: 'q_heating', op: 'eq', value: 'gas' }] }));
    const e = ev({ q_owner: true, q_housing: 'house', q_heating: 'gas' }, f2);
    expect(e.fields.find((s) => s.def.id === 'q_owner')?.visible).toBe(false);
  });
  it('« au moins un » et « tous »', () => {
    const f2 = form();
    f2.rules = [rule('r_x', { action: 'show', targets: ['q_age'], match: 'any', clauses: [yes('q_owner'), { fieldId: 'q_heating', op: 'eq', value: 'fuel' }] })];
    expect(vis(ev({ q_owner: true }, f2))).toContain('q_age');
    f2.rules[0].match = 'all';
    expect(vis(ev({ q_owner: true }, f2))).not.toContain('q_age');
  });
  it('alerte et éligibilité : la plus sévère l’emporte', () => {
    const f2 = form();
    f2.rules.push(rule('r_al', { action: 'alert', clauses: [{ fieldId: 'q_heating', op: 'eq', value: 'fuel' }], message: 'Chaudière fioul : visite technique' }), rule('r_e1', { action: 'eligibility', eligibility: 'to_confirm', clauses: [yes('q_owner')] }), rule('r_e2', { action: 'eligibility', eligibility: 'refused', clauses: [{ fieldId: 'q_housing', op: 'eq', value: 'flat' }] }));
    const e = ev({ q_owner: true, q_housing: 'flat', q_heating: 'fuel' }, f2);
    expect(e.alerts).toEqual(['Chaudière fioul : visite technique']);
    expect(e.eligibility).toBe('refused');
    expect(ev({ q_owner: true, q_housing: 'house' }, f2).eligibility).toBe('to_confirm');
    expect(ev({ q_owner: false }, f2).eligibility).toBe('ok');
  });
  it('champ bloquant : réponse absente ou différente de la réponse attendue', () => {
    const f2 = form();
    f2.fields[0] = { ...f2.fields[0], blocking: true, expected: true };
    expect(ev({}, f2).status).toBe('blocked');
    expect(ev({ q_owner: false }, f2)).toMatchObject({ status: 'blocked', blocked: ['q_owner'] });
    expect(ev({ q_owner: true }, f2).status).not.toBe('blocked');
  });
  it('valeur par défaut appliquée quand rien n’est répondu', () => {
    const f2 = form();
    f2.fields[0].defaultValue = true;
    expect(vis(ev({}, f2))).toContain('q_housing');
  });
  it('contrôles de format', () => {
    const e = ev({ q_owner: true, q_heating: 'fuel', q_consumption: -5, q_housing: 'villa' });
    expect(e.fields.find((s) => s.def.id === 'q_consumption')?.error).toBe('Au moins 0.');
    expect(e.fields.find((s) => s.def.id === 'q_housing')?.error).toBe('Choisissez une valeur de la liste.');
    expect(e.status).toBe('incomplete');
  });
  it('champ propre à un produit : non applicable pour un autre produit', () => {
    const f2 = form();
    f2.fields[0].products = ['PAC'];
    expect(evaluate(f2, {}, 'SSC').fields[0].visible).toBe(false);
    expect(evaluate(f2, {}, 'PAC').fields[0].visible).toBe(true);
    expect(evaluate(f2, {}, null).fields[0].visible).toBe(true);
  });
});

describe('calculs', () => {
  const calc = (op: 'sum' | 'diff' | 'product' | 'ratio'): QualificationForm => ({
    fields: [f('q_a', { type: 'number' }), f('q_b', { type: 'number' }), f('q_r', { type: 'number' })],
    rules: [rule('r_c', { action: 'compute', targets: ['q_r'], clauses: [{ fieldId: 'q_a', op: 'filled', value: null }, { fieldId: 'q_b', op: 'filled', value: null }], compute: { op, sources: ['q_a', 'q_b'] } })],
  });
  const result = (op: 'sum' | 'diff' | 'product' | 'ratio', a: Record<string, unknown>) => evaluate(calc(op), a).fields.find((s) => s.def.id === 'q_r')?.value;
  it('somme, différence, produit, quotient', () => {
    expect(result('sum', { q_a: 2, q_b: 3 })).toBe(5);
    expect(result('diff', { q_a: 10, q_b: 4 })).toBe(6);
    expect(result('product', { q_a: 2.5, q_b: 4 })).toBe(10);
    expect(result('ratio', { q_a: 9, q_b: 3 })).toBe(3);
  });
  it('sources manquantes ou division par zéro : pas de résultat', () => {
    expect(result('sum', { q_a: 2 })).toBeUndefined();
    expect(result('ratio', { q_a: 9, q_b: 0 })).toBeUndefined();
  });
  it('un résultat calculé est marqué et n’est pas « manquant »', () => {
    const e = evaluate({ ...calc('sum'), fields: calc('sum').fields.map((x) => (x.id === 'q_r' ? { ...x, required: true } : x)) }, { q_a: 1, q_b: 2 });
    expect(e.fields.find((s) => s.def.id === 'q_r')?.computed).toBe(true);
    expect(e.missing).toEqual([]);
  });
  it('un calcul alimente une condition', () => {
    const c = calc('sum');
    c.fields.push(f('q_note', { type: 'text' }));
    c.rules.push(rule('r_n', { action: 'show', targets: ['q_note'], clauses: [{ fieldId: 'q_r', op: 'gt', value: 100 }] }));
    expect(evaluate(c, { q_a: 60, q_b: 50 }).fields.find((s) => s.def.id === 'q_note')?.visible).toBe(true);
    expect(evaluate(c, { q_a: 6, q_b: 5 }).fields.find((s) => s.def.id === 'q_note')?.visible).toBe(false);
  });
});

describe('réponses à conserver', () => {
  it('seules les réponses des champs visibles, sans valeur vide', () => {
    // le logement dépend du propriétaire : sa réponse est écartée ; le champ inconnu aussi
    expect(answersToKeep(form(), { q_owner: false, q_housing: 'house', q_heating: 'fuel', q_age: 10, q_inconnu: 'x' })).toEqual({ q_owner: false, q_heating: 'fuel', q_age: 10 });
    expect(answersToKeep(form(), { q_owner: true, q_housing: '' })).toEqual({ q_owner: true });
  });
});

describe('comparaison de versions (impact)', () => {
  it('formulaires identiques : aucun écart', () => expect(isDiffEmpty(diffForms(form(), form()))).toBe(true));
  it('première version : tout est ajouté', () => {
    const d = diffForms(null, form());
    expect(d.addedFields).toHaveLength(5);
    expect(d.nowRequired.map((x) => x.id)).toEqual(['q_owner', 'q_consumption']);
  });
  it('champ ajouté, retiré, devenu obligatoire, règle modifiée', () => {
    const next = form();
    next.fields.push(f('q_new', { required: true }));
    next.fields = next.fields.filter((x) => x.id !== 'q_age');
    next.fields[1].required = true;
    next.fields[1].label = 'Logement';
    next.rules[0].clauses = [{ fieldId: 'q_owner', op: 'eq', value: false }];
    const d = diffForms(form(), next);
    expect(d.addedFields.map((x) => x.id)).toEqual(['q_new']);
    expect(d.removedFields.map((x) => x.id)).toEqual(['q_age']);
    expect(d.nowRequired.map((x) => x.id)).toEqual(expect.arrayContaining(['q_housing', 'q_new']));
    expect(d.changedFields.find((x) => x.id === 'q_housing')?.what).toEqual(expect.arrayContaining(['libellé', 'devient obligatoire']));
    expect(d.changedRules.map((r) => r.id)).toEqual(['r_housing']);
  });
});
