import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, FileText, Inbox, Phone, UserRound, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from '../../domain/labels';
import { formatPhoneDisplay, type LeadListItem, type LeadNames } from '../../domain/leads/leadList';
import { buildTimeline } from '../../domain/leads/leadFile';
import { sinceLabel, targetChoices, type LeadIssue, type TeamRow, type Tone } from '../../domain/cockpit/cockpit';
import { sendReassign } from '../../lib/reassignApi';
import { useLeadFile } from '../leads/useLeadsData';
import { useSettings } from '../settings/useSettings';

export const TONE_PILL: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  grey: 'bg-slate-100 text-slate-600',
};

export const SEVERITY_STYLE = {
  critical: { dot: 'bg-red-500', label: 'Critique', text: 'text-red-700' },
  high: { dot: 'bg-orange-500', label: 'Élevé', text: 'text-orange-700' },
  watch: { dot: 'bg-amber-400', label: 'Surveillance', text: 'text-amber-700' },
  info: { dot: 'bg-blue-500', label: 'Information', text: 'text-blue-700' },
} as const;

/** Panneau de liste : la liste EXACTE des leads qui composent un chiffre du cockpit (§12.6). */
export function ListPanel({ title, issues, nowMs, names, onPick, onClose }: { title: string; issues: LeadIssue[]; nowMs: number; names: LeadNames; onPick: (leadId: string) => void; onClose: () => void }) {
  return (
    <Drawer title={`${title} (${issues.length})`} onClose={onClose}>
      {issues.length === 0 && <p className="text-sm text-slate-500">Aucun lead pour le moment.</p>}
      <ul className="space-y-2">
        {issues.map((i) => {
          const sev = SEVERITY_STYLE[i.severity];
          return (
            <li key={i.lead.id}>
              <button type="button" onClick={() => onPick(i.lead.id)} className="flex w-full items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-left hover:bg-slate-50">
                <span className={cn('mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full', sev.dot)} role="img" aria-label={sev.label} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{i.lead.fullName || 'Contact sans nom'}</span>
                  <span className="block truncate text-xs text-slate-500">{i.lead.productCode ?? 'Produit non renseigné'} · {i.lead.ownerId ? (names.users.get(i.lead.ownerId) ?? 'Télépro') : 'Non attribué'}</span>
                  <span className={cn('block text-xs font-medium', sev.text)}>{i.reason}</span>
                </span>
                <span className="flex-shrink-0 text-[11px] text-slate-400">depuis {sinceLabel(i.sinceMs, nowMs)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Panneau d'action d'une alerte (§12.8) : contexte complet du lead, motif de l'alerte, et actions sans quitter le
 * cockpit : ouvrir la fiche, réattribuer (télépros avec statut et charge, meilleur choix recommandé, motif obligatoire).
 */
export function LeadPanel({
  lead,
  issue,
  team,
  nowMs,
  names,
  canReassign,
  basePath,
  onClose,
  onDone,
}: {
  lead: LeadListItem;
  issue: LeadIssue | null;
  team: TeamRow[];
  nowMs: number;
  names: LeadNames;
  canReassign: boolean;
  basePath: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const file = useLeadFile(lead.id);
  const choices = targetChoices(team, lead.ownerId);
  const [target, setTarget] = useState<string>(() => choices.find((c) => c.recommended)?.uid ?? '');
  const { reasonCatalog } = useSettings();
  const reasons = reasonCatalog.active.reassign;
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeline = buildTimeline(file.events, names.users).slice(0, 5);
  const owner = lead.ownerId ? (names.users.get(lead.ownerId) ?? lead.ownerId) : null;
  const campaign = lead.campaignId ? (names.campaigns.get(lead.campaignId) ?? lead.campaignId) : 'Sans campagne';
  const chosen = choices.find((c) => c.uid === target);
  const isBuffer = lead.ownerId === null;

  const submit = async () => {
    setError(null);
    if (!target) return setError('Choisissez un télépro.');
    if (!reasons[reasonCode]) return setError('Le motif est obligatoire.');
    const complement = reason.trim();
    if (reasonCatalog.commentRequired.reassign.includes(reasonCode) && complement.length < 3) return setError(`Motif « ${reasons[reasonCode]} » : précisez-le en commentaire.`);
    setBusy(true);
    const r = await sendReassign({ leadId: lead.id, targetUid: target, reason: complement ? `${reasons[reasonCode]} — ${complement}` : reasons[reasonCode] });
    setBusy(false);
    if (r.ok) onDone(r.message);
    else setError(r.message);
  };

  return (
    <Drawer title={lead.fullName || 'Contact sans nom'} onClose={onClose}>
      <div className="space-y-5">
        {issue && (
          <p className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm', issue.severity === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900')}>
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span><span className="font-semibold">{issue.reason}</span> — depuis {sinceLabel(issue.sinceMs, nowMs)}.</span>
          </p>
        )}

        <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-slate-500">Téléphone</dt>
          <dd className="flex items-center gap-1.5 text-slate-900"><Phone className="h-3.5 w-3.5 text-slate-400" />{formatPhoneDisplay(lead.phone)}</dd>
          <dt className="text-slate-500">Produit</dt>
          <dd className="text-slate-900">{lead.productCode ?? '—'}</dd>
          <dt className="text-slate-500">Campagne</dt>
          <dd className="text-slate-900">{campaign}</dd>
          <dt className="text-slate-500">Propriétaire</dt>
          <dd className="flex items-center gap-1.5 text-slate-900"><UserRound className="h-3.5 w-3.5 text-slate-400" />{owner ?? <span className="font-medium text-red-700">Non attribué (file tampon)</span>}</dd>
          <dt className="text-slate-500">Statut</dt>
          <dd className="text-slate-900">{LEAD_STATUS_LABELS[lead.status]}</dd>
          {lead.temperature && (<><dt className="text-slate-500">Température</dt><dd className="text-slate-900">{TEMPERATURE_LABELS[lead.temperature]}</dd></>)}
          <dt className="text-slate-500">Reçu il y a</dt>
          <dd className="text-slate-900">{sinceLabel(lead.receivedAtMs, nowMs)}</dd>
          {lead.nextAction && (<><dt className="text-slate-500">Prochaine action</dt><dd className="text-slate-900">{lead.nextAction.reason}</dd></>)}
        </dl>

        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Clock className="h-4 w-4 text-blue-600" /> Chronologie</h3>
          {timeline.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">{file.loading ? 'Chargement…' : 'Aucun événement enregistré.'}</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {timeline.map((e) => (
                <li key={e.id} className="flex justify-between gap-3">
                  <span className="truncate text-slate-700">{e.title}{e.detail ? ` — ${e.detail}` : ''}</span>
                  <time className="flex-shrink-0 text-xs text-slate-400">{new Date(e.atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link to={`${basePath}/${lead.id}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><ExternalLink className="h-4 w-4" /> Ouvrir la fiche</Link>
          {lead.docs && <Link to={`${basePath}/${lead.id}?onglet=documents`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><FileText className="h-4 w-4" /> Documents</Link>}
        </div>

        {canReassign ? (
          <section className="rounded-xl border border-slate-200 p-4" aria-label="Réattribution">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Inbox className="h-4 w-4 text-blue-600" /> {isBuffer ? 'Attribuer ce lead' : 'Réattribuer ce lead'}</h3>
            {choices.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Aucun autre télépro dans votre périmètre.</p>
            ) : (
              <ul className="mt-3 max-h-60 space-y-1.5 overflow-y-auto">
                {choices.map((c) => (
                  <li key={c.uid}>
                    <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm', target === c.uid ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                      <input type="radio" name="target" checked={target === c.uid} onChange={() => setTarget(c.uid)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">{c.name}{c.recommended && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">Recommandé</span>}</span>
                        <span className="block text-xs text-slate-500">{c.newLeads}/{c.cap} nouveaux leads{c.full ? ' — plafond atteint' : ''}</span>
                      </span>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE_PILL[c.state.tone])}>{c.state.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {chosen?.full && <p className="mt-2 text-xs text-amber-800">{chosen.name} a atteint son plafond de nouveaux leads : la décision vous revient.</p>}
            <label className="mt-3 block">
              <span className="text-sm font-medium text-slate-700">Motif (obligatoire)</span>
              <select aria-label="Motif" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
                <option value="">Choisir un motif</option>
                {Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input aria-label="Commentaire" value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder={reasonCatalog.commentRequired.reassign.includes(reasonCode) ? 'Précisez (obligatoire)' : 'Commentaire (facultatif)'} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </label>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            <button type="button" disabled={busy || choices.length === 0} onClick={submit} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              <CheckCircle2 className="h-4 w-4" /> {busy ? 'Enregistrement…' : isBuffer ? 'Attribuer' : 'Réattribuer'}
            </button>
          </section>
        ) : (
          <p className="text-xs text-slate-500">La réattribution est réservée aux managers du lead et aux administrateurs.</p>
        )}
      </div>
    </Drawer>
  );
}
