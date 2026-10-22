import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { ruleText } from '../../domain/qualification/describe';
import { ACTIONS, ACTION_LABELS, COMPUTE_LABELS, COMPUTE_OPS, NUMERIC_TYPES, OPS, OP_LABELS, validateForm, type Clause, type FieldDef, type Op, type QualificationForm, type Rule } from '../../domain/qualification/form';
import { inputCls } from '../settings/settingsUi';

const opsFor = (f: FieldDef | undefined): Op[] => {
  if (!f) return [...OPS];
  if (NUMERIC_TYPES.includes(f.type)) return ['eq', 'neq', 'gt', 'lt', 'filled', 'empty'];
  if (f.type === 'yesno' || f.type === 'confirm') return ['eq', 'filled', 'empty'];
  if (f.type === 'list' || f.type === 'multi') return ['eq', 'neq', 'in', 'filled', 'empty'];
  return ['filled', 'empty'];
};

function defaultValue(f: FieldDef | undefined, op: Op): Clause['value'] {
  if (op === 'filled' || op === 'empty') return null;
  if (!f) return null;
  if (op === 'in') return f.options.length ? [f.options[0].value] : [];
  if (f.type === 'yesno' || f.type === 'confirm') return true;
  if (f.type === 'list' || f.type === 'multi') return f.options[0]?.value ?? null;
  return 0;
}

