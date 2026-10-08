import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import { DISTRIBUTION_LABELS } from '../../domain/labels';
import { buildCockpit, type TeamRow } from '../../domain/cockpit/cockpit';
import { normalizeText } from '../../domain/engine/normalize';
import { errorMessage, saveProfile } from '../../lib/adminApi';
import { useCockpitData, type CockpitData } from './useCockpitData';
import { TONE_PILL } from './CockpitPanel';

export function TeamPage() {
  const { user } = useAuth();
  const role: Role = user?.role ?? 'manager';
  return <TeamView data={useCockpitData(role, user?.uid ?? '')} role={role} />;
}

type Filter = 'all' | 'alerts' | 'connected';

/**
 * Équipe (§12.7) : statut et charge de chaque télépro en temps réel. Un manager voit son périmètre ; seul
 * l'administrateur peut suspendre ou réactiver la distribution (droit d'écriture sur les profils).
 */
export function TeamView({ data, role }: { data: CockpitData; role: Role }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const team = useMemo(() => buildCockpit({ items: data.items, rows: data.rows, nowMs: data.nowMs, period: 'today' }).team, [data.items, data.rows, data.nowMs]);
  const q = normalizeText(search);
  const shown = team.filter((t) => (!q || normalizeText(t.name).includes(q)) && (filter === 'all' || (filter === 'alerts' ? t.alert !== null : t.state.label !== 'Déconnecté')));

  const toggle = async (t: TeamRow) => {
    const suspend = t.distribution !== 'suspended';
    setBusy(t.uid);
    setNotice(null);
    try {
      await saveProfile({ uid: t.uid, distributionSuspended: suspend, reason: suspend ? "Suspension depuis l'écran Équipe" : "Réactivation depuis l'écran Équipe" });
      setNotice({ kind: 'ok', text: `Distribution ${suspend ? 'suspendue' : 'réactivée'} pour ${t.name}.` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const chip = (key: Filter, label: string, n: number) => (
    <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key} className={cn('rounded-full border px-4 py-1.5 text-sm font-medium', filter === key ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}>
      {label} <span className={cn('ml-1 tabular-nums', filter === key ? 'text-blue-100' : 'text-slate-400')}>{n}</span>
    </button>
  );

  const headers = ['Télépro', 'État', 'Action actuelle', 'Nouveaux leads', 'Rappels', 'Intéressés', 'Documents', 'Distribution', 'Alerte', ...(role === 'admin' ? ['Actions'] : [])];

  return (
    <div className="w-full">
      <h1 className="text-2xl font-bold text-slate-900">Équipe</h1>
      <p className="mt-1 text-slate-500">Statut et charge de chaque télépro en temps réel.</p>

      {data.error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {data.error}</p>}
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {notice.text}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {chip('all', 'Tous', team.length)}
        {chip('connected', 'Connectés', team.filter((t) => t.state.label !== 'Déconnecté').length)}
        {chip('alerts', 'Avec alerte', team.filter((t) => t.alert).length)}
        <div className="relative ml-auto min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="search" aria-label="Rechercher un télépro" placeholder="Rechercher un télépro" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {headers.map((h) => (
                <th key={h} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.length === 0 && (
              <tr><td colSpan={headers.length} className="px-4 py-10 text-center text-slate-500">{data.loading ? 'Chargement…' : team.length === 0 ? 'Aucun télépro dans votre périmètre.' : 'Aucun résultat pour ces filtres.'}</td></tr>
            )}
            {shown.map((t) => {
              const pct = t.cap > 0 ? Math.min(100, Math.round((t.newLeads / t.cap) * 100)) : 0;
              return (
                <tr key={t.uid} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-900"><Link to={`/utilisateurs/${t.uid}`} className="hover:text-blue-700 hover:underline">{t.name}</Link></td>
                  <td className="px-3 py-3"><span className={cn('whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', TONE_PILL[t.state.tone])}>● {t.state.label}</span></td>
                  <td className="max-w-[240px] truncate px-3 py-3 text-slate-700" title={t.current ?? undefined}>{t.current ?? '—'}</td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-16 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Charge de ${t.name}`}>
                        <span className={cn('block h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                      </span>
                      <span className="text-xs tabular-nums text-slate-600">{t.newLeads}/{t.cap}</span>
                    </span>
                  </td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{t.workload.callbacks}</td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{t.workload.interested}</td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{t.workload.documents}</td>
                  <td className={cn('whitespace-nowrap px-3 py-3 text-xs font-medium', t.distribution === 'suspended' || t.distribution === 'full' ? 'text-red-600' : t.distribution === 'paused' ? 'text-amber-600' : 'text-emerald-700')}>{DISTRIBUTION_LABELS[t.distribution]}</td>
                  <td className="px-3 py-3">{t.alert ? <span className={cn('whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', TONE_PILL[t.alert.tone])}>● {t.alert.label}</span> : <span className="text-slate-300">—</span>}</td>
                  {role === 'admin' && (
                    <td className="whitespace-nowrap px-3 py-3">
                      <button type="button" disabled={busy === t.uid} onClick={() => toggle(t)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                        {t.distribution === 'suspended' ? 'Réactiver' : 'Suspendre'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">« Rappels », « Intéressés » et « Documents » comptent les leads que le télépro a déjà en main. Un navigateur simplement ouvert ne vaut pas activité commerciale.</p>
    </div>
  );
}
