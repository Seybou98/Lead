// Constructeur de qualification conditionnelle (§21.3, fig. 27). Fonctions pures, sans Firestore : définition d'un
// formulaire, lecture tolérante, validation avant publication, évaluation des conditions sur des réponses (test et
// remplissage réel), comparaison de deux versions.
//
// Une condition lit des réponses et produit un effet : afficher, masquer, rendre obligatoire, calculer, alerter ou
// changer l'éligibilité. Le constructeur refuse de publier un champ obligatoire définitivement invisible, une référence
// circulaire ou une condition qui ne peut jamais être vraie. L'évaluation n'écrit rien : elle sert au test (données
// fictives) comme au remplissage d'un vrai lead.

export const FIELD_TYPES = ['text', 'number', 'amount', 'datetime', 'yesno', 'list', 'multi', 'address', 'area', 'document', 'confirm'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Texte court',
  number: 'Nombre',
  amount: 'Montant',
  datetime: 'Date / heure',
  yesno: 'Oui / Non',
  list: 'Liste déroulante',
  multi: 'Choix multiple',
  address: 'Adresse',
  area: 'Surface',
  document: 'Document',
  confirm: 'Confirmation',
};

export const NUMERIC_TYPES: readonly FieldType[] = ['number', 'amount', 'area'];
const OPTION_TYPES: readonly FieldType[] = ['list', 'multi'];

export interface FieldOption {
  value: string;
  label: string;
}

export type AnswerValue = string | number | boolean | string[] | null;

export interface FieldDef {
  /** Identifiant stable, jamais modifié après création : les réponses déjà enregistrées y sont rattachées. */
  id: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  /** Bloquant : une réponse manquante ou différente de la réponse attendue empêche de considérer la qualification comme valide. */
  blocking: boolean;
  options: FieldOption[];
  defaultValue: string | number | boolean | null;
  min: number | null;
  max: number | null;
  /** Réponse attendue (liste, oui/non, nombre) ; avec « bloquant », une autre réponse bloque. */
  expected: string | number | boolean | null;
  /** Codes produit concernés ; vide = tous les produits du formulaire. */
  products: string[];
}

export const OPS = ['eq', 'neq', 'in', 'gt', 'lt', 'filled', 'empty'] as const;
export type Op = (typeof OPS)[number];
export const OP_LABELS: Record<Op, string> = { eq: 'est égal à', neq: 'est différent de', in: 'fait partie de', gt: 'est supérieur à', lt: 'est inférieur à', filled: 'est renseigné', empty: 'est vide' };

export const ACTIONS = ['show', 'hide', 'require', 'alert', 'eligibility', 'compute'] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_LABELS: Record<Action, string> = { show: 'afficher', hide: 'masquer', require: 'rendre obligatoire', alert: 'alerter', eligibility: 'changer l’éligibilité', compute: 'calculer' };

export const COMPUTE_OPS = ['sum', 'diff', 'product', 'ratio'] as const;
export type ComputeOp = (typeof COMPUTE_OPS)[number];
export const COMPUTE_LABELS: Record<ComputeOp, string> = { sum: 'somme', diff: 'différence', product: 'produit', ratio: 'quotient' };

export interface Clause {
  fieldId: string;
  op: Op;
  value: string | number | boolean | string[] | null;
}

export interface Rule {
  id: string;
  /** « Tous » ou « au moins un » des critères (§21.7 : TOUS, AU MOINS UN). */
  match: 'all' | 'any';
  clauses: Clause[];
  action: Action;
  /** Champs concernés (afficher, masquer, rendre obligatoire) ; pour « calculer » : le champ résultat. */
  targets: string[];
  message: string;
  eligibility: 'to_confirm' | 'refused' | null;
  compute: { op: ComputeOp; sources: string[] } | null;
}

export interface QualificationForm {
  fields: FieldDef[];
  rules: Rule[];
}

export const EMPTY_FORM: QualificationForm = { fields: [], rules: [] };

