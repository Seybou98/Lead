import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Bell, Check, Clock, FileText, MapPin, MessageSquare, Phone, StickyNote, UserCheck, UserRound, Workflow } from 'lucide-react';
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

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
const when = (ms: number) => new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Card({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-5', className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        {icon}
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

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

export function LeadFilePage({ listPath }: { listPath: string }) {
  const { leadId = '' } = useParams();
  const { user } = useAuth();
  return <LeadFileView state={useLeadFile(leadId)} listPath={listPath} canSeePriority={user?.role !== 'telepro'} />;
}

export function LeadFileView({ state, listPath, canSeePriority, nowOverride }: { state: LeadFileState; listPath: string; canSeePriority: boolean; nowOverride?: number }) {
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
  const tel = lead.phone ? `tel:${lead.phone}` : null;

  const nextTone = { neutral: 'border-slate-200 bg-white', info: 'border-blue-200 bg-blue-50/60', warning: 'border-amber-200 bg-amber-50', danger: 'border-red-200 bg-red-50', success: 'border-emerald-200 bg-emerald-50' }[next.tone];

  return (
    <div className="w-full">
      {back}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-lg font-semibold text-blue-700">{initials(lead.fullName)}</span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900">{lead.fullName || 'Sans nom'}</h1>
              {lead.temperature && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">{TEMPERATURE_LABELS[lead.temperature]}</span>}
              {file.documents.state !== 'none' && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">{DOCUMENT_STATE_LABELS[file.documents.state]}{file.documents.expected > 0 ? ` — ${file.documents.received}/${file.documents.expected}` : ''}</span>}
              {lead.assignmentState !== 'assigned' && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">{lead.assignmentState === 'to_assign' ? 'À examiner par un manager' : ASSIGNMENT_STATE_LABELS[lead.assignmentState]}</span>}
              {lead.duplicate && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">Doublon</span>}
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-slate-400" />{formatPhoneDisplay(lead.phone)}</span>
              {(lead.city || lead.postalCode) && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-slate-400" />{lead.city}{lead.postalCode ? ` (${lead.postalCode.slice(0, 2)})` : ''}</span>}
              {lead.productCode && <span className="inline-flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5 text-slate-400" />{lead.productCode}</span>}
            </p>
            <p className="text-sm text-slate-500">{campaignName ? `Campagne ${campaignName}` : 'Sans campagne'} · reçu {formatAgo(lead.receivedAtMs, now)}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" disabled title="Les messages seront disponibles avec les canaux de communication" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 opacity-50">
            <MessageSquare className="h-4 w-4" /> Envoyer un message
          </button>
          {tel ? (
            <a href={tel} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold uppercase tracking-wide text-white hover:bg-blue-700">
              <Phone className="h-4 w-4" /> Appeler
            </a>
          ) : (
            <button type="button" disabled title="Aucun numéro de téléphone" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold uppercase tracking-wide text-white opacity-40">
              <Phone className="h-4 w-4" /> Appeler
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 border-b border-slate-200" role="tablist" aria-label="Sections de la fiche">
        <div className="flex gap-6">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)} className={cn('-mb-px border-b-2 px-1 pb-3 text-sm font-medium', tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'summary' && (
        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <section className={cn('rounded-xl border p-5', nextTone)}>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Clock className={cn('h-4 w-4', next.tone === 'danger' ? 'text-red-600' : next.tone === 'warning' ? 'text-amber-600' : 'text-blue-600')} /> Prochaine action
              </h2>
              <p className="mt-2 text-lg font-semibold text-slate-900">{next.title}</p>
              <p className="mt-1 text-sm text-slate-700">{next.reason}</p>
              {next.dueAtMs !== null && (
                <p className={cn('mt-1 text-sm', next.overdue ? 'font-medium text-red-700' : 'text-slate-600')}>
                  {next.overdue ? `En retard — prévue le ${when(next.dueAtMs)}` : `À faire avant le ${when(next.dueAtMs)}`}
                </p>
              )}
              {next.priority && <p className="mt-1 text-xs text-slate-500">Priorité {next.priority}</p>}
              {age !== null && level && (
                <p
                  className={cn('mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold tabular-nums', level === 'breached' ? 'bg-red-100 text-red-800' : level === 'warning' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}
                  role="timer"
                  aria-label="Âge du lead"
                >
                  Depuis la réception : {formatCounter(age)}
                  {level === 'breached' && <span className="font-medium">· SLA dépassé de {formatCounter(age - DEFAULT_SLA_MS)}</span>}
                </p>
              )}
              {age !== null && <p className="mt-2 text-xs text-slate-500">Ouvrir cette fiche n'arrête pas le compteur : seul un changement de statut le fait.</p>}
            </section>

            <Card title="Informations essentielles" icon={<UserRound className="h-4 w-4 text-blue-600" />}>
              <dl className="divide-y divide-slate-100 text-sm">
                {essentials.map((r) => (
                  <div key={r.label} className="flex gap-4 py-2">
                    <dt className="w-44 flex-shrink-0 text-slate-500">{r.label}</dt>
                    <dd className={cn('font-medium', r.missing ? 'text-slate-400' : 'text-slate-900')}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card title="Dernière note" icon={<StickyNote className="h-4 w-4 text-blue-600" />}>
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
            <Card title="Progression">
              <ol className="space-y-4">
                {progress.map((s, i) => (
                  <li key={s.key} className="relative flex gap-3">
                    {i < progress.length - 1 && <span className="absolute left-[11px] top-6 h-full w-px bg-slate-200" aria-hidden="true" />}
                    <span
                      className={cn(
                        'z-10 mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2',
                        s.state === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : s.state === 'current' ? 'border-blue-600 bg-white' : 'border-slate-300 bg-white'
                      )}
                    >
                      {s.state === 'done' && <Check className="h-3.5 w-3.5" />}
                      {s.state === 'current' && <span className="h-2 w-2 rounded-full bg-blue-600" />}
                    </span>
                    <div>
                      <p className={cn('text-sm font-medium', s.state === 'todo' ? 'text-slate-400' : 'text-slate-900')}>{s.label}</p>
                      <p className="text-xs text-slate-500">{s.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">Statut : {LEAD_STATUS_LABELS[lead.status]}</p>
            </Card>

            <Card title="Historique récent" icon={<Clock className="h-4 w-4 text-blue-600" />}>
              <Timeline items={timeline.slice(0, 5)} />
              {timeline.length > 5 && (
                <button type="button" onClick={() => setTab('exchanges')} className="mt-4 text-sm font-medium text-blue-600 hover:underline">
                  Voir tout l'historique →
                </button>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'exchanges' && (
        <div className="mt-6 max-w-3xl">
          <Card title={`Chronologie (${timeline.length})`} icon={<MessageSquare className="h-4 w-4 text-blue-600" />}>
            <Timeline items={timeline} />
            <p className="mt-4 text-xs text-slate-400">Appels, emails, SMS et WhatsApp rejoindront cette chronologie avec les lots « Exécution » et « Documents ».</p>
          </Card>
        </div>
      )}

      {tab === 'documents' && (
        <div className="mt-6 max-w-3xl">
          <Card title="Documents" icon={<FileText className="h-4 w-4 text-blue-600" />}>
            <p className="text-sm text-slate-800">{DOCUMENT_STATE_LABELS[file.documents.state]}{file.documents.expected > 0 ? ` — ${file.documents.received}/${file.documents.expected} pièces reçues, ${file.documents.conform} conformes` : ''}.</p>
            <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">La checklist, le dépôt, le contrôle et les relances de pièces arrivent avec le lot « Documents ».</p>
          </Card>
        </div>
      )}

      {tab === 'sale' && (
        <div className="mt-6 max-w-3xl">
          <Card title="Vente" icon={<Workflow className="h-4 w-4 text-blue-600" />}>
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">Offres, signature, règlement et financement arrivent avec les lots « Conversion » et « Vente à distance ».</p>
          </Card>
        </div>
      )}
    </div>
  );
}