function ClauseRow({ clause, fields, onChange, onRemove }: { clause: Clause; fields: FieldDef[]; onChange: (c: Clause) => void; onRemove: () => void }) {
  const f = fields.find((x) => x.id === clause.fieldId);
  const ops = opsFor(f);
  const set = (patch: Partial<Clause>) => onChange({ ...clause, ...patch });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Champ" value={clause.fieldId} onChange={(e) => { const nf = fields.find((x) => x.id === e.target.value); const nops = opsFor(nf); const op = nops.includes(clause.op) ? clause.op : nops[0]; onChange({ fieldId: e.target.value, op, value: defaultValue(nf, op) }); }} className={`${inputCls} min-w-[160px] flex-1`}>
        {fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <select aria-label="Opérateur" value={clause.op} onChange={(e) => { const op = e.target.value as Op; set({ op, value: defaultValue(f, op) }); }} className={inputCls}>
        {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
      </select>
      {clause.op !== 'filled' && clause.op !== 'empty' && <ValueInput clause={clause} field={f} onChange={(value) => set({ value })} />}
      <button type="button" onClick={onRemove} aria-label="Retirer le critère" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

function ValueInput({ clause, field, onChange }: { clause: Clause; field: FieldDef | undefined; onChange: (v: Clause['value']) => void }) {
  if (clause.op === 'gt' || clause.op === 'lt' || (field && NUMERIC_TYPES.includes(field.type))) {
    return <input aria-label="Valeur" type="number" value={typeof clause.value === 'number' ? clause.value : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={`${inputCls} w-28`} />;
  }
  if (field && (field.type === 'yesno' || field.type === 'confirm')) {
    return (
      <select aria-label="Valeur" value={String(clause.value)} onChange={(e) => onChange(e.target.value === 'true')} className={inputCls}>
        <option value="true">Oui</option>
        <option value="false">Non</option>
      </select>
    );
  }
  if (field && (field.type === 'list' || field.type === 'multi')) {
    if (clause.op === 'in') {
      const cur = Array.isArray(clause.value) ? clause.value : [];
      return (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {field.options.map((o) => (
            <label key={o.value} className="flex items-center gap-1 text-sm text-slate-700">
              <input type="checkbox" checked={cur.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </span>
      );
    }
    return (
      <select aria-label="Valeur" value={typeof clause.value === 'string' ? clause.value : ''} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return <span className="text-xs text-slate-400">Ce type de champ se teste seulement « renseigné » ou « vide ».</span>;
}

/** Édition d'une condition : SI (critères) ALORS (effet). Les anomalies de la condition sont montrées avant l'enregistrement. */
export function RuleEditor({ initial, form, onSave, onClose }: { initial: Rule; form: QualificationForm; onSave: (r: Rule) => void; onClose: () => void }) {
  const [rule, setRule] = useState<Rule>(initial);
  const fields = form.fields;
  const numeric = fields.filter((f) => NUMERIC_TYPES.includes(f.type));
  const set = (patch: Partial<Rule>) => setRule((r) => ({ ...r, ...patch }));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const issues = useMemo(() => {
    const exists = form.rules.some((r) => r.id === rule.id);
    const next = { ...form, rules: exists ? form.rules.map((r) => (r.id === rule.id ? rule : r)) : [...form.rules, rule] };
    return validateForm(next).filter((i) => i.ruleId === rule.id || (i.code === 'circular' && !i.ruleId));
  }, [form, rule]);
  const errors = issues.filter((i) => i.level === 'error');

  const setAction = (action: Rule['action']) => set({ action, targets: action === 'alert' || action === 'eligibility' ? [] : action === 'compute' ? rule.targets.slice(0, 1) : rule.targets, compute: action === 'compute' ? (rule.compute ?? { op: 'sum', sources: [] }) : null, eligibility: action === 'eligibility' ? (rule.eligibility ?? 'to_confirm') : null });

  return (
    <Modal
      title="Condition"
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
          <button type="button" onClick={() => onSave(rule)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Valider la condition</button>
        </>
      }
    >
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{ruleText(rule, fields)}</p>

      <div className="mt-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          SI
          <select aria-label="Mode" value={rule.match} onChange={(e) => set({ match: e.target.value as Rule['match'] })} className={`${inputCls} py-1 text-xs font-normal`}>
            <option value="all">tous les critères sont vrais</option>
            <option value="any">au moins un critère est vrai</option>
          </select>
        </div>
        <div className="mt-2 space-y-2">
          {rule.clauses.map((c, i) => (
            <ClauseRow key={i} clause={c} fields={fields} onChange={(n) => set({ clauses: rule.clauses.map((x, j) => (j === i ? n : x)) })} onRemove={() => set({ clauses: rule.clauses.filter((_, j) => j !== i) })} />
          ))}
        </div>
        <button type="button" disabled={fields.length === 0 || rule.clauses.length >= 10} onClick={() => { const f = fields[0]; const op = opsFor(f)[0]; set({ clauses: [...rule.clauses, { fieldId: f.id, op, value: defaultValue(f, op) }] }); }} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter un critère</button>
      </div>

      <div className="mt-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          ALORS
          <select aria-label="Effet" value={rule.action} onChange={(e) => setAction(e.target.value as Rule['action'])} className={`${inputCls} py-1 text-xs font-normal`}>
            {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
          </select>
        </div>

        {(rule.action === 'show' || rule.action === 'hide' || rule.action === 'require') && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input type="checkbox" checked={rule.targets.includes(f.id)} onChange={() => set({ targets: toggle(rule.targets, f.id) })} />
                {f.label}
              </label>
            ))}
          </div>
        )}
        {rule.action === 'alert' && <textarea aria-label="Message d’alerte" rows={2} maxLength={300} value={rule.message} onChange={(e) => set({ message: e.target.value })} placeholder="Message affiché au télépro" className={`${inputCls} mt-2 w-full`} />}
        {rule.action === 'eligibility' && (
          <select aria-label="Éligibilité" value={rule.eligibility ?? 'to_confirm'} onChange={(e) => set({ eligibility: e.target.value as 'to_confirm' | 'refused' })} className={`${inputCls} mt-2`}>
            <option value="to_confirm">À confirmer</option>
            <option value="refused">Refusée</option>
          </select>
        )}
        {rule.action === 'compute' && (
          <div className="mt-2 space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-600">Résultat dans</span>
              <select aria-label="Champ résultat" value={rule.targets[0] ?? ''} onChange={(e) => set({ targets: e.target.value ? [e.target.value] : [] })} className={inputCls}>
                <option value="">Choisir…</option>
                {numeric.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <span className="text-slate-600">=</span>
              <select aria-label="Calcul" value={rule.compute?.op ?? 'sum'} onChange={(e) => set({ compute: { op: e.target.value as 'sum', sources: rule.compute?.sources ?? [] } })} className={inputCls}>
                {COMPUTE_OPS.map((o) => <option key={o} value={o}>{COMPUTE_LABELS[o]}</option>)}
              </select>
              <span className="text-slate-600">de</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {numeric.filter((f) => f.id !== rule.targets[0]).map((f) => (
                <label key={f.id} className="flex items-center gap-1.5 text-slate-700">
                  <input type="checkbox" checked={(rule.compute?.sources ?? []).includes(f.id)} onChange={() => set({ compute: { op: rule.compute?.op ?? 'sum', sources: toggle(rule.compute?.sources ?? [], f.id) } })} />
                  {f.label}
                </label>
              ))}
              {numeric.length < 3 && <span className="text-xs text-slate-400">Il faut au moins trois champs numériques : deux sources et un résultat.</span>}
            </div>
          </div>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="mt-4 space-y-1">
          {issues.map((i, k) => <li key={k} className={i.level === 'error' ? 'text-sm text-red-700' : 'text-sm text-amber-700'}>• {i.message}</li>)}
        </ul>
      )}
      {errors.length > 0 && <p className="mt-2 text-xs text-slate-500">Vous pouvez valider la condition et corriger plus tard : le brouillon accepte les anomalies, la publication non.</p>}
    </Modal>
  );
}