export const MAX_FIELDS = 60;
export const MAX_RULES = 60;
export const MAX_OPTIONS = 30;
export const FIELD_ID = /^q_[a-z0-9_]{1,40}$/;
export const RULE_ID = /^r_[a-z0-9_]{1,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanMultiline = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const scalar = (v: unknown): string | number | boolean | null => (typeof v === 'string' ? v.slice(0, 200) : typeof v === 'boolean' ? v : num(v));

// ── Lecture tolérante ────────────────────────────────────────────────────────

function normalizeField(raw: unknown): FieldDef | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const type = FIELD_TYPES.find((t) => t === raw.type);
  if (!FIELD_ID.test(id) || !type) return null;
  const seen = new Set<string>();
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((o): FieldOption[] => {
        if (!isObj(o)) return [];
        const label = clean(o.label, 80);
        const value = clean(o.value, 60) || label;
        if (!label || seen.has(value)) return [];
        seen.add(value);
        return [{ value, label }];
      }).slice(0, MAX_OPTIONS)
    : [];
  const blocking = raw.blocking === true;
  return {
    id,
    type,
    label: clean(raw.label, 120),
    help: cleanMultiline(raw.help, 300),
    required: raw.required === true || blocking,
    blocking,
    options: OPTION_TYPES.includes(type) ? options : [],
    defaultValue: scalar(raw.defaultValue),
    min: num(raw.min),
    max: num(raw.max),
    expected: scalar(raw.expected),
    products: Array.isArray(raw.products) ? [...new Set(raw.products.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim().slice(0, 80)))].slice(0, 20) : [],
  };
}

function normalizeClause(raw: unknown): Clause | null {
  if (!isObj(raw)) return null;
  const op = OPS.find((o) => o === raw.op);
  const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId : '';
  if (!op || !fieldId) return null;
  const v = raw.value;
  const value = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_OPTIONS) : scalar(v);
  return { fieldId, op, value };
}

function normalizeRule(raw: unknown): Rule | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const action = ACTIONS.find((a) => a === raw.action);
  if (!RULE_ID.test(id) || !action) return null;
  const c = isObj(raw.compute) ? raw.compute : null;
  const cop = c ? COMPUTE_OPS.find((o) => o === c.op) : undefined;
  return {
    id,
    match: raw.match === 'any' ? 'any' : 'all',
    clauses: (Array.isArray(raw.clauses) ? raw.clauses.map(normalizeClause).filter((x): x is Clause => x !== null) : []).slice(0, 10),
    action,
    targets: Array.isArray(raw.targets) ? [...new Set(raw.targets.filter((t): t is string => typeof t === 'string'))].slice(0, MAX_FIELDS) : [],
    message: cleanMultiline(raw.message, 300),
    eligibility: raw.eligibility === 'refused' ? 'refused' : raw.eligibility === 'to_confirm' ? 'to_confirm' : null,
    compute: c && cop ? { op: cop, sources: Array.isArray(c.sources) ? c.sources.filter((s): s is string => typeof s === 'string').slice(0, 10) : [] } : null,
  };
}

/** Lecture tolérante d'un formulaire enregistré ou saisi : structure et tailles contrôlées, rien d'inventé. */
export function normalizeForm(raw: unknown): QualificationForm {
  const r = isObj(raw) ? raw : {};
  const fields: FieldDef[] = [];
  const ids = new Set<string>();
  for (const f of Array.isArray(r.fields) ? r.fields : []) {
    const n = normalizeField(f);
    if (n && !ids.has(n.id)) {
      ids.add(n.id);
      fields.push(n);
    }
    if (fields.length >= MAX_FIELDS) break;
  }
  const rules: Rule[] = [];
  const rids = new Set<string>();
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    const n = normalizeRule(x);
    if (n && !rids.has(n.id)) {
      rids.add(n.id);
      rules.push(n);
    }
    if (rules.length >= MAX_RULES) break;
  }
  return { fields, rules };
}

/** Identifiant de nouveau champ ou de nouvelle règle, stable et unique. */
export function newId(prefix: 'q' | 'r', hint: string, taken: ReadonlySet<string>): string {
  const slug = hint.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'champ';
  let id = `${prefix}_${slug}`;
  for (let i = 2; taken.has(id); i++) id = `${prefix}_${slug}_${i}`;
  return id;
}

/** Nouveau champ vide du type demandé. */
export function blankField(type: FieldType, id: string): FieldDef {
  const base: FieldDef = { id, type, label: FIELD_TYPE_LABELS[type], help: '', required: false, blocking: false, options: [], defaultValue: null, min: null, max: null, expected: null, products: [] };
  if (type === 'list' || type === 'multi') base.options = [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }];
  return base;
}

