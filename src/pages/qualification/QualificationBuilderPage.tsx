import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Eye, FlaskConical, GitBranch, Plus, Save, Send, Trash2, Undo2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Modal } from '../../components/ui/Modal';
import { reorderList } from '../../domain/admin/reorder';
import { checklistKey, DEFAULT_CHECKLIST_KEY } from '../../domain/documents/checklist';
import { rulesUsing, ruleText, showConditions } from '../../domain/qualification/describe';
import { blankField, diffForms, EMPTY_FORM, errorsOf, FIELD_TYPES, FIELD_TYPE_LABELS, isDiffEmpty, newId, NUMERIC_TYPES, validateForm, type FieldDef, type FieldType, type QualificationForm, type Rule } from '../../domain/qualification/form';
import { discardQualificationDraft, errorMessage, publishQualification, saveQualificationDraft } from '../../lib/adminApi';
import { useProductCatalog } from '../products/useProductCatalog';
import { inputCls, Switch } from '../settings/settingsUi';
import { RuleEditor } from './RuleEditor';
import { TestModal } from './TestModal';
import { useQualificationDoc } from './useQualificationForm';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const fmt = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }));

/**
 * Constructeur de qualification conditionnelle (§21.3, fig. 27). Cycle : Brouillon → Tester → Vérifier l'impact → Publier.
 * Un brouillon n'affecte aucun lead ; la publication crée une nouvelle version et refuse toute anomalie bloquante.
 */
