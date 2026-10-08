import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, FileText, Info, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { checklistKey, DEFAULT_CHECKLIST_KEY, MAX_CHECKLIST_ITEMS, MAX_LABEL, parseChecklist, resolveChecklist, validateChecklist, type ChecklistItem } from '../../domain/documents/checklist';
import { reorderList } from '../../domain/admin/reorder';
import { deleteChecklist, errorMessage, saveChecklist } from '../../lib/adminApi';
import { useProductCatalog } from '../products/useProductCatalog';
import { useChecklists } from '../documents/useChecklists';

interface Row extends Partial<Pick<ChecklistItem, 'code'>> {
  label: string;
  mandatory: boolean;
}

const fmt = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }));

/**
 * Checklists documentaires (§10.1, §21.4, fig. 28) : une liste de pièces par famille de produit du catalogue, plus une
 * liste « par défaut » pour toutes les autres. Elle s'applique aux NOUVELLES demandes de documents ; les dossiers
 * déjà ouverts gardent la liste qui leur a été demandée.
 */
export function ChecklistsPage() {
  const catalog = useProductCatalog();
  const lists = useChecklists();
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string>(() => checklistKey(params.get('famille')));
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Familles du catalogue, plus celles qui ont une checklist mais ont disparu du catalogue (à pouvoir retirer).
  const entries = useMemo(() => {
    const fromCatalog = catalog.categories.map((c) => ({ key: checklistKey(c.code), label: c.code, hint: `${c.count} article${c.count > 1 ? 's' : ''}` }));
    const known = new Set(fromCatalog.map((e) => e.key));
    const orphans = Object.keys(lists.byKey)
      .filter((k) => k !== DEFAULT_CHECKLIST_KEY && !known.has(k))
      .map((k) => ({ key: k, label: String((lists.byKey[k] as { productCode?: string } | undefined)?.productCode ?? k), hint: 'hors catalogue' }));
    return [{ key: DEFAULT_CHECKLIST_KEY, label: 'Par défaut', hint: 'tous les autres produits' }, ...fromCatalog, ...orphans];
  }, [catalog.categories, lists.byKey]);

  const current = entries.find((e) => e.key === selected) ?? entries[0];
  const own = parseChecklist(lists.byKey[current.key]);
  const resolved = resolveChecklist(current.key === DEFAULT_CHECKLIST_KEY ? null : current.label, lists.byKey);

  // Changement de famille ou mise à jour en base : on repart de la liste enregistrée, sauf modification en cours.
  const loadedFor = `${current.key}:${lists.loading}:${JSON.stringify(own)}`;
  useEffect(() => {
    if (dirty) return;
    setRows(resolved.items.map((i) => ({ code: i.code, label: i.label, mandatory: i.mandatory })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFor]);

  const choose = (key: string) => {
    if (dirty && !window.confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return;
    setDirty(false);
    setNotice(null);
    setSelected(key);
    // L'effet ci-dessus recharge la liste ; on force le recalcul même si la clé de chargement est identique.
    setRows([]);
  };
  const edit = (next: Row[]) => {
    setRows(next);
    setDirty(true);
    setNotice(null);
  };

  const errors = validateChecklist(rows.map((r) => ({ code: r.code ?? '-', label: r.label, mandatory: r.mandatory })));
  const inheritedFrom = own ? null : resolved.source === 'default' ? 'la checklist par défaut' : 'la liste d’origine du CRM';

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveChecklist({ productCode: current.key === DEFAULT_CHECKLIST_KEY ? null : current.label, items: rows.map((r) => ({ code: r.code, label: r.label.trim(), mandatory: r.mandatory })) });
      setDirty(false);
      setNotice({ kind: 'ok', text: `Checklist « ${current.label} » enregistrée. Elle s'applique aux prochaines demandes de documents.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(`Supprimer la checklist propre à « ${current.label} » ? Ce produit utilisera la checklist par défaut.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteChecklist(current.key);
      setDirty(false);
      setNotice({ kind: 'ok', text: `« ${current.label} » utilise de nouveau la checklist par défaut.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const mandatoryCount = rows.filter((r) => r.mandatory).length;

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Documents et checklists</span>
      </nav>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">Documents et checklists</h1>
      <p className="mt-1 text-slate-500">Choisissez les pièces demandées au client, produit par produit. Les produits viennent du catalogue du CRM principal.</p>

      {(lists.error || catalog.error) && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" /> {catalog.error ? 'Le catalogue produits est illisible.' : 'Les checklists sont illisibles : vérifiez vos droits et les règles Firestore.'}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-slate-200 bg-white p-2" aria-label="Produits">
          {catalog.loading && <p className="p-3 text-sm text-slate-500">Chargement du catalogue…</p>}
          <ul className="space-y-0.5">
            {entries.map((e) => {
              const has = e.key === DEFAULT_CHECKLIST_KEY ? parseChecklist(lists.byKey[e.key]) !== null : parseChecklist(lists.byKey[e.key]) !== null;
              return (
                <li key={e.key}>
                  <button type="button" onClick={() => choose(e.key)} aria-current={e.key === current.key} className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm', e.key === current.key ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-700 hover:bg-slate-50')}>
                    <span className="min-w-0">
                      <span className="block truncate">{e.label}</span>
                      <span className="block truncate text-xs font-normal text-slate-400">{e.hint}</span>
                    </span>
                    <span className={cn('flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', has ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{has ? 'Propre' : 'Hérite'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="rounded-xl border border-slate-200 bg-white p-6" aria-label={`Checklist ${current.label}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><FileText className="h-[18px] w-[18px] text-blue-600" /> Pièces demandées — {current.label}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {inheritedFrom ? `Ce produit n'a pas de liste propre : il utilise ${inheritedFrom}. Enregistrez pour créer la sienne.` : `Liste propre à ce produit${own && lists.updatedAt[current.key] ? ` · modifiée le ${fmt(lists.updatedAt[current.key])}` : ''}.`}
              </p>
            </div>
            <p className="text-sm text-slate-600">{rows.length} pièce{rows.length > 1 ? 's' : ''} · {mandatoryCount} obligatoire{mandatoryCount > 1 ? 's' : ''}</p>
          </div>

          <ul className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">Aucune pièce. Ajoutez la première.</li>}
            {rows.map((r, i) => (
              <li key={r.code ?? `new-${i}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="flex flex-col">
                  <button type="button" aria-label={`Monter ${r.label || 'la pièce'}`} disabled={i === 0} onClick={() => edit(reorderList(rows, i, i - 1))} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Descendre ${r.label || 'la pièce'}`} disabled={i === rows.length - 1} onClick={() => edit(reorderList(rows, i, i + 1))} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                </div>
                <input
                  aria-label={`Nom de la pièce ${i + 1}`}
                  value={r.label}
                  maxLength={MAX_LABEL}
                  placeholder="Nom de la pièce (ex. Taxe foncière)"
                  onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  className="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={r.mandatory} onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, mandatory: e.target.checked } : x)))} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                  Obligatoire
                </label>
                <button type="button" aria-label={`Retirer ${r.label || 'la pièce'}`} onClick={() => edit(rows.filter((_, j) => j !== i))} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>

          <button type="button" disabled={rows.length >= MAX_CHECKLIST_ITEMS} onClick={() => edit([...rows, { label: '', mandatory: false }])} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <Plus className="h-4 w-4" /> Ajouter une pièce
          </button>

          <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
            Cette liste s&apos;applique aux prochaines demandes de documents. Les dossiers déjà ouverts gardent les pièces qui leur ont été demandées.
          </p>

          {dirty && errors.length > 0 && (
            <ul role="alert" className="mt-3 space-y-1 text-sm text-red-700">
              {errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          {notice && (
            <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
              {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />} {notice.text}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            {own && current.key !== DEFAULT_CHECKLIST_KEY ? (
              <button type="button" disabled={busy} onClick={reset} className="text-sm text-slate-500 underline hover:text-slate-800 disabled:opacity-50">Revenir à la checklist par défaut</button>
            ) : (
              <span />
            )}
            <button type="button" disabled={busy || !dirty || errors.length > 0} onClick={save} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Enregistrement…' : 'Enregistrer la checklist'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