// ── Validation avant publication ─────────────────────────────────────────────

export interface Issue {
  level: 'error' | 'warning';
  code: 'duplicate_id' | 'invalid_id' | 'label' | 'options' | 'bounds' | 'default' | 'expected' | 'unknown_field' | 'bad_value' | 'no_clause' | 'no_target' | 'no_message' | 'no_effect' | 'circular' | 'impossible' | 'invisible_required' | 'compute' | 'empty' | 'unknown_product';
  message: string;
  fieldId?: string;
  ruleId?: string;
}

const labelOf = (f: FieldDef | undefined, id: string) => (f?.label ? `« ${f.label} »` : id);

/** Valeurs qu'un champ peut recevoir, pour contrôler une condition ou une réponse attendue ; null = non borné. */
function allowedValues(f: FieldDef): (string | boolean)[] | null {
  if (f.type === 'yesno' || f.type === 'confirm') return [true, false];
  if (OPTION_TYPES.includes(f.type)) return f.options.map((o) => o.value);
  return null;
}

function clauseIssue(c: Clause, f: FieldDef): string | null {
  if (c.op === 'filled' || c.op === 'empty') return null;
  if (c.op === 'gt' || c.op === 'lt') return NUMERIC_TYPES.includes(f.type) && typeof c.value === 'number' ? null : `${labelOf(f, f.id)} n’est pas un nombre : « ${OP_LABELS[c.op]} » n’a pas de sens.`;
  const allowed = allowedValues(f);
  const vals = c.op === 'in' ? (Array.isArray(c.value) ? c.value : []) : c.value === null || Array.isArray(c.value) ? [] : [c.value];
  if (vals.length === 0) return `Une valeur est attendue pour ${labelOf(f, f.id)}.`;
  if (allowed && vals.some((v) => !allowed.includes(v as never))) return `La valeur comparée n’existe pas dans ${labelOf(f, f.id)} : la condition ne peut jamais être vraie.`;
  if (NUMERIC_TYPES.includes(f.type) && vals.some((v) => typeof v !== 'number')) return `${labelOf(f, f.id)} se compare à un nombre.`;
  return null;
}

