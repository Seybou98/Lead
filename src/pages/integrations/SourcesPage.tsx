import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Copy, KeyRound } from 'lucide-react';
import { collection, onSnapshot } from 'firebase/firestore';
import { cn } from '../../lib/utils';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { errorMessage, saveSource } from '../../lib/adminApi';
import { statsOf } from '../../domain/integrations/hub';
import { Switch } from '../settings/settingsUi';
import { IntegrationsHeader } from './IntegrationsNav';
import { fmtShort, useJournal } from './useJournal';

interface SourceRow {
  id: string;
  name: string;
  kind: 'meta' | 'google' | 'site' | 'agency' | 'import' | 'manual';
  enabled: boolean;
  mapping: Record<string, string>;
}

const KIND_LABELS: Record<SourceRow['kind'], string> = { meta: 'Meta', google: 'Google', site: 'Formulaire du site', agency: 'Agence / fournisseur', import: 'Import', manual: 'Manuel' };

/**
 * Sources de leads (§24.1, fig. 43 pour la partie « réception ») : adresses de réception, activation, correspondance de
 * champs et dernières réceptions. Suspendre une source refuse ses nouveaux leads (ils sont conservés en donnée brute,
 * rejouables depuis « Erreurs & reprises »). Aucun secret n'est affiché : il vit dans les variables du site.
 */
export function SourcesPage() {
  const journal = useJournal();
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(
    () =>
      onSnapshot(
        collection(db, COL.sources),
        (s) => setSources(s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), kind: (d.get('kind') ?? 'site') as SourceRow['kind'], enabled: d.get('enabled') !== false, mapping: (d.get('fieldMapping') ?? {}) as Record<string, string> })).sort((a, b) => a.name.localeCompare(b.name, 'fr'))),
        () => {
          setSources([]);
          setError('Lecture des sources refusée : vérifiez vos droits.');
        }
      ),
    []
  );

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const endpoints = [
    { label: 'Réception unique (JSON ou formulaire)', url: `${origin}/api/leads` },
    { label: 'Adresse Pabbly (identique)', url: `${origin}/api/pabbly/leads` },
  ];
  const bySource = useMemo(() => {
    const m = new Map<string, ReturnType<typeof statsOf> & { lastAtMs: number | null }>();
    for (const s of sources ?? []) {
      const mine = journal.entries.filter((e) => e.sourceKey === s.id);
      m.set(s.id, { ...statsOf(mine), lastAtMs: mine.reduce<number | null>((x, e) => (x === null || e.atMs > x ? e.atMs : x), null) });
    }
    return m;
  }, [sources, journal.entries]);

  const toggle = async (s: SourceRow, enabled: boolean) => {
    setBusy(s.id);
    setError(null);
    try {
      await saveSource({ id: s.id, name: s.name, kind: s.kind, enabled, reason: enabled ? 'Réactivation depuis le hub d’intégrations' : 'Suspension depuis le hub d’intégrations' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="w-full">
      <IntegrationsHeader title="Sources de leads" subtitle="Adresses de réception, activation et correspondance des champs des sources qui envoient des leads." />
      {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}</p>}

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Adresses de réception</h2>
        <ul className="mt-3 space-y-2">
          {endpoints.map((e) => (
            <li key={e.url} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-64 text-slate-600">{e.label}</span>
              <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">POST {e.url}</code>
              <button type="button" onClick={() => void copy(e.url)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"><Copy className="h-3.5 w-3.5" /> {copied === e.url ? 'Copiée' : 'Copier'}</button>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600"><KeyRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> L’envoi exige le secret partagé (en-tête ou paramètre, selon l’outil). Il est défini dans les variables d’environnement du site (CL_INGEST_SECRET) et n’est jamais affiché ici. Les leads saisis ou importés à la main passent par <Link to="/leads/nouveau" className="text-blue-700 hover:underline">Nouveau lead</Link> et <Link to="/leads/import" className="text-blue-700 hover:underline">Importer un CSV</Link>.</p>
      </section>

      <section className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-4 py-2.5 font-medium">Source</th><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 font-medium">Dernière réception</th><th className="px-4 py-2.5 text-right font-medium">Reçus / en erreur</th><th className="px-4 py-2.5 font-medium">Champs reconnus</th><th className="px-4 py-2.5 text-right font-medium">Active</th></tr></thead>
          <tbody>
            {sources === null && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Chargement…</td></tr>}
            {sources?.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Aucune source. Créez-en une depuis une campagne (Campagnes → Nouvelle campagne).</td></tr>}
            {sources?.map((s) => {
              const st = bySource.get(s.id);
              const keys = Object.keys(s.mapping);
              return (
                <tr key={s.id} className={cn('border-b border-slate-100', !s.enabled && 'bg-slate-50 text-slate-500')}>
                  <td className="px-4 py-3 font-medium text-slate-900">{s.name}<span className="block font-mono text-[11px] font-normal text-slate-400">{s.id}</span></td>
                  <td className="px-4 py-3 text-slate-600">{KIND_LABELS[s.kind] ?? s.kind}</td>
                  <td className="px-4 py-3 text-slate-600">{st?.lastAtMs ? fmtShort(st.lastAtMs) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{st?.total ?? 0}{(st?.error ?? 0) > 0 && <Link to="/integrations/erreurs" className="ml-1 text-red-600 hover:underline">/ {st?.error}</Link>}</td>
                  <td className="px-4 py-3 text-xs text-slate-500" title={keys.map((k) => `${k} → ${s.mapping[k]}`).join('\n')}>{keys.length === 0 ? 'Synonymes standard' : `${keys.length} correspondance${keys.length > 1 ? 's' : ''} propre${keys.length > 1 ? 's' : ''}`}</td>
                  <td className="px-4 py-3 text-right"><Switch label={`Source ${s.name} active`} checked={s.enabled} disabled={busy === s.id} onChange={(v) => void toggle(s, v)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><CheckCircle2 className="h-3.5 w-3.5" /> Une source suspendue refuse ses nouveaux leads : ils sont conservés (donnée brute) et rejouables après réactivation, depuis « Erreurs & reprises ».</p>
    </div>
  );
}
