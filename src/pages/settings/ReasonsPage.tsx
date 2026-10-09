import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { COMMENT_ALWAYS_REQUIRED, FIXED_LISTS, MAX_ITEMS, newReasonCode, REASON_LISTS, REASON_LIST_LABELS, validateReasonSettings, type ReasonList, type ReasonSettings } from '../../domain/settings/reasons';
import { errorMessage, saveReasons } from '../../lib/adminApi';
import { useSettings } from './useSettings';
import { Feedback, inputCls, SaveBar, SettingsCard } from './settingsUi';

const clone = (s: ReasonSettings): ReasonSettings => JSON.parse(JSON.stringify(s));

/**
 * Motifs et listes administrables (§21.6). Chaque valeur a un libellé, un ordre, un code statistique stable et une
 * exigence de commentaire. Une valeur ne se supprime jamais : on l'archive, elle disparaît de la saisie mais reste
 * lisible dans les historiques et les rapports.
 */
export function ReasonsPage() {
  const settings = useSettings();
  const [draft, setDraft] = useState<ReasonSettings>(settings.reasons);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});

  const loadedKey = `${settings.loading}:${JSON.stringify(settings.reasons)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(clone(settings.reasons));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const change = (fn: (d: ReasonSettings) => void) => {
    setDraft((cur) => {
      const next = clone(cur);
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };
  const errors = validateReasonSettings(draft);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveReasons({ lists: Object.fromEntries(REASON_LISTS.map((l) => [l, draft[l].map(({ code, label, active, requireComment }) => ({ code, label, active, requireComment }))])) });
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Listes enregistrées. Elles s’appliquent aux prochaines qualifications ; les qualifications passées gardent leur motif tel qu’il était écrit.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const add = (l: ReasonList) => {
    const label = (adding[l] ?? '').trim().replace(/\s+/g, ' ');
    if (!label) return;
    change((d) => {
      const taken = new Set(d[l].map((i) => i.code));
      d[l].push({ code: newReasonCode(label, taken), label, active: true, builtin: false, requireComment: false });
    });
    setAdding((a) => ({ ...a, [l]: '' }));
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Motifs et listes</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Motifs et listes</h1>
      <p className="mt-1 text-slate-500">Les valeurs proposées aux conseillers à la fin d&apos;un appel et au contrôle des pièces. Une valeur utilisée ne se supprime pas : archivez-la, elle reste lisible dans les historiques et les rapports.</p>

      {!settings.saved.reasons && !settings.loading && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Aucune liste n&apos;a encore été enregistrée : ce sont les valeurs du cahier des charges qui s&apos;appliquent.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <div className="mt-5 grid gap-5 2xl:grid-cols-2">
        {REASON_LISTS.map((l) => {
          const items = draft[l];
          const always = COMMENT_ALWAYS_REQUIRED.includes(l);
          return (
            <SettingsCard key={l} title={REASON_LIST_LABELS[l].title}>
              <p className="-mt-1 mb-3 text-xs text-slate-500">{REASON_LIST_LABELS[l].hint}{always && l !== 'temperature' ? ' Le commentaire est toujours demandé pour cette liste.' : ''}</p>
              <ul className="space-y-1.5">
                {items.map((it, i) => (
                  <li key={it.code} className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 ${it.active ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50'}`}>
                    <div className="flex flex-col">
                      <button type="button" aria-label="Monter" disabled={i === 0} onClick={() => change((d) => { [d[l][i - 1], d[l][i]] = [d[l][i], d[l][i - 1]]; })} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label="Descendre" disabled={i === items.length - 1} onClick={() => change((d) => { [d[l][i + 1], d[l][i]] = [d[l][i], d[l][i + 1]]; })} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                    </div>
                    <input aria-label={`Libellé de ${it.code}`} value={it.label} maxLength={60} onChange={(e) => change((d) => { d[l][i].label = e.target.value; })} className={`${inputCls} min-w-[140px] flex-1 py-1 ${it.active ? '' : 'text-slate-500 line-through'}`} />
                    {!always && (
                      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
                        <input type="checkbox" checked={it.requireComment} onChange={(e) => change((d) => { d[l][i].requireComment = e.target.checked; })} />
                        Commentaire obligatoire
                      </label>
                    )}
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500" title="Code statistique stable">{it.code}</span>
                    <button type="button" onClick={() => change((d) => { d[l][i].active = !d[l][i].active; })} className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-slate-600 hover:text-slate-900">
                      {it.active ? <><Archive className="h-3.5 w-3.5" /> Archiver</> : <><ArchiveRestore className="h-3.5 w-3.5" /> Réactiver</>}
                    </button>
                  </li>
                ))}
              </ul>
              {items.length < MAX_ITEMS && !FIXED_LISTS.includes(l) && (
                <div className="mt-3 flex gap-2">
                  <input aria-label={`Nouvelle valeur — ${REASON_LIST_LABELS[l].title}`} value={adding[l] ?? ''} maxLength={60} placeholder="Nouvelle valeur" onChange={(e) => setAdding((a) => ({ ...a, [l]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(l); } }} className={`${inputCls} flex-1 py-1.5`} />
                  <button type="button" onClick={() => add(l)} disabled={!(adding[l] ?? '').trim()} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter</button>
                </div>
              )}
            </SettingsCard>
          );
        })}
      </div>

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar onCancel={() => { setDraft(clone(settings.reasons)); setDirty(false); setNotice(null); }} onSave={save} busy={busy} blocked={errors.length > 0} dirty={dirty} />
    </div>
  );
}
