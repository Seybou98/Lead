import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, BarChart3, Bell, Check, Clock, FileText, Flame, House, MapPin, MessageSquare, Phone, Send, StickyNote, UserCheck, UserRound, Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { ASSIGNMENT_STATE_LABELS, DOCUMENT_STATE_LABELS, LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from '../../domain/labels';
import { formatAgo, formatCounter, formatPhoneDisplay, slaAgeMs, slaLevel, DEFAULT_SLA_MS } from '../../domain/leads/leadList';
import {
  buildEssentials,
  buildNextAction,
  buildProgress,
  buildTimeline,
  type TimelineItem,
  type TimelineKind,
} from '../../domain/leads/leadFile';
import { useLeadFile, useNow, type LeadFileState } from './useLeadsData';
import { saveSession } from '../myday/callSession';
import { newRequestId } from '../../lib/qualifyApi';

type Tab = 'summary' | 'exchanges' | 'documents' | 'sale';
const TABS: { key: Tab; label: string }[] = [
  { key: 'summary', label: 'Résumé' },
  { key: 'exchanges', label: 'Échanges' },
  { key: 'documents', label: 'Documents' },
  { key: 'sale', label: 'Vente' },
];

const KIND_ICON: Record<TimelineKind, React.ComponentType<{ className?: string }>> = {
  created: Bell,
  assigned: UserCheck,
  status: Workflow,
  call: Phone,
  note: StickyNote,
  document: FileText,
  alert: AlertTriangle,
  other: Clock,
};

const HISTORY_TONE: Record<TimelineKind, string> = {
  created: 'text-blue-600',
  assigned: 'text-blue-600',
  status: 'text-blue-600',
  call: 'text-emerald-600',
  note: 'text-slate-500',
  document: 'text-emerald-600',
  alert: 'text-amber-600',
  other: 'text-slate-500',
};

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
const when = (ms: number) => new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** « Aujourd'hui 14:27 », « Hier 09:03 » ou « 12/05 09:03 » : lisible sans calculer. */
function dayTime(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const startOf = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((startOf(now) - startOf(ms)) / 86_400_000);
  if (days === 0) return `Aujourd'hui ${hm}`;
  if (days === 1) return `Hier ${hm}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

function dueLine(dueAtMs: number, overdue: boolean, now: number): string {
  const t = dayTime(dueAtMs, now);
  if (overdue) return `En retard — prévue ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  const d = new Date(dueAtMs);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(dueAtMs).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `À faire aujourd'hui avant ${hm}`;
  if (days === 1) return `À faire demain avant ${hm}`;
  return `À faire avant le ${when(dueAtMs)}`;
}

function Card({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-6', className)}>
      <h2 className="flex items-center gap-2.5 text-[15px] font-semibold text-slate-900">
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Chronologie complète (onglet Échanges) : titre, détail et date. */
function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">Aucun événement enregistré.</p>;
  return (
    <ol className="space-y-3">
      {items.map((e) => {
        const Icon = KIND_ICON[e.kind];
        return (
          <li key={e.id} className="flex gap-3">
            <span className={cn('mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full', e.kind === 'alert' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600')}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-slate-800">{e.title}</p>
                <time className="whitespace-nowrap text-xs text-slate-400" dateTime={new Date(e.atMs).toISOString()}>{when(e.atMs)}</time>
              </div>
              {e.detail && <p className="text-sm text-slate-600">{e.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Fig. 45 : une ligne par événement (pictogramme, heure, libellé court). Le détail est dans « Échanges ». */
function RecentHistory({ items, now }: { items: TimelineItem[]; now: number }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">Aucun événement enregistré.</p>;
  return (
    <ul className="space-y-3.5">
      {items.map((e) => {
        const Icon = e.kind === 'assigned' ? Send : KIND_ICON[e.kind];
        return (
          <li key={e.id} className="grid grid-cols-[20px_132px_minmax(0,1fr)] items-center gap-3 text-sm" title={e.detail ?? undefined}>
            <Icon className={cn('h-4 w-4', HISTORY_TONE[e.kind])} />
            <time className="whitespace-nowrap text-slate-500" dateTime={new Date(e.atMs).toISOString()}>{dayTime(e.atMs, now)}</time>
            <span className="truncate text-slate-900">{e.kind === 'document' && e.detail ? e.detail : e.title}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function LeadFilePage({ listPath }: { listPath: string }) {
  const { leadId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const state = useLeadFile(leadId);
  // Appeler = déclarer le début de l'appel (téléphonie native hors périmètre V1, cahier §1.2) puis reprendre
  // l'écran « Appel en cours » de Ma journée, où le résultat sera déclaré. Réservé au propriétaire du lead.
  const lead = state.lead;
  const canCall = !!user && !!lead && !!lead.phone && (lead.ownerId === user.uid || user.role === 'admin') && !!lead.ownerId;
  const onCall = canCall && user && lead
    ? () => {
        saveSession(user.uid, { leadId: lead.id, startedAtMs: Date.now(), phase: 'calling', endedAtMs: null, requestId: newRequestId() });
        navigate('/ma-journee');
      }
    : undefined;
  return <LeadFileView state={state} listPath={listPath} canSeePriority={user?.role !== 'telepro'} onCall={onCall} />;
}

export function LeadFileView({ state, listPath, canSeePriority, nowOverride, onCall }: { state: LeadFileState; listPath: string; canSeePriority: boolean; nowOverride?: number; onCall?: () => void }) {
  const liveNow = useNow(1000);
  const now = nowOverride ?? liveNow;
  const [tab, setTab] = useState<Tab>('summary');

  const { lead, file, events, names } = state;
  const timeline = useMemo(() => buildTimeline(events, names.users), [events, names.users]);

  const back = (
    <Link to={listPath} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" /> Retour à la liste
    </Link>
  );

  if (state.loading) return <div className="w-full">{back}<p className="mt-6 text-slate-500">Chargement…</p></div>;
  if (state.error || !lead || !file) {
    return (
      <div className="w-full">
        {back}
        <div role="alert" className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-slate-900">
            {state.error === 'unavailable' ? 'Lead momentanément indisponible' : 'Lead introuvable'}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {state.error === 'unavailable'
              ? 'La lecture a échoué. Réessayez dans quelques instants.'
              : "Ce lead n'existe pas ou n'est pas dans votre périmètre."}
          </p>
        </div>
      </div>
    );
  }

  const ownerName = lead.ownerId ? (names.users.get(lead.ownerId) ?? lead.ownerId) : null;
  const campaignName = lead.campaignId ? (names.campaigns.get(lead.campaignId) ?? lead.campaignId) : null;
  const next = buildNextAction(file, now, canSeePriority);
  const essentials = buildEssentials(file, ownerName);
  const progress = buildProgress(file);
  const age = slaAgeMs(lead, now);
  const level = age === null ? null : slaLevel(age);

  // Fig. 45 : la carte « Prochaine action » est chaude (orangée) ; elle ne devient rouge qu'en cas de retard réel (§25.1).
  const overdue = next.tone === 'danger';
  const nextCard = overdue ? 'border-red-200 bg-red-50/70' : next.tone === 'warning' ? 'border-amber-200 bg-amber-50/70' : 'border-orange-100 bg-orange-50/60';
  const nextAccent = overdue ? 'text-red-700' : 'text-orange-700';
  const nextIcon = overdue ? 'bg-red-600' : 'bg-orange-500';
  const isDocAction = file.nextAction ? /document/.test(file.nextAction.type) : false;
  const canAct = file.nextAction !== null;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex items-start gap-5">
          <span className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xl font-semibold text-blue-700">{initials(lead.fullName)}</span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{lead.fullName || 'Sans nom'}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-700">
              <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-slate-500" />{formatPhoneDisplay(lead.phone)}</span>
              {(lead.city || lead.postalCode) && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-slate-500" />{lead.city}{lead.postalCode ? ` (${lead.postalCode.slice(0, 2)})` : ''}</span>}
              {lead.productCode && <span className="inline-flex items-center gap-1.5"><House className="h-3.5 w-3.5 text-slate-500" />{lead.productCode}</span>}
            </p>
            <p className="mt-1 text-sm text-slate-500">{campaignName ? `Campagne ${campaignName}` : 'Sans campagne'} · reçu {formatAgo(lead.receivedAtMs, now)}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {lead.temperature && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700">
              {lead.temperature === 'hot' && <Flame className="h-3.5 w-3.5" />}
              {TEMPERATURE_LABELS[lead.temperature]}
            </span>
          )}
          {file.documents.state !== 'none' && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700">
              <FileText className="h-3.5 w-3.5" />
              {DOCUMENT_STATE_LABELS[file.documents.state]}{file.documents.expected > 0 ? ` — ${file.documents.received}/${file.documents.expected}` : ''}
            </span>
          )}
          {lead.assignmentState !== 'assigned' && <span className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">{lead.assignmentState === 'to_assign' ? 'À examiner par un manager' : ASSIGNMENT_STATE_LABELS[lead.assignmentState]}</span>}
          {lead.duplicate && <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">Doublon</span>}
          <button type="button" disabled title="Les messages seront disponibles avec les canaux de communication" className="ml-1 inline-flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-4 py-2.5 text-sm font-medium text-blue-700 opacity-60">
            <MessageSquare className="h-4 w-4" /> Envoyer un message
          </button>
          <button type="button" onClick={onCall} disabled={!onCall} title={!lead.phone ? 'Aucun numéro de téléphone' : !onCall ? 'Seul le propriétaire du lead peut lancer un appel' : undefined} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-blue-700 disabled:opacity-40">
            <Phone className="h-4 w-4" /> Appeler
          </button>
        </div>
      </div>

      <div className="mt-7 border-b border-slate-200" role="tablist" aria-label="Sections de la fiche">
        <div className="flex gap-10">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)} className={cn('-mb-px border-b-2 px-1 pb-3 text-sm font-semibold', tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent font-medium text-slate-600 hover:text-slate-900')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'summary' && (
        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <section className={cn('rounded-xl border p-6', nextCard)}>
              <h2 className={cn('flex items-center gap-2.5 text-[15px] font-semibold', nextAccent)}>
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-white', nextIcon)}><Clock className="h-3 w-3" /></span>
                Prochaine action
              </h2>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
                <div className="min-w-0">
                  <p className="text-xl font-bold text-slate-900">{next.title}</p>
                  {next.dueAtMs !== null && <p className={cn('mt-1 text-sm', overdue ? 'font-semibold text-red-700' : 'text-orange-700')}>{dueLine(next.dueAtMs, next.overdue, now)}</p>}
                  <p className="mt-1.5 text-sm text-slate-600">{next.reason}</p>
                  {next.priority && <p className="mt-1 text-xs text-slate-500">Priorité {next.priority}</p>}
                </div>
                {canAct && (
                  <button
                    type="button"
                    onClick={isDocAction ? undefined : onCall}
                    disabled={isDocAction || !onCall}
                    title={isDocAction ? "L'envoi de relances arrive avec le lot « Documents »" : !onCall ? 'Seul le propriétaire du lead peut lancer un appel' : undefined}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isDocAction ? <><Send className="h-4 w-4" /> Relancer maintenant</> : <><Phone className="h-4 w-4" /> Appeler maintenant</>}
                  </button>
                )}
              </div>
              {age !== null && level && (
                <p
                  className={cn('mt-4 text-sm tabular-nums', level === 'breached' ? 'font-semibold text-red-700' : level === 'warning' ? 'font-medium text-amber-700' : 'text-slate-500')}
                  role="timer"
                  aria-label="Âge du lead"
                  title="Ouvrir cette fiche n'arrête pas le compteur : seul un changement de statut le fait."
                >
                  Depuis la réception : {formatCounter(age)}
                  {level === 'breached' && <> · SLA dépassé de {formatCounter(age - DEFAULT_SLA_MS)}</>}
                </p>
              )}
            </section>

            <Card title="Informations essentielles" icon={<UserRound className="h-[18px] w-[18px] text-blue-600" />}>
              <dl className="text-sm">
                {essentials.map((r) => (
                  <div key={r.label} className="flex gap-4 border-b border-slate-100 py-2 last:border-b-0">
                    <dt className="w-52 flex-shrink-0 text-slate-500">{r.label}</dt>
                    <dd className={cn(r.missing ? 'text-slate-400' : 'text-slate-900')}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card title="Dernière note" icon={<StickyNote className="h-[18px] w-[18px] text-blue-600" />}>
              {file.lastNote ? (
                <>
                  <p className="text-sm text-slate-800">{file.lastNote.text}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {names.users.get(file.lastNote.authorId) ?? file.lastNote.authorId} · {when(file.lastNote.atMs)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-slate-500">Aucune note pour le moment.</p>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Progression" icon={<BarChart3 className="h-[18px] w-[18px] text-blue-600" />}>
              <ol className="space-y-5">
                {progress.map((s, i) => (
                  <li key={s.key} className="relative flex gap-4">
                    {i < progress.length - 1 && <span className={cn('absolute left-[11px] top-7 h-[calc(100%-0.25rem)] w-0.5', s.state === 'done' ? 'bg-emerald-500' : 'bg-slate-200')} aria-hidden="true" />}
                    <span
                      className={cn(
                        'z-10 mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2',
                        s.state === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : s.state === 'current' ? 'border-blue-600 bg-white ring-4 ring-blue-100' : 'border-slate-300 bg-slate-100'
                      )}
                    >
                      {s.state === 'done' && <Check className="h-3.5 w-3.5" />}
                      {s.state === 'current' && <span className="h-2 w-2 rounded-full bg-blue-600" />}
                    </span>
                    <div>
                      <p className={cn('text-sm font-semibold', s.state === 'current' ? 'text-blue-700' : s.state === 'todo' ? 'text-slate-700' : 'text-slate-900')}>{s.label}</p>
                      <p className="text-xs text-slate-500">{s.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {/* Statut technique : réservé au manager et à l'administrateur (§25.1). */}
              {canSeePriority && <p className="mt-5 border-t border-slate-100 pt-3 text-xs text-slate-500">Statut : {LEAD_STATUS_LABELS[lead.status]}</p>}
            </Card>

            <Card title="Historique récent" icon={<Clock className="h-[18px] w-[18px] text-blue-600" />}>
              <RecentHistory items={timeline.slice(0, 4)} now={now} />
              {timeline.length > 4 && (
                <button type="button" onClick={() => setTab('exchanges')} className="mt-5 text-sm font-medium text-blue-600 hover:underline">
                  Voir tout l'historique →
                </button>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'exchanges' && (
        <div className="mt-6 max-w-3xl">
          <Card title={`Chronologie (${timeline.length})`} icon={<MessageSquare className="h-[18px] w-[18px] text-blue-600" />}>
            <Timeline items={timeline} />
            <p className="mt-4 text-xs text-slate-400">Appels, emails, SMS et WhatsApp rejoindront cette chronologie avec les lots « Exécution » et « Documents ».</p>
          </Card>
        </div>
      )}

      {tab === 'documents' && (
        <div className="mt-6 max-w-3xl">
          <Card title="Documents" icon={<FileText className="h-[18px] w-[18px] text-blue-600" />}>
            <p className="text-sm text-slate-800">{DOCUMENT_STATE_LABELS[file.documents.state]}{file.documents.expected > 0 ? ` — ${file.documents.received}/${file.documents.expected} pièces reçues, ${file.documents.conform} conformes` : ''}.</p>
            <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">La checklist, le dépôt, le contrôle et les relances de pièces arrivent avec le lot « Documents ».</p>
          </Card>
        </div>
      )}

      {tab === 'sale' && (
        <div className="mt-6 max-w-3xl">
          <Card title="Vente" icon={<Workflow className="h-[18px] w-[18px] text-blue-600" />}>
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">Offres, signature, règlement et financement arrivent avec les lots « Conversion » et « Vente à distance ».</p>
          </Card>
        </div>
      )}
    </div>
  );
}