/** Dépendances entre champs (condition → cible, source de calcul → résultat) et recherche d'un cycle. */
function findCycle(form: QualificationForm): string[] | null {
  const edges = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  for (const r of form.rules) {
    const deps = r.clauses.map((c) => c.fieldId);
    if (r.action === 'compute') deps.push(...(r.compute?.sources ?? []));
    if (r.action === 'alert' || r.action === 'eligibility') continue;
    for (const t of r.targets) for (const d of deps) add(d, t);
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/** Champs qui peuvent un jour être visibles : sans règle « afficher », ou avec une règle « afficher » satisfaisable. */
function possiblyVisible(form: QualificationForm): Set<string> {
  const byId = new Map(form.fields.map((f) => [f.id, f]));
  const visible = new Set(form.fields.filter((f) => !form.rules.some((r) => r.action === 'show' && r.targets.includes(f.id))).map((f) => f.id));
  for (let pass = 0; pass <= form.fields.length; pass++) {
    let changed = false;
    for (const r of form.rules) {
      if (r.action !== 'show') continue;
      const ok = (c: Clause) => {
        const f = byId.get(c.fieldId);
        return !!f && visible.has(f.id) && clauseIssue(c, f) === null;
      };
      const satisfiable = r.clauses.length > 0 && (r.match === 'any' ? r.clauses.some(ok) : r.clauses.every(ok));
      if (!satisfiable) continue;
      for (const t of r.targets) if (!visible.has(t) && byId.has(t)) {
        visible.add(t);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return visible;
}

/** Contrôles d'un formulaire. Les erreurs bloquent la publication ; les avertissements l'accompagnent. */
export function validateForm(form: QualificationForm, opts: { knownProducts?: readonly string[] } = {}): Issue[] {
  const out: Issue[] = [];
  const err = (code: Issue['code'], message: string, extra: Partial<Issue> = {}) => out.push({ level: 'error', code, message, ...extra });
  const warn = (code: Issue['code'], message: string, extra: Partial<Issue> = {}) => out.push({ level: 'warning', code, message, ...extra });
  const byId = new Map<string, FieldDef>();

  if (form.fields.length === 0) warn('empty', 'Le formulaire ne contient aucun champ.');
  for (const f of form.fields) {
    if (!FIELD_ID.test(f.id)) err('invalid_id', `Identifiant de champ invalide (${f.id}).`, { fieldId: f.id });
    if (byId.has(f.id)) err('duplicate_id', `Identifiant de champ en double (${f.id}).`, { fieldId: f.id });
    byId.set(f.id, f);
    if (f.label.length < 2) err('label', 'Chaque champ a un libellé d’au moins 2 caractères.', { fieldId: f.id });
    if (OPTION_TYPES.includes(f.type)) {
      const vals = f.options.map((o) => o.value);
      if (f.options.length < 2) err('options', `${labelOf(f, f.id)} : au moins deux choix sont nécessaires.`, { fieldId: f.id });
      if (new Set(vals).size !== vals.length || f.options.some((o) => !o.label)) err('options', `${labelOf(f, f.id)} : choix vides ou en double.`, { fieldId: f.id });
    }
    if (f.min !== null && f.max !== null && f.min > f.max) err('bounds', `${labelOf(f, f.id)} : le minimum dépasse le maximum.`, { fieldId: f.id });
    const allowed = allowedValues(f);
    if (f.defaultValue !== null && allowed && !allowed.includes(f.defaultValue as never)) err('default', `${labelOf(f, f.id)} : la valeur par défaut n’existe pas dans les choix.`, { fieldId: f.id });
    if (f.expected !== null && allowed && !allowed.includes(f.expected as never)) err('expected', `${labelOf(f, f.id)} : la réponse attendue n’existe pas dans les choix.`, { fieldId: f.id });
    if (f.expected !== null && !allowed && NUMERIC_TYPES.includes(f.type) && typeof f.expected !== 'number') err('expected', `${labelOf(f, f.id)} : la réponse attendue doit être un nombre.`, { fieldId: f.id });
    if (opts.knownProducts) for (const p of f.products) if (!opts.knownProducts.includes(p)) warn('unknown_product', `${labelOf(f, f.id)} : le produit « ${p} » n’est plus au catalogue.`, { fieldId: f.id });
  }

  const ruleIds = new Set<string>();
  for (const r of form.rules) {
    if (ruleIds.has(r.id)) err('duplicate_id', `Identifiant de règle en double (${r.id}).`, { ruleId: r.id });
    ruleIds.add(r.id);
    if (r.clauses.length === 0) err('no_clause', 'Une condition doit comporter au moins un critère.', { ruleId: r.id });
    for (const c of r.clauses) {
      const f = byId.get(c.fieldId);
      if (!f) { err('unknown_field', `Variable inconnue dans une condition (${c.fieldId}).`, { ruleId: r.id }); continue; }
      const issue = clauseIssue(c, f);
      if (issue) err(issue.includes('jamais') ? 'impossible' : 'bad_value', issue, { ruleId: r.id, fieldId: f.id });
    }
    for (const t of r.targets) if (!byId.has(t)) err('unknown_field', `Champ cible inconnu (${t}).`, { ruleId: r.id });
    if (r.action === 'show' || r.action === 'hide' || r.action === 'require' || r.action === 'compute') {
      if (r.targets.length === 0) err('no_target', `Une condition « ${ACTION_LABELS[r.action]} » doit viser au moins un champ.`, { ruleId: r.id });
    }
    if (r.action === 'alert' && !r.message) err('no_message', 'Une alerte doit avoir un message.', { ruleId: r.id });
    if (r.action === 'eligibility' && !r.eligibility) err('no_effect', 'Choisissez l’éligibilité appliquée (à confirmer ou refusée).', { ruleId: r.id });
    if (r.action === 'compute') {
      const target = byId.get(r.targets[0] ?? '');
      const sources = r.compute?.sources ?? [];
      if (r.targets.length > 1) err('compute', 'Un calcul n’a qu’un seul champ résultat.', { ruleId: r.id });
      if (!r.compute || sources.length < 2) err('compute', 'Un calcul combine au moins deux champs.', { ruleId: r.id });
      if (target && !NUMERIC_TYPES.includes(target.type)) err('compute', `${labelOf(target, target.id)} doit être un nombre, un montant ou une surface pour recevoir un calcul.`, { ruleId: r.id });
      for (const s of sources) {
        const sf = byId.get(s);
        if (!sf) err('unknown_field', `Champ source inconnu (${s}).`, { ruleId: r.id });
        else if (!NUMERIC_TYPES.includes(sf.type)) err('compute', `${labelOf(sf, sf.id)} n’est pas numérique : il ne peut pas entrer dans un calcul.`, { ruleId: r.id });
        else if (target && sf.id === target.id) err('circular', `${labelOf(sf, sf.id)} ne peut pas dépendre de lui-même.`, { ruleId: r.id });
      }
    }
  }

  const cycle = findCycle(form);
  if (cycle) err('circular', `Référence circulaire : ${cycle.map((id) => labelOf(byId.get(id), id)).join(' → ')}.`);

  const visible = possiblyVisible(form);
  for (const f of form.fields) {
    if ((f.required || f.blocking) && !visible.has(f.id)) err('invisible_required', `${labelOf(f, f.id)} est obligatoire mais ne peut jamais être affiché : aucune condition « afficher » ne peut être vraie.`, { fieldId: f.id });
  }
  return out;
}

export const errorsOf = (issues: readonly Issue[]): Issue[] => issues.filter((i) => i.level === 'error');

// ── Évaluation sur des réponses ──────────────────────────────────────────────

export type Answers = Record<string, unknown>;

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function clauseHolds(c: Clause, answers: Answers): boolean {
  const v = answers[c.fieldId];
  switch (c.op) {
    case 'filled': return !isEmpty(v);
    case 'empty': return isEmpty(v);
    case 'gt': return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
    case 'lt': return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
    case 'in': return !isEmpty(v) && Array.isArray(c.value) && (Array.isArray(v) ? v.some((x) => (c.value as string[]).includes(x)) : (c.value as unknown[]).includes(v));
    case 'eq': return !isEmpty(v) && (Array.isArray(v) ? v.includes(c.value as string) : v === c.value);
    case 'neq': return isEmpty(v) ? false : Array.isArray(v) ? !v.includes(c.value as string) : v !== c.value;
  }
}

export interface FieldState {
  def: FieldDef;
  visible: boolean;
  required: boolean;
  value: unknown;
  /** Valeur issue d'un calcul : non saisissable. */
  computed: boolean;
  error: string | null;
}

export type FormStatus = 'complete' | 'incomplete' | 'blocked';

export interface Evaluation {
  fields: FieldState[];
  /** Champs visibles et obligatoires sans réponse. */
  missing: string[];
  /** Champs bloquants sans réponse ou avec une réponse différente de la réponse attendue. */
  blocked: string[];
  alerts: string[];
  eligibility: 'ok' | 'to_confirm' | 'refused';
  /** Règles dont les critères sont vérifiés : « pourquoi ce champ apparaît ». */
  fired: string[];
  status: FormStatus;
}

function compute(op: ComputeOp, xs: number[]): number | null {
  if (xs.length === 0) return null;
  switch (op) {
    case 'sum': return xs.reduce((a, b) => a + b, 0);
    case 'diff': return xs.slice(1).reduce((a, b) => a - b, xs[0]);
    case 'product': return xs.reduce((a, b) => a * b, 1);
    case 'ratio': return xs.slice(1).every((x) => x !== 0) ? xs.slice(1).reduce((a, b) => a / b, xs[0]) : null;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function fieldError(f: FieldDef, v: unknown): string | null {
  if (isEmpty(v)) return null;
  if (NUMERIC_TYPES.includes(f.type)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'Saisissez un nombre.';
    if (f.min !== null && v < f.min) return `Au moins ${f.min}.`;
    if (f.max !== null && v > f.max) return `Au plus ${f.max}.`;
  } else if (f.type === 'text' || f.type === 'address') {
    if (typeof v !== 'string') return 'Saisissez du texte.';
    if (f.max !== null && v.length > f.max) return `Au plus ${f.max} caractères.`;
  } else if (f.type === 'yesno' || f.type === 'confirm') {
    if (typeof v !== 'boolean') return 'Répondez par oui ou par non.';
  } else if (f.type === 'list') {
    if (typeof v !== 'string' || !f.options.some((o) => o.value === v)) return 'Choisissez une valeur de la liste.';
  } else if (f.type === 'multi') {
    if (!Array.isArray(v) || v.some((x) => !f.options.some((o) => o.value === x))) return 'Choisissez parmi les valeurs proposées.';
  }
  return null;
}

/**
 * Évalue un formulaire sur des réponses. Les réponses d'un champ masqué sont ignorées (jamais comptées dans une
 * condition) ; les calculs se propagent ; un produit hors de la liste d'un champ le rend non applicable.
 */
export function evaluate(form: QualificationForm, rawAnswers: Answers, productCode: string | null = null): Evaluation {
  const applicable = (f: FieldDef) => f.products.length === 0 || productCode === null || f.products.includes(productCode);
  const values: Answers = {};
  for (const f of form.fields) values[f.id] = rawAnswers[f.id] === undefined && f.defaultValue !== null ? f.defaultValue : rawAnswers[f.id];

  const computed = new Set<string>();
  let visible = new Set(form.fields.filter((f) => applicable(f) && !form.rules.some((r) => r.action === 'show' && r.targets.includes(f.id))).map((f) => f.id));
  const holds = (r: Rule, answers: Answers) => r.clauses.length > 0 && (r.match === 'any' ? r.clauses.some((c) => clauseHolds(c, answers)) : r.clauses.every((c) => clauseHolds(c, answers)));
  const seen = (): Answers => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, visible.has(k) ? v : undefined]));

  // Visibilité et calculs se stabilisent ensemble ; la validation interdit les cycles, le plafond évite toute boucle.
  for (let pass = 0; pass <= form.fields.length + form.rules.length; pass++) {
    const answers = seen();
    let changed = false;
    for (const r of form.rules) {
      if (r.action !== 'compute' || !r.compute || !holds(r, answers)) continue;
      const target = r.targets[0];
      const xs = r.compute.sources.map((s) => (visible.has(s) ? values[s] : undefined)).filter((x): x is number => typeof x === 'number');
      const res = xs.length === r.compute.sources.length ? compute(r.compute.op, xs) : null;
      const val = res === null ? undefined : round(res);
      computed.add(target);
      if (values[target] !== val) {
        values[target] = val;
        changed = true;
      }
    }
    const next = new Set<string>();
    for (const f of form.fields) {
      if (!applicable(f)) continue;
      const shows = form.rules.filter((r) => r.action === 'show' && r.targets.includes(f.id));
      const hides = form.rules.filter((r) => r.action === 'hide' && r.targets.includes(f.id));
      const on = shows.length === 0 || shows.some((r) => holds(r, answers));
      if (on && !hides.some((r) => holds(r, answers))) next.add(f.id);
    }
    if (next.size !== visible.size || [...next].some((x) => !visible.has(x))) {
      visible = next;
      changed = true;
    }
    if (!changed) break;
  }

  const answers = seen();
  const fired = form.rules.filter((r) => holds(r, answers)).map((r) => r.id);
  const requiredByRule = new Set(form.rules.filter((r) => r.action === 'require' && fired.includes(r.id)).flatMap((r) => r.targets));
  const alerts = [...new Set(form.rules.filter((r) => r.action === 'alert' && fired.includes(r.id) && r.message).map((r) => r.message))];
  const levels = form.rules.filter((r) => r.action === 'eligibility' && fired.includes(r.id)).map((r) => r.eligibility);
  const eligibility = levels.includes('refused') ? 'refused' : levels.includes('to_confirm') ? 'to_confirm' : 'ok';

  const fields: FieldState[] = form.fields.map((def) => {
    const vis = visible.has(def.id);
    const v = vis ? values[def.id] : undefined;
    return { def, visible: vis, required: vis && (def.required || def.blocking || requiredByRule.has(def.id)), value: v, computed: computed.has(def.id), error: vis ? fieldError(def, v) : null };
  });
  const missing = fields.filter((s) => s.visible && s.required && isEmpty(s.value) && !s.computed).map((s) => s.def.id);
  const blocked = fields.filter((s) => s.visible && s.def.blocking && (isEmpty(s.value) || (s.def.expected !== null && s.value !== s.def.expected))).map((s) => s.def.id);
  const invalid = fields.some((s) => s.error !== null);
  const status: FormStatus = blocked.length > 0 ? 'blocked' : missing.length > 0 || invalid ? 'incomplete' : 'complete';
  return { fields, missing, blocked, alerts, eligibility, fired, status };
}

/** Réponses à conserver : celles des champs visibles, sans les valeurs calculées ni les champs inconnus. */
export function answersToKeep(form: QualificationForm, answers: Answers, productCode: string | null = null): Answers {
  const ev = evaluate(form, answers, productCode);
  const out: Answers = {};
  for (const s of ev.fields) if (s.visible && !isEmpty(s.value)) out[s.def.id] = s.value;
  return out;
}

/**
 * Ce qu'il reste à régler dans un formulaire : champs obligatoires sans réponse et champs bloquants sans la bonne
 * réponse, en libellés lisibles. Sert au verrou de conversion (« qualification complète ») sans refaire le calcul.
 */
export function qualificationGaps(form: QualificationForm | null, answers: Answers, productCode: string | null = null): string[] {
  if (!form || form.fields.length === 0) return [];
  const ev = evaluate(form, answers, productCode);
  const label = (id: string) => form.fields.find((f) => f.id === id)?.label ?? id;
  const out = ev.missing.map(label);
  for (const id of ev.blocked) if (!ev.missing.includes(id)) out.push(`${label(id)} (réponse bloquante)`);
  for (const s of ev.fields) if (s.error) out.push(`${s.def.label} (${s.error.toLowerCase().replace(/\.$/, '')})`);
  return [...new Set(out)];
}

// ── Comparaison de deux versions (impact, §21.9) ─────────────────────────────

export interface FormDiff {
  addedFields: FieldDef[];
  removedFields: FieldDef[];
  /** Champs devenus obligatoires ou bloquants : risque de blocage pour les leads en cours. */
  nowRequired: FieldDef[];
  changedFields: { id: string; label: string; what: string[] }[];
  addedRules: Rule[];
  removedRules: Rule[];
  changedRules: Rule[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffForms(before: QualificationForm | null, after: QualificationForm): FormDiff {
  const b = before ?? EMPTY_FORM;
  const bf = new Map(b.fields.map((f) => [f.id, f]));
  const af = new Map(after.fields.map((f) => [f.id, f]));
  const br = new Map(b.rules.map((r) => [r.id, r]));
  const ar = new Map(after.rules.map((r) => [r.id, r]));
  const changedFields: FormDiff['changedFields'] = [];
  const nowRequired: FieldDef[] = [];
  for (const f of after.fields) {
    const o = bf.get(f.id);
    if (!o) continue;
    const what: string[] = [];
    if (o.label !== f.label) what.push('libellé');
    if (o.type !== f.type) what.push('type');
    if (o.help !== f.help) what.push('aide');
    if (!o.required && f.required) { what.push('devient obligatoire'); nowRequired.push(f); }
    else if (o.required && !f.required) what.push('devient facultatif');
    if (!o.blocking && f.blocking) { what.push('devient bloquant'); if (!nowRequired.includes(f)) nowRequired.push(f); }
    else if (o.blocking && !f.blocking) what.push('n’est plus bloquant');
    if (!same(o.options, f.options)) what.push('choix');
    if (!same([o.min, o.max, o.expected, o.defaultValue], [f.min, f.max, f.expected, f.defaultValue])) what.push('format ou réponse attendue');
    if (!same(o.products, f.products)) what.push('produits');
    if (what.length) changedFields.push({ id: f.id, label: f.label, what });
  }
  for (const f of after.fields) if (!bf.has(f.id) && (f.required || f.blocking)) nowRequired.push(f);
  return {
    addedFields: after.fields.filter((f) => !bf.has(f.id)),
    removedFields: b.fields.filter((f) => !af.has(f.id)),
    nowRequired,
    changedFields,
    addedRules: after.rules.filter((r) => !br.has(r.id)),
    removedRules: b.rules.filter((r) => !ar.has(r.id)),
    changedRules: after.rules.filter((r) => br.has(r.id) && !same(br.get(r.id), r)),
  };
}

export const isDiffEmpty = (d: FormDiff): boolean => Object.values(d).every((x) => x.length === 0);