export function QualificationBuilderPage({ previewSeed }: { /** Formulaire de départ pour une prévisualisation hors base (tests visuels) ; sans effet en usage normal. */ previewSeed?: QualificationForm } = {}) {
  const catalog = useProductCatalog();
  const [params, setParams] = useSearchParams();
  const entries = useMemo(() => [{ key: DEFAULT_CHECKLIST_KEY, code: null as string | null, label: 'Par défaut' }, ...catalog.categories.map((c) => ({ key: checklistKey(c.code), code: c.code as string | null, label: c.code }))], [catalog.categories]);
  const [selected, setSelected] = useState<string>(() => checklistKey(params.get('famille')));
  const current = entries.find((e) => e.key === selected) ?? entries[0];
  const doc = useQualificationDoc(current.code);

  const [form, setForm] = useState<QualificationForm>(previewSeed ?? EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [ruleEdit, setRuleEdit] = useState<Rule | null>(null);
  const [test, setTest] = useState<'preview' | 'test' | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Changement de famille ou mise à jour en base : on repart du brouillon enregistré, sinon de la version publiée.
  const loadedFor = `${current.key}:${doc.loading}:${doc.updatedAtMs}:${doc.version}`;
  useEffect(() => {
    if (previewSeed || dirty || doc.loading) return;
    setForm(clone(doc.draft ?? doc.published ?? EMPTY_FORM));
    setSelId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFor]);

  const codes = useMemo(() => catalog.categories.map((c) => c.code), [catalog.categories]);
  const issues = useMemo(() => validateForm(form, { knownProducts: catalog.loading || catalog.error ? undefined : codes }), [form, codes, catalog.loading, catalog.error]);
  const errors = errorsOf(issues);
  const sel = form.fields.find((f) => f.id === selId) ?? null;
  const diff = useMemo(() => diffForms(doc.published, form), [doc.published, form]);
  const hasDraft = doc.draft !== null;

  const edit = (fn: (f: QualificationForm) => void) => {
    setForm((cur) => {
      const next = clone(cur);
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };
  const patchField = (id: string, patch: Partial<FieldDef>) => edit((f) => { const x = f.fields.find((y) => y.id === id); if (x) Object.assign(x, patch); });
  const choose = (key: string) => {
    if (dirty && !window.confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return;
    setDirty(false);
    setNotice(null);
    setSelected(key);
    setParams(key === DEFAULT_CHECKLIST_KEY ? {} : { famille: key });
  };

  const addField = (type: FieldType) => edit((f) => {
    const id = newId('q', FIELD_TYPE_LABELS[type], new Set(f.fields.map((x) => x.id)));
    f.fields.push(blankField(type, id));
    setSelId(id);
  });
  const removeField = (id: string) => {
    const used = rulesUsing(form, id);
    if (used.length > 0) {
      setNotice({ kind: 'error', text: `Ce champ est utilisé par ${used.length} condition${used.length > 1 ? 's' : ''} : modifiez-les ou supprimez-les d’abord.` });
      return;
    }
    edit((f) => { f.fields = f.fields.filter((x) => x.id !== id); });
    if (selId === id) setSelId(null);
  };
  const move = (i: number, to: number) => edit((f) => { f.fields = reorderList(f.fields, i, to); });
  const newRule = (fieldId?: string): Rule => {
    const f = form.fields.find((x) => x.id === fieldId) ?? form.fields[0];
    const op = f && NUMERIC_TYPES.includes(f.type) ? 'gt' : f && (f.type === 'yesno' || f.type === 'confirm' || f.type === 'list' || f.type === 'multi') ? 'eq' : 'filled';
    const value = op === 'eq' ? (f.type === 'yesno' || f.type === 'confirm' ? true : f.options[0]?.value ?? null) : op === 'gt' ? 0 : null;
    return { id: newId('r', f?.label ?? 'regle', new Set(form.rules.map((r) => r.id))), match: 'all', clauses: f ? [{ fieldId: f.id, op, value }] : [], action: 'show', targets: [], message: '', eligibility: null, compute: null };
  };
  const saveRule = (r: Rule) => {
    edit((f) => { const i = f.rules.findIndex((x) => x.id === r.id); if (i >= 0) f.rules[i] = r; else f.rules.push(r); });
    setRuleEdit(null);
  };

  const run = async (what: 'draft' | 'publish' | 'discard') => {
    setBusy(true);
    setNotice(null);
    try {
      const base = { productCode: current.code };
      if (what === 'draft') {
        await saveQualificationDraft({ ...base, form });
        setDirty(false);
        setNotice({ kind: 'ok', text: 'Brouillon enregistré. Aucun lead n’est affecté tant que vous ne publiez pas.' });
      } else if (what === 'publish') {
        const r = await publishQualification({ ...base, form, reason });
        setDirty(false);
        setPublishing(false);
        setReason('');
        setNotice({ kind: 'ok', text: `Formulaire publié (version v${doc.version + 1}).${r.warnings?.length ? ` Avertissement : ${r.warnings[0]}` : ''}` });
      } else {
        await discardQualificationDraft(base);
        setDirty(false);
        setForm(clone(doc.published ?? EMPTY_FORM));
        setNotice({ kind: 'ok', text: 'Brouillon abandonné : le formulaire publié est rétabli.' });
      }
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const status = dirty ? 'Modifications non enregistrées' : hasDraft ? `Brouillon (après v${doc.version})` : doc.version > 0 ? `Publié v${doc.version}` : 'Jamais publié';

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Constructeur de qualification</span>
      </nav>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Constructeur de qualification</h1>
        <select aria-label="Famille de produit" value={current.key} onChange={(e) => choose(e.target.value)} className={inputCls}>
          {entries.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <span className={cn('rounded-full px-3 py-1 text-xs font-medium', dirty ? 'bg-amber-50 text-amber-700' : hasDraft ? 'bg-amber-50 text-amber-700' : doc.version > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600')}>{status}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={() => setTest('preview')} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Eye className="h-4 w-4" /> Prévisualiser</button>
          <button type="button" onClick={() => setTest('test')} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"><FlaskConical className="h-4 w-4" /> Tester les conditions</button>
          {hasDraft && !dirty && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Abandonner le brouillon et revenir au formulaire publié ?')) void run('discard'); }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Undo2 className="h-4 w-4" /> Abandonner le brouillon</button>}
          <button type="button" disabled={busy || !dirty} onClick={() => void run('draft')} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Save className="h-4 w-4" /> Enregistrer le brouillon</button>
          <button type="button" disabled={busy || dirty || errors.length > 0 || form.fields.length === 0 || (!hasDraft && isDiffEmpty(diff))} onClick={() => setPublishing(true)} title={dirty ? 'Enregistrez d’abord le brouillon.' : errors.length ? 'Corrigez les erreurs avant de publier.' : ''} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Send className="h-4 w-4" /> Publier</button>
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-500">Construisez le questionnaire posé pour {current.code ? `la famille « ${current.label} »` : 'tous les produits sans formulaire propre'}. Un brouillon n’affecte aucun lead ; seule la publication crée une version.</p>

      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
        </p>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_320px]">
        {/* Champs disponibles */}
        <section className="h-fit rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Champs disponibles</h2>
          <ul className="mt-3 space-y-1.5">
            {FIELD_TYPES.map((t) => (
              <li key={t}><button type="button" onClick={() => addField(t)} disabled={form.fields.length >= 60} className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><span>{FIELD_TYPE_LABELS[t]}</span><Plus className="h-4 w-4 text-slate-400" /></button></li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-400">Cliquez pour ajouter un champ à la fin du formulaire.</p>
        </section>

        {/* Formulaire */}
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Formulaire de qualification</h2>
          {form.fields.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">Aucun champ. Ajoutez-en depuis la colonne de gauche.</p>
          ) : (
            <ol className="mt-4 space-y-2">
              {form.fields.map((f, i) => {
                const shows = showConditions(form, f.id);
                return (
                  <li key={f.id}>
                    <div role="button" tabIndex={0} onClick={() => setSelId(f.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelId(f.id); }} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5', selId === f.id ? 'border-blue-500 bg-blue-50/40' : 'border-slate-200 hover:bg-slate-50', errors.some((x) => x.fieldId === f.id) && 'border-red-300')}>
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs font-semibold text-slate-600">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{f.label || '(sans libellé)'}</span>
                        <span className="block text-xs text-slate-500">Type : {FIELD_TYPE_LABELS[f.type]}{f.products.length ? ` · ${f.products.join(', ')}` : ''}</span>
                        {shows.map((s) => <span key={s} className="mt-1 inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700"><GitBranch className="h-3 w-3" /> {s}</span>)}
                      </span>
                      {f.blocking ? <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Bloquant</span> : f.required ? <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">Obligatoire</span> : <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Facultatif</span>}
                      <span className="flex flex-col">
                        <button type="button" aria-label="Monter" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(i, i - 1); }} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label="Descendre" disabled={i === form.fields.length - 1} onClick={(e) => { e.stopPropagation(); move(i, i + 1); }} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                      </span>
                      <button type="button" aria-label="Supprimer le champ" onClick={(e) => { e.stopPropagation(); removeField(f.id); }} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Conditions ({form.rules.length})</h3>
            <button type="button" disabled={form.fields.length === 0 || form.rules.length >= 60} onClick={() => setRuleEdit(newRule(selId ?? undefined))} className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter une condition</button>
          </div>
          {form.rules.length === 0 ? <p className="mt-2 text-sm text-slate-500">Aucune condition : tous les champs sont toujours affichés.</p> : (
            <ul className="mt-2 space-y-1.5">
              {form.rules.map((r) => (
                <li key={r.id} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', errors.some((x) => x.ruleId === r.id) ? 'border-red-300 bg-red-50/40' : 'border-violet-200 bg-violet-50/40')}>
                  <GitBranch className="mt-0.5 h-4 w-4 flex-shrink-0 text-violet-600" />
                  <button type="button" onClick={() => setRuleEdit(clone(r))} className="flex-1 text-left text-slate-800 hover:underline">{ruleText(r, form.fields)}</button>
                  <button type="button" aria-label="Supprimer la condition" onClick={() => edit((f) => { f.rules = f.rules.filter((x) => x.id !== r.id); })} className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Propriétés */}
        <section className="h-fit rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Propriétés du champ</h2>
          {!sel ? <p className="mt-3 text-sm text-slate-500">Sélectionnez un champ pour modifier ses propriétés.</p> : (
            <Properties field={sel} form={form} codes={codes} onPatch={(p) => patchField(sel.id, p)} onAddRule={() => setRuleEdit(newRule(sel.id))} onEditRule={(r) => setRuleEdit(clone(r))} />
          )}
        </section>
      </div>

      <div className={cn('mt-5 rounded-lg border px-4 py-3 text-sm', errors.length ? 'border-red-200 bg-red-50 text-red-800' : issues.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800')} role="status">
        <p className="flex items-center gap-2 font-medium">
          {errors.length ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {errors.length ? `${errors.length} erreur${errors.length > 1 ? 's' : ''} à corriger avant de publier` : issues.length ? `${issues.length} avertissement${issues.length > 1 ? 's' : ''}` : 'Aucune erreur détectée'} — {form.fields.length} champ{form.fields.length > 1 ? 's' : ''}, {form.rules.length} condition{form.rules.length > 1 ? 's' : ''}
        </p>
        {issues.length > 0 && <ul className="mt-2 space-y-0.5">{issues.map((i, k) => <li key={k} className="text-xs"><button type="button" onClick={() => i.fieldId && setSelId(i.fieldId)} className="text-left hover:underline">{i.level === 'error' ? '✕' : '!'} {i.message}</button></li>)}</ul>}
      </div>
      <p className="mt-3 text-xs text-slate-400">{doc.version > 0 ? `Dernière publication : v${doc.version}${doc.publishedAtMs ? ` le ${fmt(doc.publishedAtMs)}` : ''}. L’historique et le retour arrière sont dans Versions & publication.` : 'Ce formulaire n’a jamais été publié.'}</p>

      {ruleEdit && <RuleEditor initial={ruleEdit} form={form} onSave={saveRule} onClose={() => setRuleEdit(null)} />}
      {test && <TestModal form={form} mode={test} productCode={current.code} onClose={() => setTest(null)} />}
      {publishing && (
        <Modal
          title={`Publier le formulaire « ${current.label} »`}
          onClose={() => setPublishing(false)}
          busy={busy}
          footer={
            <>
              <button type="button" onClick={() => setPublishing(false)} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
              <button type="button" onClick={() => void run('publish')} disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? 'Publication…' : `Publier la version v${doc.version + 1}`}</button>
            </>
          }
        >
          <p className="text-sm text-slate-700">La version v{doc.version + 1} remplace la version en vigueur pour les NOUVEAUX remplissages. Rien n’est détruit : l’ancienne version reste dans l’historique et peut être rétablie.</p>
          <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm">
            <p className="font-semibold text-slate-900">Impact par rapport à la version publiée</p>
            {isDiffEmpty(diff) ? <p className="mt-2 text-slate-600">Aucun écart.</p> : (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-slate-700">
                {diff.addedFields.map((f) => <li key={f.id}>Champ ajouté : {f.label}{f.required ? ' (obligatoire)' : ''}</li>)}
                {diff.removedFields.map((f) => <li key={f.id}>Champ retiré : {f.label}</li>)}
                {diff.changedFields.map((c) => <li key={c.id}>{c.label} : {c.what.join(', ')}</li>)}
                {diff.addedRules.length > 0 && <li>{diff.addedRules.length} condition(s) ajoutée(s)</li>}
                {diff.changedRules.length > 0 && <li>{diff.changedRules.length} condition(s) modifiée(s)</li>}
                {diff.removedRules.length > 0 && <li>{diff.removedRules.length} condition(s) retirée(s)</li>}
              </ul>
            )}
            {diff.nowRequired.length > 0 && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Risque de blocage : {diff.nowRequired.map((f) => f.label).join(', ')} {diff.nowRequired.length > 1 ? 'deviennent obligatoires' : 'devient obligatoire'}. Les formulaires déjà remplis avec une version précédente ne sont pas modifiés.</p>}
          </div>
          <label className="mt-4 block text-sm font-medium text-slate-700">Justification (facultative)
            <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputCls} mt-1 w-full`} placeholder="Ex. nouvelle question sur le chauffage demandée par la direction" />
          </label>
        </Modal>
      )}
    </div>
  );
}

function Properties({ field, form, codes, onPatch, onAddRule, onEditRule }: { field: FieldDef; form: QualificationForm; codes: string[]; onPatch: (p: Partial<FieldDef>) => void; onAddRule: () => void; onEditRule: (r: Rule) => void }) {
  const numeric = NUMERIC_TYPES.includes(field.type);
  const hasOptions = field.type === 'list' || field.type === 'multi';
  const rules = rulesUsing(form, field.id);
  const setOption = (i: number, label: string) => onPatch({ options: field.options.map((o, j) => (j === i ? { ...o, label } : o)) });
  const num = (v: string): number | null => (v === '' ? null : Number(v));
  return (
    <div className="mt-3 space-y-4 text-sm">
      <label className="block"><span className="font-medium text-slate-700">Libellé</span>
        <input aria-label="Libellé" value={field.label} maxLength={120} onChange={(e) => onPatch({ label: e.target.value })} className={`${inputCls} mt-1 w-full`} />
      </label>
      <label className="block"><span className="font-medium text-slate-700">Texte d’aide</span>
        <textarea aria-label="Texte d’aide" rows={2} maxLength={300} value={field.help} onChange={(e) => onPatch({ help: e.target.value })} className={`${inputCls} mt-1 w-full`} />
      </label>
      <p className="text-xs text-slate-500">Type : {FIELD_TYPE_LABELS[field.type]} · identifiant <span className="font-mono">{field.id}</span> (stable)</p>
      <div className="flex items-center justify-between"><span className="font-medium text-slate-700">Obligatoire</span><Switch label="Obligatoire" checked={field.required} disabled={field.blocking} onChange={(v) => onPatch({ required: v })} /></div>
      <div className="flex items-center justify-between"><span className="font-medium text-slate-700" title="Une réponse manquante ou différente de la réponse attendue bloque la qualification.">Bloquant</span><Switch label="Bloquant" checked={field.blocking} onChange={(v) => onPatch({ blocking: v, required: v ? true : field.required })} /></div>

      {hasOptions && (
        <div>
          <p className="font-medium text-slate-700">Choix</p>
          <ul className="mt-1 space-y-1">
            {field.options.map((o, i) => (
              <li key={o.value} className="flex items-center gap-1">
                <input aria-label={`Choix ${i + 1}`} value={o.label} maxLength={80} onChange={(e) => setOption(i, e.target.value)} className={`${inputCls} flex-1 py-1`} />
                <button type="button" aria-label="Retirer le choix" disabled={field.options.length <= 2} onClick={() => onPatch({ options: field.options.filter((_, j) => j !== i), defaultValue: field.defaultValue === o.value ? null : field.defaultValue, expected: field.expected === o.value ? null : field.expected })} className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"><X className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <button type="button" disabled={field.options.length >= 30} onClick={() => { const taken = new Set(field.options.map((o) => o.value)); let n = field.options.length + 1; while (taken.has(`option_${n}`)) n++; onPatch({ options: [...field.options, { value: `option_${n}`, label: `Option ${n}` }] }); }} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"><Plus className="h-3.5 w-3.5" /> Ajouter un choix</button>
        </div>
      )}

      {numeric && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="font-medium text-slate-700">Minimum</span><input aria-label="Minimum" type="number" value={field.min ?? ''} onChange={(e) => onPatch({ min: num(e.target.value) })} className={`${inputCls} mt-1 w-full`} /></label>
          <label className="block"><span className="font-medium text-slate-700">Maximum</span><input aria-label="Maximum" type="number" value={field.max ?? ''} onChange={(e) => onPatch({ max: num(e.target.value) })} className={`${inputCls} mt-1 w-full`} /></label>
        </div>
      )}
      {(field.type === 'text' || field.type === 'address') && (
        <label className="block"><span className="font-medium text-slate-700">Longueur maximale</span><input aria-label="Longueur maximale" type="number" min={1} value={field.max ?? ''} onChange={(e) => onPatch({ max: num(e.target.value) })} className={`${inputCls} mt-1 w-full`} /></label>
      )}

      {(hasOptions && field.type === 'list') || field.type === 'yesno' ? (
        <div className="grid grid-cols-2 gap-2">
          <ChoiceSelect label="Valeur par défaut" field={field} value={field.defaultValue} onChange={(v) => onPatch({ defaultValue: v })} />
          <ChoiceSelect label="Réponse attendue" field={field} value={field.expected} onChange={(v) => onPatch({ expected: v })} />
        </div>
      ) : numeric ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="font-medium text-slate-700">Valeur par défaut</span><input aria-label="Valeur par défaut" type="number" value={typeof field.defaultValue === 'number' ? field.defaultValue : ''} onChange={(e) => onPatch({ defaultValue: num(e.target.value) })} className={`${inputCls} mt-1 w-full`} /></label>
          <label className="block"><span className="font-medium text-slate-700">Réponse attendue</span><input aria-label="Réponse attendue" type="number" value={typeof field.expected === 'number' ? field.expected : ''} onChange={(e) => onPatch({ expected: num(e.target.value) })} className={`${inputCls} mt-1 w-full`} /></label>
        </div>
      ) : null}

      <div>
        <p className="font-medium text-slate-700">Produit visible</p>
        <p className="text-xs text-slate-500">Aucun coché : le champ s’applique à tous les produits.</p>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {codes.map((c) => (
            <label key={c} className="flex items-center gap-1 text-sm text-slate-700">
              <input type="checkbox" checked={field.products.includes(c)} onChange={(e) => onPatch({ products: e.target.checked ? [...field.products, c] : field.products.filter((x) => x !== c) })} />
              {c}
            </label>
          ))}
          {field.products.filter((p) => !codes.includes(p)).map((p) => <span key={p} className="text-xs text-amber-700">{p} (hors catalogue)</span>)}
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3">
        <p className="font-medium text-slate-700">Règles conditionnelles</p>
        {rules.length === 0 ? <p className="mt-1 text-xs text-slate-500">Aucune condition ne concerne ce champ.</p> : (
          <ul className="mt-1 space-y-1">{rules.map((r) => <li key={r.id}><button type="button" onClick={() => onEditRule(r)} className="w-full rounded bg-violet-50 px-2 py-1 text-left text-xs text-slate-800 hover:underline">{ruleText(r, form.fields)}</button></li>)}</ul>
        )}
        <button type="button" onClick={onAddRule} className="mt-2 w-full rounded-lg border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50">+ Ajouter une condition</button>
      </div>
    </div>
  );
}

function ChoiceSelect({ label, field, value, onChange }: { label: string; field: FieldDef; value: FieldDef['defaultValue']; onChange: (v: FieldDef['defaultValue']) => void }) {
  const opts = field.type === 'yesno' ? [{ value: 'true', label: 'Oui' }, { value: 'false', label: 'Non' }] : field.options;
  return (
    <label className="block"><span className="font-medium text-slate-700">{label}</span>
      <select aria-label={label} value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : field.type === 'yesno' ? e.target.value === 'true' : e.target.value)} className={`${inputCls} mt-1 w-full`}>
        <option value="">Aucune</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
