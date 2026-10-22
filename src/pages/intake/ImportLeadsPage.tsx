import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, FileUp, Info, Upload } from 'lucide-react';
import { cn } from '../../lib/utils';
import { downloadText, toCsv } from '../../domain/csv';
import { buildPayload, checkRows, duplicateTargets, IMPORT_FIELDS, lineBatches, parseCsv, rejectsCsvRows, suggestMapping, summarize, type ParsedCsv } from '../../domain/ingest/csv';
import { newBatchId, sendImportBatch, type ImportRowResult } from '../../lib/importApi';
import { inputCls } from '../settings/settingsUi';
import { useIntakeOptions } from './useIntakeOptions';

type Step = 'file' | 'columns' | 'check' | 'result';
const STEPS: { key: Step; label: string }[] = [{ key: 'file', label: 'Fichier' }, { key: 'columns', label: 'Colonnes' }, { key: 'check', label: 'Contrôle' }, { key: 'result', label: 'Import' }];

/** Lecture du fichier : UTF-8, sinon Windows-1252 (export Excel français) quand l'UTF-8 produit des caractères invalides. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

const KIND_LABEL: Record<string, string> = { created: 'Créé', attached: 'Rattaché à un lead existant', replay: 'Déjà importé' };

/**
 * Import CSV de leads (§4.1) : fichier → colonnes → contrôle → import par lots. Chaque ligne suit la même réception que
 * les autres sources (donnée brute conservée, doublons, attribution, SLA). Aucune ligne n'est perdue : celles qui sont
 * refusées sont listées avec leur motif et téléchargeables pour être corrigées.
 */
