import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Euro, FileText, Home, Lock, Plus, Save, Send, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { canCreateSale, evaluateControls, lockReason } from '../../domain/conversion/controls';
import { formatEuros, lineTtcCents, type OfferLine } from '../../domain/conversion/finance';
import { draftFromLead, MONTAGE_STEPS, type MontageDraft, type MontageStep } from '../../domain/conversion/montage';
import { sendConversionAction } from '../../lib/conversionApi';
import { Modal } from '../../components/ui/Modal';
import { Feedback } from '../settings/settingsUi';
import { EuroField, Field, inputCls, LevelIcon, SaleCard } from './saleUi';
import { useArticles, type SaleData, type SaleLead } from './useSaleData';
import { useParcelAuto } from './useParcelAuto';
import { useSettings } from '../settings/useSettings';
import { formatParcelCadastrale } from '../../domain/conversion/parcel';

const HOUSING = ['Maison individuelle', 'Appartement', 'Autre'];
const OCCUPANCY = ['Propriétaire occupant', 'Propriétaire bailleur', 'Locataire'];
const ZONES = ['H1', 'H2', 'H3'];
const SERVICES = ['Fourniture et pose', 'Fourniture seule', 'Pose seule'];
const VAT = [20, 10, 5.5];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sameDraft = (a: MontageDraft, b: MontageDraft) => JSON.stringify(a) === JSON.stringify(b);
const num = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};

