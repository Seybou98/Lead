import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, Pencil, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AID_LABELS, AIDS, CRITERION_MAX, defaultRule, MAX_CRITERIA, NOTE_MAX, parseProductRules, productKey, ruleFor, validateProductRules, ZONE_CODE, type AidCode, type ProductRule } from '../../domain/products/rules';
import { errorMessage, saveDraft } from '../../lib/adminApi';
import { DraftBanner } from './DraftBanner';
import { Feedback, inputCls, SaveBar, Switch } from './settingsUi';
import { useConfigData } from './useConfigData';

const CHECKLIST_CHIP = {
  own: { label: 'Propre', cls: 'bg-emerald-50 text-emerald-700' },
  default: { label: 'Par défaut', cls: 'bg-blue-50 text-blue-700' },
  builtin: { label: "Liste d'origine", cls: 'bg-amber-50 text-amber-800' },
} as const;

const clone = (l: ProductRule[]): ProductRule[] => JSON.parse(JSON.stringify(l));
const isDefault = (r: ProductRule): boolean => r.active && r.zones.length === 0 && r.aids.length === 0 && r.criteria.length === 0 && r.note === '';
const parseZones = (text: string): string[] => text.split(/[\s,;]+/).map((z) => z.trim().toUpperCase()).filter(Boolean);

/**
 * Produits & offres (§21.2, fig. 26 et 28) : pour chaque famille du catalogue du CRM principal, ce qui la couvre dans le CRM
 * Leads (checklist, équipes, télépros, campagnes) et ce que le CRM Leads y ajoute : périmètre commercial, critères
 * d'éligibilité à confirmer et aides compatibles. Le catalogue lui-même reste celui du CRM principal. Les modifications
 * passent par un brouillon (cycle Brouillon → Tester → Impact → Publier).
 */