export function ImportLeadsPage() {
  const options = useIntakeOptions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [productCode, setProductCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportRowResult[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const payloads = useMemo(() => (csv ? csv.rows.map((r) => buildPayload(r, mapping, { campaignId: campaignId || undefined, productCode: productCode || undefined })) : []), [csv, mapping, campaignId, productCode]);
  const checks = useMemo(() => checkRows(payloads), [payloads]);
  const summary = useMemo(() => summarize(checks), [checks]);
  const duplicates = duplicateTargets(mapping);
  const hasContact = mapping.includes('phone') || mapping.includes('email');
  const sendable = checks.filter((c) => c.status !== 'error');
  const bigImport = sendable.length > 50;

  const load = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > 5_000_000) return setError('Fichier trop volumineux (5 Mo au plus).');
    try {
      const parsed = parseCsv(await readText(file));
      if (parsed.headers.length === 0 || parsed.rows.length === 0) return setError('Le fichier ne contient aucune ligne de données.');
      setFileName(file.name);
      setCsv(parsed);
      setMapping(suggestMapping(parsed.headers));
      setStep('columns');
    } catch {
      setError('Fichier illisible. Enregistrez-le au format CSV (séparateur « ; » ou « , »).');
    }
  };

  const run = async () => {
    if (!csv) return;
    setStep('result');
    setResults([]);
    setFailure(null);
    const batchId = newBatchId();
    const items = checks.map((c, i) => ({ line: c.line, payload: payloads[i], status: c.status })).filter((x) => x.status !== 'error');
    const refused: ImportRowResult[] = checks.filter((c) => c.status === 'error').map((c) => ({ row: c.line, ok: false, code: 'local', reason: c.problems[0] ?? 'Ligne inexploitable.' }));
    const out: ImportRowResult[] = [...refused];
    setResults(out.slice());
    setProgress({ done: 0, total: items.length });
    let done = 0;
    const queue = lineBatches(items);
    while (queue.length > 0) {
      const lot = queue.shift() as (typeof items)[number][];
      // Une coupure réseau ne perd rien : le lot est renvoyé avec le même identifiant, le serveur rend le même résultat.
      let res = await sendImportBatch({ channel: 'import', sourceId: sourceId || null, batchId, startRow: lot[0].line, rows: lot.map((x) => x.payload) });
      for (let attempt = 0; !res.ok && res.retryable && attempt < 2; attempt++) res = await sendImportBatch({ channel: 'import', sourceId: sourceId || null, batchId, startRow: lot[0].line, rows: lot.map((x) => x.payload) });
      if (!res.ok) {
        setFailure(`${res.message} ${done} ligne${done > 1 ? 's' : ''} sur ${items.length} traitée${done > 1 ? 's' : ''} : relancez l’import, les lignes déjà importées seront rattachées, jamais dupliquées.`);
        break;
      }
      out.push(...res.results);
      done += res.processed;
      // Le serveur s'arrête avant le délai de la fonction : la suite du lot repart dans l'appel suivant.
      if (res.processed < lot.length) queue.unshift(lot.slice(res.processed));
      setResults(out.slice());
      setProgress({ done, total: items.length });
    }
    setProgress(null);
  };

  const rejects = results.filter((r): r is Extract<ImportRowResult, { ok: false }> => !r.ok);
  const created = results.filter((r) => r.ok && r.kind === 'created').length;
  const attached = results.filter((r) => r.ok && r.kind !== 'created').length;
  const downloadRejects = () => csv && downloadText('leads-refuses.csv', toCsv(['Lignes refusées'], rejectsCsvRows(csv.headers, csv.rows, rejects.map((r) => ({ line: r.row, reason: r.reason })))));

  return (
    <div className="w-full max-w-5xl">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/leads" className="text-blue-600 hover:underline">Leads</Link>
        <span className="mx-2">/</span>
        <span>Importer un fichier CSV</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Importer des leads</h1>
      <p className="mt-1 text-slate-500">Chaque ligne suit la même réception qu’un lead venu de Pabbly : donnée brute conservée, téléphone et email normalisés, doublons détectés, attribution et alerte SLA.</p>

      <ol className="mt-5 flex flex-wrap gap-2 text-sm" aria-label="Étapes">
        {STEPS.map((s, i) => (
          <li key={s.key} className={cn('flex items-center gap-2 rounded-full border px-3 py-1', step === s.key ? 'border-blue-500 bg-blue-50 font-medium text-blue-700' : 'border-slate-200 text-slate-500')}>
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs font-semibold">{i + 1}</span>{s.label}
          </li>
        ))}
      </ol>

      {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}</p>}

      {step === 'file' && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-900">1. Choisissez un fichier</h2>
          <button type="button" onClick={() => fileInput.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void load(e.dataTransfer.files[0]); }} className="mt-3 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-6 py-10 text-slate-600 hover:border-blue-400 hover:bg-blue-50/30">
            <FileUp className="h-8 w-8 text-slate-400" />
            <span className="font-medium">Cliquez ou déposez un fichier CSV</span>
            <span className="text-xs text-slate-500">Séparateur « ; », « , » ou tabulation · UTF-8 ou Excel · 2 000 lignes et 5 Mo au plus · la première ligne contient les en-têtes</span>
          </button>
          <input ref={fileInput} type="file" accept=".csv,.txt,text/csv" className="sr-only" aria-label="Fichier CSV" onChange={(e) => void load(e.target.files?.[0])} />
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600"><Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> Colonnes reconnues : nom, prénom, téléphone, email, adresse, code postal, ville, produit, campagne, identifiant externe, consentement. Il faut au moins un téléphone ou un email par ligne.</p>
        </section>
      )}

      {step === 'columns' && csv && (
        <section className="mt-5 space-y-5">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">2. Associez les colonnes — {fileName}</h2>
            <p className="mt-1 text-xs text-slate-500">{csv.rows.length} ligne{csv.rows.length > 1 ? 's' : ''} lue{csv.rows.length > 1 ? 's' : ''}{csv.skippedEmpty ? `, ${csv.skippedEmpty} vide${csv.skippedEmpty > 1 ? 's' : ''} ignorée${csv.skippedEmpty > 1 ? 's' : ''}` : ''}{csv.truncated ? ` — ${csv.truncated} ligne${csv.truncated > 1 ? 's' : ''} au-delà de la limite NON lue${csv.truncated > 1 ? 's' : ''} : découpez le fichier` : ''}.</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3 font-medium">Colonne du fichier</th><th className="py-2 pr-3 font-medium">Exemples</th><th className="py-2 font-medium">Champ du CRM</th></tr></thead>
                <tbody>
                  {csv.headers.map((h, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-medium text-slate-900">{h}</td>
                      <td className="max-w-[260px] truncate py-2 pr-3 text-slate-500">{csv.rows.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ') || '—'}</td>
                      <td className="py-2">
                        <select aria-label={`Champ pour la colonne ${h}`} value={mapping[i] ?? ''} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))} className={cn(inputCls, 'w-full max-w-[240px] py-1.5', duplicates.includes(mapping[i]) && 'border-red-400')}>
                          <option value="">Ignorer cette colonne</option>
                          {IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {duplicates.length > 0 && <p role="alert" className="mt-3 text-sm text-red-700">Un même champ est choisi pour plusieurs colonnes : {duplicates.map((k) => IMPORT_FIELDS.find((f) => f.key === k)?.label).join(', ')}.</p>}
            {!hasContact && <p role="alert" className="mt-3 text-sm text-red-700">Associez au moins une colonne « Téléphone » ou « Email » : sans moyen de contact, aucun lead ne peut être créé.</p>}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Valeurs communes à toutes les lignes</h2>
            {options.error && <p role="alert" className="mt-2 text-sm text-red-700">Lecture des sources et campagnes refusée : vérifiez vos droits.</p>}
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <label className="block text-sm"><span className="font-medium text-slate-700">Source</span>
                <select aria-label="Source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={cn(inputCls, 'mt-1 w-full')}>
                  <option value="">Aucune source déclarée</option>
                  {options.sources.map((s) => <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name}{s.enabled ? '' : ' (désactivée)'}</option>)}
                </select>
              </label>
              <label className="block text-sm"><span className="font-medium text-slate-700">Campagne par défaut</span>
                <select aria-label="Campagne par défaut" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={cn(inputCls, 'mt-1 w-full')}>
                  <option value="">Aucune (celle de la colonne, sinon file sans campagne)</option>
                  {options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'active' ? ` (${c.status})` : ''}</option>)}
                </select>
              </label>
              <label className="block text-sm"><span className="font-medium text-slate-700">Produit par défaut</span>
                <select aria-label="Produit par défaut" value={productCode} onChange={(e) => setProductCode(e.target.value)} className={cn(inputCls, 'mt-1 w-full')}>
                  <option value="">Aucun (celui de la colonne)</option>
                  {options.products.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">Une valeur de colonne l’emporte toujours sur la valeur commune.</p>
          </div>

          <div className="flex gap-3">
            <button type="button" onClick={() => { setStep('file'); setCsv(null); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Changer de fichier</button>
            <button type="button" disabled={duplicates.length > 0 || !hasContact} onClick={() => { setConfirmed(false); setStep('check'); }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Contrôler le fichier</button>
          </div>
        </section>
      )}

      {step === 'check' && csv && (
        <section className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            {[['Lignes', summary.total, 'text-slate-900'], ['Correctes', summary.ok, 'text-emerald-600'], ['Avertissements', summary.warning, 'text-amber-600'], ['En erreur', summary.error, 'text-red-600']].map(([label, n, tone]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className={cn('text-2xl font-bold tabular-nums', String(tone))}>{n}</p></div>
            ))}
          </div>
          <p className="text-sm text-slate-600">Les lignes en erreur ne seront pas envoyées. Les avertissements sont envoyés : un doublon est rattaché au lead existant, jamais recréé.</p>

          {checks.some((c) => c.status !== 'ok') && (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2 font-medium">Ligne</th><th className="px-3 py-2 font-medium">Contact</th><th className="px-3 py-2 font-medium">Problème</th></tr></thead>
                <tbody>
                  {checks.filter((c) => c.status !== 'ok').slice(0, 100).map((c) => (
                    <tr key={c.line} className="border-b border-slate-100 align-top">
                      <td className="px-3 py-2 tabular-nums text-slate-600">{c.line}</td>
                      <td className="px-3 py-2 text-slate-800">{c.name || '—'}<span className="block text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(' · ')}</span></td>
                      <td className={cn('px-3 py-2', c.status === 'error' ? 'text-red-700' : 'text-amber-700')}>{c.problems.join(' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {checks.filter((c) => c.status !== 'ok').length > 100 && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">100 premières lignes affichées sur {checks.filter((c) => c.status !== 'ok').length}.</p>}
            </div>
          )}

          {bigImport && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>Cet import crée jusqu’à <strong>{sendable.length} leads</strong>. Chacun est attribué par le moteur (plafond de 10 leads « Nouveau » par télépro, le reste entre en file tampon) et déclenche son alerte de prise en charge. Je confirme.</span>
            </label>
          )}

          <div className="flex gap-3">
            <button type="button" onClick={() => setStep('columns')} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Retour aux colonnes</button>
            <button type="button" disabled={sendable.length === 0 || (bigImport && !confirmed)} onClick={() => void run()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Upload className="h-4 w-4" /> Importer {sendable.length} ligne{sendable.length > 1 ? 's' : ''}</button>
          </div>
        </section>
      )}

      {step === 'result' && (
        <section className="mt-5 space-y-5">
          {progress && (
            <div role="status" className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm font-medium text-slate-800">Import en cours… {progress.done} / {progress.total}</p>
              <div className="mt-2 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-blue-600 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 100}%` }} /></div>
              <p className="mt-2 text-xs text-slate-500">Ne fermez pas cette page tant que l’import n’est pas terminé.</p>
            </div>
          )}
          {failure && <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {failure}</p>}
          {!progress && !failure && <p role="status" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Import terminé.</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            {[['Leads créés', created, 'text-emerald-600'], ['Rattachés à un lead existant', attached, 'text-blue-600'], ['Refusés', rejects.length, 'text-red-600']].map(([label, n, tone]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className={cn('text-2xl font-bold tabular-nums', String(tone))}>{n}</p></div>
            ))}
          </div>
          {results.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2 font-medium">Ligne</th><th className="px-3 py-2 font-medium">Résultat</th><th className="px-3 py-2 font-medium">Détail</th></tr></thead>
                <tbody>
                  {[...results].sort((a, b) => a.row - b.row).slice(0, 300).map((r) => (
                    <tr key={r.row} className="border-b border-slate-100">
                      <td className="px-3 py-2 tabular-nums text-slate-600">{r.row}</td>
                      <td className={cn('px-3 py-2 font-medium', r.ok ? (r.kind === 'created' ? 'text-emerald-700' : 'text-blue-700') : 'text-red-700')}>{r.ok ? KIND_LABEL[r.kind] : 'Refusé'}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {r.ok ? (<><Link to={`/leads/${r.leadId}`} className="text-blue-700 hover:underline">Ouvrir le lead</Link>{r.kind === 'created' && <span className="ml-2 text-xs text-slate-500">{r.assignmentState === 'assigned' ? 'attribué' : 'file tampon'}</span>}</>) : r.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {results.length > 300 && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">300 premières lignes affichées sur {results.length}.</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {rejects.length > 0 && <button type="button" onClick={downloadRejects} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> Télécharger les {rejects.length} ligne{rejects.length > 1 ? 's' : ''} refusée{rejects.length > 1 ? 's' : ''}</button>}
            {failure && !progress && <button type="button" onClick={() => void run()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Relancer l’import</button>}
            <Link to="/leads" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Voir les leads</Link>
            <button type="button" disabled={!!progress} onClick={() => { setStep('file'); setCsv(null); setResults([]); setFailure(null); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Importer un autre fichier</button>
          </div>
        </section>
      )}
    </div>
  );
}
