import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, UserPlus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { checkRows } from '../../domain/ingest/csv';
import { bufferReasonText } from '../../domain/labels';
import { newBatchId, sendImportBatch, type ImportRowResult } from '../../lib/importApi';
import { inputCls } from '../settings/settingsUi';
import { useIntakeOptions } from './useIntakeOptions';

const EMPTY = { firstName: '', lastName: '', phone: '', email: '', addressLine: '', postalCode: '', city: '', productCode: '', campaignId: '', sourceId: '', consent: false };

/**
 * Saisie manuelle d'un lead (§4.1) : mêmes contrôles et même réception qu'un lead venu d'une source (donnée brute
 * conservée, normalisation, doublon signalé, attribution, SLA). Un contact déjà connu est rattaché, jamais recréé.
 */
export function NewLeadPage() {
  const options = useIntakeOptions();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportRowResult | null>(null);

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => {
    setF((cur) => ({ ...cur, [k]: v }));
    setError(null);
  };
  const payload = useMemo(() => {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v.trim() && k !== 'sourceId') p[k] = v.trim();
    if (f.consent) p.consent = 'oui';
    return p;
  }, [f]);
  const check = useMemo(() => checkRows([payload])[0], [payload]);
  const hasInput = Object.keys(payload).length > 0;

  const submit = async () => {
    if (check.status === 'error') return setError(check.problems[0] ?? 'Saisie incomplète.');
    setBusy(true);
    setError(null);
    const res = await sendImportBatch({ channel: 'manual', sourceId: f.sourceId || null, batchId: newBatchId(), startRow: 1, rows: [payload] });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setResult(res.results[0]);
  };

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="block text-sm"><span className="font-medium text-slate-700">{label}</span>{node}{hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}</label>
  );
  const text = (k: 'firstName' | 'lastName' | 'phone' | 'email' | 'addressLine' | 'postalCode' | 'city', label: string, type = 'text', hint?: string) =>
    field(label, <input aria-label={label} type={type} value={f[k]} maxLength={200} onChange={(e) => set(k, e.target.value)} className={cn(inputCls, 'mt-1 w-full')} />, hint);

  if (result) {
    return (
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-bold text-slate-900">Nouveau lead</h1>
        <div role="status" className={cn('mt-5 rounded-xl border p-5', result.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50')}>
          {result.ok ? (
            <>
              <p className="flex items-center gap-2 font-semibold text-emerald-800"><CheckCircle2 className="h-5 w-5" /> {result.kind === 'created' ? 'Lead créé' : 'Ce contact existe déjà'}</p>
              <p className="mt-1 text-sm text-emerald-900">
                {result.kind === 'created' ? (result.assignmentState === 'assigned' ? 'Il a été attribué à un télépro, son compteur de prise en charge est lancé.' : `Il est dans la file tampon (${bufferReasonText(result.bufferReason)}), où il reste chronométré et réévalué.`) : 'Une nouvelle interaction a été ajoutée à la fiche existante : aucun second lead n’a été créé.'}
              </p>
              <Link to={`/leads/${result.leadId}`} className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Ouvrir la fiche</Link>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-semibold text-red-800"><AlertTriangle className="h-5 w-5" /> Lead refusé</p>
              <p className="mt-1 text-sm text-red-900">{result.reason}</p>
            </>
          )}
        </div>
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={() => { setResult(null); setF(EMPTY); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Saisir un autre lead</button>
          {!result.ok && <button type="button" onClick={() => setResult(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Corriger la saisie</button>}
          <Link to="/leads" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Retour aux leads</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/leads" className="text-blue-600 hover:underline">Leads</Link>
        <span className="mx-2">/</span>
        <span>Nouveau lead</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Nouveau lead</h1>
      <p className="mt-1 text-slate-500">Saisie manuelle d’un contact : il suit la même réception qu’un lead venu d’une source (doublons, attribution, alerte de prise en charge).</p>

      <form className="mt-5 space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Contact</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {text('firstName', 'Prénom')}
            {text('lastName', 'Nom')}
            {text('phone', 'Téléphone', 'tel', 'Format libre : normalisé automatiquement.')}
            {text('email', 'Email', 'email')}
          </div>
          <p className="mt-3 text-xs text-slate-500">Il faut au moins un téléphone ou un email.</p>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Logement</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">{text('addressLine', 'Adresse')}</div>
            {text('postalCode', 'Code postal')}
            <div className="sm:col-span-2">{text('city', 'Ville')}</div>
          </div>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Origine et projet</h2>
          {options.error && <p role="alert" className="mt-2 text-sm text-red-700">Lecture des sources et campagnes refusée : vérifiez vos droits.</p>}
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {field('Produit', <select aria-label="Produit" value={f.productCode} onChange={(e) => set('productCode', e.target.value)} className={cn(inputCls, 'mt-1 w-full')}><option value="">Non précisé</option>{options.products.map((p) => <option key={p} value={p}>{p}</option>)}</select>)}
            {field('Campagne', <select aria-label="Campagne" value={f.campaignId} onChange={(e) => set('campaignId', e.target.value)} className={cn(inputCls, 'mt-1 w-full')}><option value="">Aucune</option>{options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'active' ? ` (${c.status})` : ''}</option>)}</select>, 'La campagne détermine les télépros éligibles.')}
            {field('Source', <select aria-label="Source" value={f.sourceId} onChange={(e) => set('sourceId', e.target.value)} className={cn(inputCls, 'mt-1 w-full')}><option value="">Saisie manuelle</option>{options.sources.map((s) => <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name}{s.enabled ? '' : ' (désactivée)'}</option>)}</select>)}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={f.consent} onChange={(e) => set('consent', e.target.checked)} /> Le prospect a donné son accord pour être contacté</label>
        </section>

        {hasInput && check.problems.length > 0 && <p className={cn('rounded-lg px-4 py-3 text-sm', check.status === 'error' ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-800')}>{check.problems.join(' ')}</p>}
        {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={busy || check.status === 'error'} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><UserPlus className="h-4 w-4" /> {busy ? 'Création…' : 'Créer le lead'}</button>
          <Link to="/leads" className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Annuler</Link>
        </div>
      </form>
    </div>
  );
}