export function MontageView({ leadId, lead, data, canAct }: { leadId: string; lead: SaleLead; data: SaleData; canAct: boolean }) {
  const initial = useMemo(() => data.draft ?? draftFromLead(lead), [data.draft, lead]);
  const [draft, setDraft] = useState<MontageDraft>(() => clone(initial));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { conversion: rules } = useSettings();
  const { articles, loading: articlesLoading } = useArticles(lead.productCode);
  const parcel = useParcelAuto({ street: draft.identity.addressLine, postalCode: draft.identity.postalCode, city: draft.identity.city });

  // Le brouillon enregistré fait foi tant que l'utilisateur n'a rien modifié ici.
  const dirty = !sameDraft(draft, initial);
  useEffect(() => {
    if (!dirty) setDraft(clone(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // Parcelle cadastrale automatique : elle remplit le champ tant qu'il est vide ; une saisie manuelle n'est jamais écrasée.
  useEffect(() => {
    if (parcel.parcelId && !draft.project.cadastralRef && canAct) setDraft((cur) => (cur.project.cadastralRef ? cur : { ...cur, project: { ...cur.project, cadastralRef: parcel.parcelId as string } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcel.parcelId, canAct]);

  const report = useMemo(() => evaluateControls({ lead: { consent: lead.consent, productCode: lead.productCode }, draft, docs: lead.docs, qualificationMissing: [], rules: rules }), [draft, lead, rules]);
  const validation = data.validation;
  const lock = lockReason(report, validation);
  const creatable = canCreateSale(report, validation) && !dirty;
  const recap = report.recap;
  const editable = canAct;

  const set = (fn: (d: MontageDraft) => void) =>
    setDraft((cur) => {
      const next = clone(cur);
      fn(next);
      return next;
    });
  const setLine = (id: string, patch: Partial<OfferLine>) => set((d) => { d.offer.lines = d.offer.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)); });

  const run = async (key: string, fn: () => ReturnType<typeof sendConversionAction>) => {
    setBusy(key);
    setNotice(null);
    const r = await fn();
    setBusy(null);
    setNotice(r.ok ? { kind: 'ok', text: r.message } : { kind: 'error', text: r.message });
    return r.ok;
  };
  const save = () => run('save', () => sendConversionAction(leadId, { kind: 'save_draft', draft }));
  const saveThen = async (action: () => ReturnType<typeof sendConversionAction>, key: string) => {
    if (dirty && !(await save())) return false;
    return run(key, action);
  };
  const ask = async () => {
    if (await saveThen(() => sendConversionAction(leadId, { kind: 'request_validation', message }), 'ask')) setAsking(false);
  };
  const create = async () => {
    if (await saveThen(() => sendConversionAction(leadId, { kind: 'create_sale' }), 'sale')) setConfirming(false);
  };

  const jump = (step: MontageStep) => document.getElementById(`montage-${step}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const stepLevel = (step: MontageStep) => {
    const cs = report.controls.filter((c) => c.step === step);
    if (cs.some((c) => c.level === 'blocking')) return 'blocking' as const;
    if (cs.some((c) => c.level === 'to_confirm')) return 'to_confirm' as const;
    return 'ok' as const;
  };

  const fieldsOff = !editable || busy !== null;
  const text = (get: (d: MontageDraft) => string, put: (d: MontageDraft, v: string) => void, label: string, extra?: { className?: string; placeholder?: string }) => (
    <Field label={label} className={extra?.className}>
      <input className={cn(inputCls, 'w-full')} value={get(draft)} placeholder={extra?.placeholder} disabled={fieldsOff} onChange={(e) => set((d) => put(d, e.target.value))} />
    </Field>
  );
  const select = (get: (d: MontageDraft) => string, put: (d: MontageDraft, v: string) => void, label: string, options: string[]) => (
    <Field label={label}>
      <select className={cn(inputCls, 'w-full')} value={get(draft)} disabled={fieldsOff} onChange={(e) => set((d) => put(d, e.target.value))}>
        <option value="">—</option>
        {get(draft) && !options.includes(get(draft)) && <option value={get(draft)}>{get(draft)}</option>}
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </Field>
  );

  const addCatalogLine = (articleId: string) => {
    const a = articles.find((x) => x.id === articleId);
    if (!a) return;
    set((d) => { d.offer.lines.push({ id: `l_${Date.now()}`, productId: a.id, label: [a.brand, a.name].filter(Boolean).join(' '), service: SERVICES[0], qty: 1, unitHtCents: a.unitHtCents, vatRate: a.vatRate }); });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        {/* Étapes (§11.4) */}
        <ol className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Étapes du montage">
          {MONTAGE_STEPS.map((s, i) => {
            const level = stepLevel(s.key);
            return (
              <li key={s.key}>
                <button type="button" onClick={() => jump(s.key)} className="flex items-center gap-2 text-sm font-medium text-slate-700 hover:text-slate-900">
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white', level === 'ok' ? 'bg-emerald-500' : level === 'to_confirm' ? 'bg-amber-500' : 'bg-blue-600')}>{i + 1}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>

        {validation.state === 'refused' || validation.state === 'correction' ? (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">{validation.state === 'refused' ? 'Validation refusée par le manager' : 'Le manager demande une correction'}</p>
            {validation.comment && <p className="mt-1">« {validation.comment} »</p>}
          </div>
        ) : null}
        {!editable && <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Consultation seule : le dossier se monte par son propriétaire, son manager ou un administrateur.</p>}

        <SaleCard id="montage-identity" title="1 · Identité et coordonnées" icon={<UserRound className="h-[18px] w-[18px] text-blue-600" />}>
          <div className="grid gap-3 sm:grid-cols-2">
            {text((d) => d.identity.fullName, (d, v) => { d.identity.fullName = v; }, 'Nom')}
            {text((d) => d.identity.phone, (d, v) => { d.identity.phone = v; }, 'Téléphone')}
            {text((d) => d.identity.email, (d, v) => { d.identity.email = v; }, 'Email')}
            {text((d) => d.identity.addressLine, (d, v) => { d.identity.addressLine = v; }, 'Adresse')}
            {text((d) => d.identity.postalCode, (d, v) => { d.identity.postalCode = v; }, 'Code postal')}
            {text((d) => d.identity.city, (d, v) => { d.identity.city = v; }, 'Ville')}
          </div>
          <p className="mt-2 text-xs text-slate-400">Repris du lead : toute correction est historisée.</p>
        </SaleCard>

        <SaleCard id="montage-project" title="2 · Projet et logement" icon={<Home className="h-[18px] w-[18px] text-blue-600" />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Produit du lead"><input className={cn(inputCls, 'w-full')} value={lead.productCode ?? ''} disabled /></Field>
            {select((d) => d.project.housingType, (d, v) => { d.project.housingType = v; }, 'Type de logement', HOUSING)}
            {select((d) => d.project.occupancy, (d, v) => { d.project.occupancy = v; }, "Statut d'occupation", OCCUPANCY)}
            <Field label="Surface habitable (m²)">
              <input className={cn(inputCls, 'w-full')} inputMode="decimal" value={draft.project.livingAreaM2 ?? ''} disabled={fieldsOff} onChange={(e) => set((d) => { d.project.livingAreaM2 = num(e.target.value); })} />
            </Field>
            {text((d) => d.project.currentHeating, (d, v) => { d.project.currentHeating = v; }, 'Chauffage actuel')}
            {select((d) => d.project.climateZone, (d, v) => { d.project.climateZone = v; }, 'Zone climatique', ZONES)}
            <Field label="Parcelle cadastrale" hint={parcel.loading ? 'Recherche de la parcelle à partir de l’adresse…' : parcel.parcelId && draft.project.cadastralRef === parcel.parcelId ? `Trouvée automatiquement : ${formatParcelCadastrale(parcel.parcelId)}` : parcel.error ? `${parcel.error} — saisie manuelle possible` : undefined}>
              <div className="flex gap-2">
                <input className={cn(inputCls, 'w-full')} value={draft.project.cadastralRef} placeholder="Automatique d'après l'adresse" disabled={fieldsOff} onChange={(e) => set((d) => { d.project.cadastralRef = e.target.value; })} />
                {editable && (
                  <button type="button" disabled={fieldsOff || parcel.loading || !parcel.query} onClick={() => { set((d) => { d.project.cadastralRef = ''; }); parcel.refresh(); }} className="whitespace-nowrap rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" title="Relancer la recherche de la parcelle cadastrale">Recalculer</button>
                )}
              </div>
            </Field>
            <Field label="Date de prévisite">
              <input type="date" className={cn(inputCls, 'w-full')} value={draft.project.previsitDate} disabled={fieldsOff} onChange={(e) => set((d) => { d.project.previsitDate = e.target.value; })} />
            </Field>
          </div>
        </SaleCard>

        <SaleCard id="montage-aids" title="3 · Aides et éligibilité" icon={<ShieldCheck className="h-[18px] w-[18px] text-blue-600" />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="MaPrimeRénov' (estimation)"><EuroField cents={draft.aids.mprCents} disabled={fieldsOff} ariaLabel="MaPrimeRénov' estimée" onChange={(c) => set((d) => { d.aids.mprCents = c; })} /></Field>
            <Field label="CEE (estimation)"><EuroField cents={draft.aids.ceeCents} disabled={fieldsOff} ariaLabel="CEE estimés" onChange={(c) => set((d) => { d.aids.ceeCents = c; })} /></Field>
            {text((d) => d.aids.delegate, (d, v) => { d.aids.delegate = v; }, 'Délégataire CEE')}
            <Field label="Éligibilité aux aides">
              <select className={cn(inputCls, 'w-full')} value={draft.aids.eligibility ?? ''} disabled={fieldsOff} onChange={(e) => set((d) => { d.aids.eligibility = (e.target.value || null) as MontageDraft['aids']['eligibility']; })}>
                <option value="">Non renseignée</option>
                <option value="validated">Validée</option>
                <option value="to_confirm">À confirmer</option>
                <option value="refused">Refusée (inéligible)</option>
              </select>
            </Field>
            <Field label="Revenu fiscal de référence"><EuroField cents={draft.aids.rfrCents ?? 0} disabled={fieldsOff} ariaLabel="Revenu fiscal de référence" onChange={(c) => set((d) => { d.aids.rfrCents = c || null; })} /></Field>
            <Field label="Personnes dans le foyer">
              <input className={cn(inputCls, 'w-full')} inputMode="numeric" value={draft.aids.householdSize ?? ''} disabled={fieldsOff} onChange={(e) => set((d) => { d.aids.householdSize = num(e.target.value); })} />
            </Field>
          </div>
          {draft.aids.ceeCents > 0 && (
            <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={draft.aids.ceeDoubleChecked} disabled={fieldsOff} onChange={(e) => set((d) => { d.aids.ceeDoubleChecked = e.target.checked; })} />
              Contrôle de double valorisation CEE effectué (obligatoire avant la vente)
            </label>
          )}
          <p className="mt-2 text-xs text-slate-400">Les montants MPR et CEE sont des estimations tant qu'ils ne sont pas validés.</p>
        </SaleCard>

        <SaleCard id="montage-offer" title="4 · Offre et financement" icon={<Euro className="h-[18px] w-[18px] text-blue-600" />}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-slate-500">
                  <th className="pb-2 pr-2">Produit</th><th className="pb-2 pr-2">Prestation</th><th className="w-16 pb-2 pr-2">Qté</th><th className="w-32 pb-2 pr-2">Prix HT</th><th className="w-24 pb-2 pr-2">TVA</th><th className="w-28 pb-2 pr-2 text-right">Total TTC</th><th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {draft.offer.lines.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-2">
                      {l.productId === null ? (
                        <input className={cn(inputCls, 'w-full')} value={l.label} placeholder="Produit hors catalogue" aria-label="Produit" disabled={fieldsOff} onChange={(e) => setLine(l.id, { label: e.target.value })} />
                      ) : <span className="block py-2 font-medium text-slate-800">{l.label}</span>}
                      {l.productId === null && <span className="text-xs text-amber-600">Hors catalogue : validation du manager</span>}
                    </td>
                    <td className="py-2 pr-2"><select className={cn(inputCls, 'w-full')} value={l.service} aria-label="Prestation" disabled={fieldsOff} onChange={(e) => setLine(l.id, { service: e.target.value })}>{SERVICES.map((s) => <option key={s}>{s}</option>)}</select></td>
                    <td className="py-2 pr-2"><input className={cn(inputCls, 'w-full')} inputMode="decimal" aria-label="Quantité" value={l.qty} disabled={fieldsOff} onChange={(e) => setLine(l.id, { qty: num(e.target.value) ?? 0 })} /></td>
                    <td className="py-2 pr-2"><EuroField cents={l.unitHtCents} ariaLabel="Prix HT" disabled={fieldsOff} onChange={(c) => setLine(l.id, { unitHtCents: c })} /></td>
                    <td className="py-2 pr-2"><select className={cn(inputCls, 'w-full')} value={l.vatRate} aria-label="TVA" disabled={fieldsOff} onChange={(e) => setLine(l.id, { vatRate: Number(e.target.value) })}>{VAT.map((v) => <option key={v} value={v}>{v} %</option>)}</select></td>
                    <td className="py-2 pr-2 text-right tabular-nums"><span className="block py-2 font-medium">{formatEuros(lineTtcCents(l))}</span></td>
                    <td className="py-2">{editable && <button type="button" aria-label="Retirer la ligne" onClick={() => set((d) => { d.offer.lines = d.offer.lines.filter((x) => x.id !== l.id); })} className="rounded p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}</td>
                  </tr>
                ))}
                {draft.offer.lines.length === 0 && <tr><td colSpan={7} className="py-4 text-sm text-slate-500">Aucun produit dans l'offre.</td></tr>}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className={cn(inputCls, 'max-w-xs')} value="" aria-label="Ajouter un produit du catalogue" disabled={fieldsOff || articlesLoading} onChange={(e) => e.target.value && addCatalogLine(e.target.value)}>
                <option value="">{articlesLoading ? 'Chargement du catalogue…' : articles.length === 0 ? 'Aucun article avec prix pour cette famille' : '+ Ajouter un produit du catalogue'}</option>
                {articles.map((a) => <option key={a.id} value={a.id}>{[a.brand, a.name].filter(Boolean).join(' ')} — {formatEuros(a.unitHtCents)} HT</option>)}
              </select>
              <button type="button" disabled={fieldsOff} onClick={() => set((d) => { d.offer.lines.push({ id: `l_${Date.now()}`, productId: null, label: '', service: SERVICES[0], qty: 1, unitHtCents: 0, vatRate: 20 }); })} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                <Plus className="h-4 w-4" /> Produit hors catalogue
              </button>
            </div>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Field label="Remise commerciale"><EuroField cents={draft.offer.discountCents} ariaLabel="Remise commerciale" disabled={fieldsOff} onChange={(c) => set((d) => { d.offer.discountCents = c; })} /></Field>
            <Field label="Qualification RGE de l'opération">
              <select className={cn(inputCls, 'w-full')} value={draft.offer.rge === null ? '' : draft.offer.rge ? 'yes' : 'no'} disabled={fieldsOff} onChange={(e) => set((d) => { d.offer.rge = e.target.value === '' ? null : e.target.value === 'yes'; })}>
                <option value="">Non renseignée</option>
                <option value="yes">Confirmée</option>
                <option value="no">Absente</option>
              </select>
            </Field>
            <Field label="Financement">
              <select className={cn(inputCls, 'w-full')} value={draft.offer.financing.mode} disabled={fieldsOff} onChange={(e) => set((d) => { d.offer.financing.mode = e.target.value === 'credit' ? 'credit' : 'cash'; })}>
                <option value="cash">Comptant</option>
                <option value="credit">Crédit</option>
              </select>
            </Field>
            <Field label="Apport"><EuroField cents={draft.offer.financing.downPaymentCents} ariaLabel="Apport" disabled={fieldsOff} onChange={(c) => set((d) => { d.offer.financing.downPaymentCents = c; })} /></Field>
            {draft.offer.financing.mode === 'credit' && (
              <Field label="Organisme de financement">
                <input className={cn(inputCls, 'w-full')} value={draft.offer.financing.organism ?? ''} placeholder="Floa, Domofinance, Sofinco…" maxLength={80} disabled={fieldsOff} onChange={(e) => set((d) => { d.offer.financing.organism = e.target.value; })} />
              </Field>
            )}
          </div>
        </SaleCard>

        <SaleCard id="montage-checks" title="5 · Vérifications" icon={<FileText className="h-[18px] w-[18px] text-blue-600" />}>
          <ul className="space-y-3">
            {report.controls.map((c) => (
              <li key={c.key} className="flex items-start gap-3 text-sm">
                <LevelIcon level={c.level} />
                <div><p className="font-medium text-slate-800">{c.label}</p><p className={cn(c.level === 'blocking' ? 'text-red-700' : c.level === 'to_confirm' ? 'text-amber-700' : 'text-slate-500')}>{c.detail}</p></div>
              </li>
            ))}
          </ul>
          <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5" checked={draft.consentConfirmed} disabled={fieldsOff} onChange={(e) => set((d) => { d.consentConfirmed = e.target.checked; })} />
            Le client a confirmé son consentement (signature électronique ou accord enregistré)
          </label>
          <Field label="Notes commerciales utiles" className="mt-4">
            <textarea className={cn(inputCls, 'min-h-20 w-full')} maxLength={2000} value={draft.notes} disabled={fieldsOff} onChange={(e) => set((d) => { d.notes = e.target.value; })} />
          </Field>
        </SaleCard>

        <Feedback errors={[]} notice={notice} />
        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={busy !== null || !dirty} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Save className="h-4 w-4" /> {busy === 'save' ? 'Enregistrement…' : 'Enregistrer le brouillon'}
            </button>
            {report.clean && report.toConfirm.length > 0 && validation.state !== 'approved' && (
              <button type="button" onClick={() => setAsking(true)} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-white px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                <Send className="h-4 w-4" /> Demander une validation
              </button>
            )}
            {dirty && <span className="text-xs text-slate-500">Modifications non enregistrées</span>}
          </div>
        )}
      </div>

      {/* Colonne de droite : contrôles et récapitulatif (fig. 1) */}
      <aside className="space-y-5 xl:sticky xl:top-4 xl:self-start">
        <SaleCard title="Contrôles avant vente" aside={<span className="text-sm font-semibold text-emerald-600">{report.validated}/{report.total} validés</span>}>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${report.total ? (report.validated / report.total) * 100 : 0}%` }} /></div>
          <ul className="mt-4 space-y-2.5">
            {report.controls.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={() => jump(c.step)} className="flex w-full items-center gap-2.5 text-left text-sm text-slate-700 hover:text-slate-900">
                  <LevelIcon level={c.level} className="h-[18px] w-[18px]" />
                  <span className="flex-1">{c.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </SaleCard>

        <SaleCard title="Récapitulatif financier">
          <dl className="space-y-2 text-sm">
            <Row label="Prix TTC" value={formatEuros(recap.totalTtcCents)} />
            <Row label="MaPrimeRénov' (estimation)" value={`− ${formatEuros(recap.mprCents)}`} tone="text-emerald-600" />
            <Row label="CEE (estimation)" value={`− ${formatEuros(recap.ceeCents)}`} tone="text-emerald-600" />
            <Row label="Remise commerciale" value={`− ${formatEuros(recap.discountCents)}`} />
          </dl>
          <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-4">
            <span className="text-sm font-semibold text-slate-900">Reste à charge</span>
            <span className={cn('text-2xl font-bold tabular-nums', recap.remainderCents < 0 ? 'text-red-600' : 'text-blue-700')}>{formatEuros(recap.remainderCents)}</span>
          </div>
          <p className="mt-2 text-xs text-slate-400">Prix TTC − MPR − CEE − remise = reste à charge.</p>
        </SaleCard>

        {editable && (
          <div>
            <button type="button" disabled={!creatable || busy !== null} onClick={() => setConfirming(true)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">
              {creatable ? <ShieldCheck className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Créer la vente
            </button>
            {(lock || dirty) && (
              <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5" /> {lock ?? 'Enregistrez le brouillon avant de créer la vente'}
              </p>
            )}
          </div>
        )}
      </aside>

      {asking && (
        <Modal
          title="Demander une validation au manager"
          onClose={() => setAsking(false)}
          busy={busy !== null}
          width="max-w-lg"
          footer={
            <>
              <button type="button" onClick={() => setAsking(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
              <button type="button" onClick={() => void ask()} disabled={busy !== null || message.trim().length < 10} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy === 'ask' ? 'Envoi…' : 'Envoyer la demande'}</button>
            </>
          }
        >
          <p className="text-sm text-slate-600">Exceptions à faire valider : {report.toConfirm.map((c) => c.label).join(', ')}.</p>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Message au manager (obligatoire)</span>
            <textarea autoFocus className={cn(inputCls, 'min-h-28 w-full')} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Expliquez la situation et pourquoi la vente doit avoir lieu." />
          </label>
          <Feedback errors={[]} notice={notice?.kind === 'error' ? notice : null} />
        </Modal>
      )}

      {confirming && (
        <Modal
          title="Confirmer la création de la vente"
          onClose={() => setConfirming(false)}
          busy={busy !== null}
          width="max-w-lg"
          footer={
            <>
              <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</button>
              <button type="button" onClick={() => void create()} disabled={busy !== null} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy === 'sale' ? 'Création…' : 'Créer la vente'}</button>
            </>
          }
        >
          <dl className="space-y-2 text-sm">
            <Row label="Client" value={draft.identity.fullName} />
            <Row label="Projet" value={draft.offer.lines.map((l) => l.label).join(' + ') || '—'} />
            <Row label="Prix TTC" value={formatEuros(recap.totalTtcCents)} />
            <Row label="Aides estimées" value={formatEuros(recap.mprCents + recap.ceeCents)} />
            <Row label="Reste à charge" value={formatEuros(recap.remainderCents)} strong />
          </dl>
          <p className="mt-4 text-xs text-slate-500">La vente est enregistrée une seule fois : un second clic ou une reprise ne crée rien de plus. Le lead passe en « Transmission en cours ».</p>
          <Feedback errors={[]} notice={notice?.kind === 'error' ? notice : null} />
        </Modal>
      )}
    </div>
  );
}

export function Row({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-slate-600">{label}</dt>
      <dd className={cn('text-right tabular-nums', strong ? 'text-base font-bold text-slate-900' : 'font-medium text-slate-900', tone)}>{value}</dd>
    </div>
  );
}

