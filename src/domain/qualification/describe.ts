// Phrases lisibles pour les conditions du constructeur : « SI Chauffage actuel = Fioul ALORS afficher … ».

import { ACTION_LABELS, COMPUTE_LABELS, OP_LABELS, type Clause, type FieldDef, type QualificationForm, type Rule } from './form';

const label = (fields: readonly FieldDef[], id: string): string => fields.find((f) => f.id === id)?.label || id;

function valueText(c: Clause, f: FieldDef | undefined): string {
  const one = (v: unknown): string => {
    if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
    if (typeof v === 'string') return f?.options.find((o) => o.value === v)?.label ?? v;
    return String(v);
  };
  if (Array.isArray(c.value)) return c.value.map(one).join(' ou ');
  return c.value === null ? '' : one(c.value);
}

export function clauseText(c: Clause, fields: readonly FieldDef[]): string {
  const f = fields.find((x) => x.id === c.fieldId);
  const op = OP_LABELS[c.op] ?? c.op;
  const base = `${label(fields, c.fieldId)} ${op}`;
  return c.op === 'filled' || c.op === 'empty' ? base : `${base} ${valueText(c, f)}`.trim();
}

export function ruleText(r: Rule, fields: readonly FieldDef[]): string {
  const cond = r.clauses.map((c) => clauseText(c, fields)).join(r.match === 'any' ? ' OU ' : ' ET ') || '…';
  const targets = r.targets.map((t) => label(fields, t)).join(', ');
  switch (r.action) {
    case 'alert': return `SI ${cond} ALORS alerter : ${r.message || '…'}`;
    case 'eligibility': return `SI ${cond} ALORS éligibilité ${r.eligibility === 'refused' ? 'refusée' : r.eligibility === 'to_confirm' ? 'à confirmer' : '…'}`;
    case 'compute': return `SI ${cond} ALORS calculer ${targets || '…'} = ${COMPUTE_LABELS[r.compute?.op ?? 'sum']} de ${(r.compute?.sources ?? []).map((s) => label(fields, s)).join(', ') || '…'}`;
    default: return `SI ${cond} ALORS ${ACTION_LABELS[r.action]} ${targets || '…'}`;
  }
}

/** Conditions « afficher » qui gouvernent un champ, en phrases : pourquoi il apparaît. */
export function showConditions(form: QualificationForm, fieldId: string): string[] {
  return form.rules.filter((r) => r.action === 'show' && r.targets.includes(fieldId)).map((r) => `Affiché si ${r.clauses.map((c) => clauseText(c, form.fields)).join(r.match === 'any' ? ' ou ' : ' et ')}`);
}

/** Règles qui lisent ou visent un champ : utile avant de le supprimer. */
export function rulesUsing(form: QualificationForm, fieldId: string): Rule[] {
  return form.rules.filter((r) => r.targets.includes(fieldId) || r.clauses.some((c) => c.fieldId === fieldId) || (r.compute?.sources ?? []).includes(fieldId));
}
