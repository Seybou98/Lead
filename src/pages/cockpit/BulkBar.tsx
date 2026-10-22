import { useState } from 'react';
import { Download, Inbox, Clock } from 'lucide-react';
import { downloadText, toCsv } from '../../domain/csv';
import { POSTPONABLE, POSTPONE_CHOICES, type PostponeKey } from '../../domain/cockpit/alertStates';
import { targetChoices, type LeadIssue, type TeamRow } from '../../domain/cockpit/cockpit';
import { LEAD_STATUS_LABELS } from '../../domain/labels';
import type { LeadNames } from '../../domain/leads/leadList';
import { sendAlertAction } from '../../lib/cockpitAlertApi';
import { sendReassign } from '../../lib/reassignApi';
import { useSettings } from '../settings/useSettings';

const sel = 'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

/**
 * Actions de masse du cockpit (§12.9) sur les leads cochés d'une liste : affecter, reporter, exporter. Chaque lead est traité
 * seul, avec sa propre trace ; le compte rendu dit ce qui est passé et ce qui a été refusé. Une confirmation est demandée.
 */
export function BulkBar({ issues, team, names, canAct, onDone }: { issues: LeadIssue[]; team: TeamRow[]; names: LeadNames; canAct: boolean; onDone: (message: string) => void }) {
  const { reasonCatalog } = useSettings();
  const reasons = reasonCatalog.active.reassign;
  const choices = targetChoices(team, null);
  const [target, setTarget] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [choice, setChoice] = useState<PostponeKey>('2h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = issues.length;
  const postponable = issues.filter((i) => i.key && POSTPONABLE[i.key]);

  const run = async (label: string, jobs: { name: string; go: () => Promise<{ ok: boolean; message: string }> }[]) => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let done = 0;
    for (const j of jobs) {
      const r = await j.go();
      if (r.ok) done += 1;
      else failures.push(`${j.name} : ${r.message}`);
    }
    setBusy(false);
    if (failures.length > 0) setError(`${label} : ${done} sur ${jobs.length} effectué${done > 1 ? 's' : ''}. Refusés : ${failures.slice(0, 3).join(' · ')}${failures.length > 3 ? ' …' : ''}`);
    if (done > 0) onDone(`${label} : ${done} lead${done > 1 ? 's' : ''} traité${done > 1 ? 's' : ''}${failures.length ? `, ${failures.length} refusé${failures.length > 1 ? 's' : ''}` : ''}.`);
  };

  const assign = () => {
    if (!target) return setError('Choisissez un télépro.');
    if (!reasons[reasonCode]) return setError('Le motif est obligatoire.');
    const who = choices.find((c) => c.uid === target)?.name ?? target;
    if (!window.confirm(`Attribuer ${n} lead${n > 1 ? 's' : ''} à ${who} ? Chaque changement est tracé.`)) return;
    void run('Attribution', issues.map((i) => ({ name: i.lead.fullName || i.lead.id, go: () => sendReassign({ leadId: i.lead.id, targetUid: target, reason: reasons[reasonCode] }) })));
  };
  const postpone = () => {
    if (postponable.length === 0) return setError('Aucune des alertes cochées ne peut être reportée.');
    const label = POSTPONE_CHOICES.find((c) => c.key === choice)?.label ?? '';
    if (!window.confirm(`Reporter ${postponable.length} alerte${postponable.length > 1 ? 's' : ''} de ${label} ?`)) return;
    void run('Report', postponable.map((i) => ({ name: i.lead.fullName || i.lead.id, go: () => sendAlertAction({ leadId: i.lead.id, alertKey: i.key!, sinceMs: i.sinceMs, action: 'postpone', choice }) })));
  };
  const exportCsv = () => {
    const rows = issues.map((i) => [i.lead.id, LEAD_STATUS_LABELS[i.lead.status], i.lead.productCode ?? '', i.lead.ownerId ? (names.users.get(i.lead.ownerId) ?? i.lead.ownerId) : 'Non attribué', i.reason, new Date(i.sinceMs).toLocaleString('fr-FR')]);
    downloadText(`cockpit-selection-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(['Sélection du cockpit (sans coordonnées)'], [['Identifiant', 'Statut', 'Produit', 'Télépro', 'Motif de l’alerte', 'Depuis'], ...rows]));
  };

  return (
    <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-5 py-3 text-sm" aria-label="Actions de masse">
      <p className="font-medium text-slate-800">{n} lead{n > 1 ? 's' : ''} sélectionné{n > 1 ? 's' : ''}</p>
      {canAct && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Inbox className="h-4 w-4 text-blue-600" />
            <select aria-label="Télépro cible" value={target} onChange={(e) => setTarget(e.target.value)} className={sel}><option value="">Attribuer à…</option>{choices.map((c) => <option key={c.uid} value={c.uid}>{c.name}{c.recommended ? ' (recommandé)' : ''}{c.full ? ' — plafond' : ''}</option>)}</select>
            <select aria-label="Motif d’attribution" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={sel}><option value="">Motif</option>{Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button type="button" disabled={busy} onClick={assign} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Attribuer</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Clock className="h-4 w-4 text-blue-600" />
            <select aria-label="Durée du report" value={choice} onChange={(e) => setChoice(e.target.value as PostponeKey)} className={sel}>{POSTPONE_CHOICES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            <button type="button" disabled={busy} onClick={postpone} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Reporter ({postponable.length})</button>
          </div>
        </>
      )}
      <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> Exporter la sélection</button>
      {busy && <p className="text-xs text-slate-500">Traitement en cours…</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