export function ProductsPage() {
  const data = useConfigData();
  const settings = data.settings;
  const base = settings.drafts?.products ? parseProductRules(settings.drafts.products.doc) : settings.products;
  const [draft, setDraft] = useState<ProductRule[]>(base);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [zonesText, setZonesText] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadedKey = `${settings.loading}:${JSON.stringify(base)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(clone(base));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const alertsOf = (product: string) => data.alerts.filter((a) => a.id.endsWith(`:${product}`));
  const articles = new Map(data.catalog.categories.map((c) => [c.code, c]));
  const ruleOf = (code: string): ProductRule => ruleFor(draft, code) ?? defaultRule(code);
  const patch = (code: string, p: Partial<ProductRule>) => {
    setDraft((cur) => {
      const list = clone(cur);
      const i = list.findIndex((r) => productKey(r.code) === productKey(code));
      const next = { ...(i >= 0 ? list[i] : defaultRule(code)), ...p };
      if (i >= 0) list[i] = next;
      else list.push(next);
      return list;
    });
    setDirty(true);
    setNotice(null);
  };

  // Seules les familles qui s'écartent du réglage d'origine sont enregistrées.
  const toSave = draft.filter((r) => !isDefault(r));
  const errors = validateProductRules(toSave);
  const open = (code: string) => { setEditing(code); setZonesText(ruleOf(code).zones.join(', ')); };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveDraft('products', { products: toSave });
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Brouillon enregistré. Il n’affecte aucun lead : testez-le, mesurez son impact, puis publiez-le.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const rule = editing ? ruleOf(editing) : null;

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Produits &amp; offres</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Produits &amp; offres</h1>
      <p className="mt-1 text-slate-500">Les produits viennent du catalogue du CRM principal. Voyez ici ce qui les couvre dans le CRM Leads, puis réglez leur périmètre, leurs critères d’éligibilité et leurs aides.</p>
      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}
      <DraftBanner module="products" draft={settings.drafts?.products} />

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[1020px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>{['Produit', 'Articles', 'Checklist', 'Équipes', 'Télépros', 'Campagnes actives', 'Périmètre et aides', 'État', ''].map((h, i) => <th key={`${h}${i}`} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.coverage.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">{data.loading ? 'Chargement du catalogue…' : 'Le catalogue du CRM principal ne contient aucune famille de produit.'}</td></tr>}
            {data.coverage.map((c) => {
              const alerts = alertsOf(c.product);
              const chip = CHECKLIST_CHIP[c.checklist];
              const r = ruleOf(c.product);
              return (
                <tr key={c.product} className={cn('align-top hover:bg-slate-50', editing === c.product && 'bg-blue-50/40')}>
                  <td className="px-3 py-3"><span className="font-semibold text-slate-900">{c.product}</span><span className="block text-xs text-slate-400">{articles.get(c.product)?.samples.slice(0, 2).join(', ')}</span></td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{articles.get(c.product)?.count ?? 0}</td>
                  <td className="px-3 py-3"><Link to={`/parametres/documents?famille=${encodeURIComponent(c.product)}`} className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:underline', chip.cls)}>{chip.label} <ExternalLink className="h-3 w-3" /></Link></td>
                  <td className="px-3 py-3 text-slate-700">{c.teams.length ? c.teams.join(', ') : <span className="text-slate-400">Aucune</span>}</td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{c.telepros}</td>
                  <td className="px-3 py-3 text-slate-700">{c.activeCampaigns.length ? c.activeCampaigns.join(', ') : <span className="text-slate-400">Aucune</span>}</td>
                  <td className="px-3 py-3 text-xs text-slate-700">
                    {!r.active && <span className="mb-1 inline-block rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-700">Suspendu</span>}
                    <span className="block">{r.zones.length ? `Départements : ${r.zones.slice(0, 8).join(', ')}${r.zones.length > 8 ? '…' : ''}` : 'Toute la France'}</span>
                    <span className="block text-slate-500">{r.aids.length ? r.aids.map((a) => AID_LABELS[a]).join(', ') : 'Aucune aide indiquée'}{r.criteria.length ? ` · ${r.criteria.length} critère${r.criteria.length > 1 ? 's' : ''}` : ''}</span>
                  </td>
                  <td className="px-3 py-3">
                    {alerts.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> À jour</span>
                    ) : (
                      <ul className="space-y-1">
                        {alerts.map((a) => (
                          <li key={a.id}><Link to={a.href} className={cn('inline-flex items-start gap-1 text-xs font-medium hover:underline', a.level === 'blocking' ? 'text-red-700' : 'text-amber-800')}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{a.title}</Link></li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-3"><button type="button" aria-label={`Configurer ${c.product}`} onClick={() => open(c.product)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /> Configurer</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && rule && (
        <section className="mt-5 rounded-xl border border-blue-200 bg-white p-5" aria-label={`Configuration de ${editing}`}>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">Configuration : {editing}</h2>
            <button type="button" aria-label="Fermer" onClick={() => setEditing(null)} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-4 grid gap-5 text-sm lg:grid-cols-2">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3"><span><span className="block font-medium text-slate-700">Produit actif</span><span className="block text-xs text-slate-500">Suspendu : plus proposé pour de nouvelles campagnes. Les leads en cours ne changent pas.</span></span><Switch label="Produit actif" checked={rule.active} onChange={(v) => patch(editing, { active: v })} /></div>
              <label className="block"><span className="font-medium text-slate-700">Départements couverts</span>
                <input aria-label="Départements couverts" value={zonesText} onChange={(e) => { setZonesText(e.target.value); patch(editing, { zones: parseZones(e.target.value) }); }} placeholder="75, 92, 2A, 974… (vide = toute la France)" className={`${inputCls} mt-1 w-full`} />
                {rule.zones.some((z) => !ZONE_CODE.test(z)) && <span className="mt-1 block text-xs text-red-600">Département invalide : {rule.zones.filter((z) => !ZONE_CODE.test(z)).join(', ')}</span>}
              </label>
              <fieldset><legend className="font-medium text-slate-700">Aides compatibles</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {AIDS.map((a: AidCode) => <label key={a} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={rule.aids.includes(a)} onChange={(e) => patch(editing, { aids: e.target.checked ? [...rule.aids, a] : rule.aids.filter((x) => x !== a) })} /> {AID_LABELS[a]}</label>)}
                </div>
              </fieldset>
            </div>
            <div className="space-y-4">
              <label className="block"><span className="font-medium text-slate-700">Critères d’éligibilité à confirmer avec le client</span>
                <textarea aria-label="Critères d’éligibilité" rows={5} value={rule.criteria.join('\n')} onChange={(e) => patch(editing, { criteria: e.target.value.split('\n').map((c) => c.slice(0, CRITERION_MAX)).slice(0, MAX_CRITERIA) })} placeholder={'Une ligne par critère\nPropriétaire occupant\nMaison individuelle\nChauffage existant à remplacer'} className={`${inputCls} mt-1 w-full`} />
                <span className="mt-1 block text-xs text-slate-500">Affichés au télépro dans la qualification. {rule.criteria.length}/{MAX_CRITERIA} critères.</span>
              </label>
              <label className="block"><span className="font-medium text-slate-700">Note interne</span>
                <input aria-label="Note interne" value={rule.note} maxLength={NOTE_MAX} onChange={(e) => patch(editing, { note: e.target.value })} className={`${inputCls} mt-1 w-full`} />
              </label>
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-500">Ce sont des repères pour le télépro et des alertes de configuration : ils ne bloquent aucune conversion. L’éligibilité d’un dossier reste celle de son montage et du formulaire de qualification publié.</p>
        </section>
      )}

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar onCancel={() => { setDraft(clone(base)); setDirty(false); setNotice(null); setEditing(null); }} onSave={() => void save()} busy={busy} blocked={errors.length > 0} dirty={dirty} saveLabel="Enregistrer le brouillon" />
    </div>
  );
}
