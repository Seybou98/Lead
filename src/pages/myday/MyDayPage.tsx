import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronRight, Copy, Pause, FileText, MapPin, Phone, PhoneCall, Trophy, UserRound, Users, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import { formatCounter, formatPhoneDisplay, slaAgeMs, slaLevel, type LeadListItem } from '../../domain/leads/leadList';
import { buildDayQueue, buildDayStats, dueTone, firstName, NEW_LEADS_CAP, type DayAction, type DueTone } from '../../domain/leads/myDay';
import { useLeadsList, useNow, type LeadsListData } from '../leads/useLeadsData';
import { callbackLevel, isCallbackAction } from '../../domain/alerts/engine';
import { useQualifiedToday } from './useQualifiedToday';
import { newRequestId, sendQualification, type QualifyRequest, type QualifyResponse } from '../../lib/qualifyApi';
import type { CallOutcomeInput } from '../../domain/call/outcomes';
import { QualificationPanel } from './QualificationPanel';
import { buildCallSession, CALL_SESSION_EVENT, callDurationSeconds, copyText, formatDuration, loadSession, saveSession, type CallSession } from './callSession';
import { sendStatus, type StatusResponse } from '../../lib/statusApi';
import { StatusMenu } from './StatusMenu';
import { capacityInfo, statusAfterCall } from '../../domain/availability/status';
import type { OperationalStatus } from '../../domain/enums';
import type { Profile } from '../../domain/models';

const hm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const TONE_DOT: Record<DueTone, string> = { late: 'bg-red-500', soon: 'bg-amber-400', later: 'bg-emerald-500' };
const TONE_LABEL: Record<DueTone, string> = { late: 'En retard', soon: 'Dans l’heure', later: 'Plus tard' };

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

function Tile({ icon, tone, value, label }: { icon: React.ReactNode; tone: string; value: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
      <span className={cn('flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div>
        <p className="text-2xl font-bold leading-none text-slate-900">{value}</p>
        <p className="mt-1 text-xs text-slate-500">{label}</p>
      </div>
    </div>
  );
}

/** Compteur SLA vivant : couleur progressive accompagnée d'un libellé, jamais la couleur seule (§12.11). */
function SlaClock({ ageMs }: { ageMs: number }) {
  const level = slaLevel(ageMs);
  return (
    <div className="text-right" role="timer" aria-label="Depuis la réception du lead">
      <p className="text-xs text-slate-500">Depuis la réception du lead</p>
      <p className={cn('mt-1 text-4xl font-bold tabular-nums', level === 'breached' ? 'text-red-600' : level === 'warning' ? 'text-amber-600' : 'text-slate-900')}>{formatCounter(ageMs)}</p>
      {level !== 'ok' && <p className={cn('mt-0.5 text-xs font-semibold', level === 'breached' ? 'text-red-600' : 'text-amber-600')}>{level === 'breached' ? 'Délai dépassé' : 'Bientôt dépassé'}</p>}
    </div>
  );
}

function PriorityCard({ action, now, campaign, basePath, onCall }: { action: DayAction; now: number; campaign: string | null; basePath: string; onCall: () => void }) {
  const { lead } = action;
  const age = slaAgeMs(lead, now);
  const tel = lead.phone ? `tel:${lead.phone}` : null;
  const type = lead.nextAction?.type ?? '';
  const docAction = /document|build_file/.test(type);
  const docActionLabel = type === 'document_review' ? 'Contrôler les pièces' : type === 'document_decision' ? 'Décider du dossier' : type === 'build_file' ? 'Monter le dossier' : 'Relancer les documents';
  // Rappel client : le palier (§8.2) donne la couleur et le libellé — bleu à l'heure, orange à +5 min, rouge à +15 min.
  const cb = isCallbackAction(lead) && action.dueAtMs !== null ? callbackLevel(action.dueAtMs, now) : null;
  const lateMin = action.dueAtMs !== null ? Math.max(0, Math.floor((now - action.dueAtMs) / 60_000)) : 0;
  const badge = action.isNewLead
    ? 'Nouveau lead — prioritaire'
    : cb === 'due'
      ? 'Rappel client — maintenant'
      : cb === 'orange' || cb === 'red'
        ? `Rappel client — en retard de ${lateMin} min`
        : action.late
          ? `${action.title} — en retard`
          : action.title;
  const badgeStyle = cb === 'red' || (action.late && cb === null) ? 'bg-red-50 text-red-600' : cb === 'orange' ? 'bg-amber-100 text-amber-800' : 'bg-blue-50 text-blue-700';
  return (
    <section className="rounded-xl border-2 border-blue-200 bg-white p-6" aria-label="Action prioritaire maintenant">
      <span className={cn('inline-block rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', badgeStyle)}>{badge}</span>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-lg font-semibold text-blue-700">{initials(lead.fullName)}</span>
          <div>
            <h2 className="text-xl font-bold text-slate-900">{lead.fullName || 'Sans nom'}</h2>
            {lead.productCode && <p className="mt-0.5 text-sm text-slate-600">Projet : <span className="font-medium text-slate-800">{lead.productCode}</span></p>}
            <p className="text-sm text-slate-600">Source : {campaign ? `Campagne ${campaign}` : 'Sans campagne'}</p>
          </div>
        </div>
        {age !== null ? (
          <SlaClock ageMs={age} />
        ) : (
          action.dueAtMs !== null && (
            <div className="text-right">
              <p className="text-xs text-slate-500">{action.late ? 'Prévue à' : 'À faire avant'}</p>
              <p className={cn('mt-1 text-4xl font-bold tabular-nums', action.late ? 'text-red-600' : 'text-slate-900')}>{hm(action.dueAtMs)}</p>
              {action.late && <p className="mt-0.5 text-xs font-semibold text-red-600">En retard</p>}
            </div>
          )
        )}
      </div>

      <div className="mt-5 grid gap-x-8 gap-y-2 border-t border-slate-100 pt-4 text-sm text-slate-700 sm:grid-cols-2">
        <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-blue-600" />{formatPhoneDisplay(lead.phone)}</p>
        <p className="flex items-center gap-2"><UserRound className="h-4 w-4 text-slate-400" />{action.title}</p>
        <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-blue-600" />{lead.city || 'Ville non renseignée'}{lead.postalCode ? ` (${lead.postalCode.slice(0, 2)})` : ''}</p>
        {lead.nextAction?.reason && <p className="flex items-center gap-2 text-slate-600"><FileText className="h-4 w-4 text-slate-400" />« {lead.nextAction.reason} »</p>}
      </div>

      <div className="mt-6 flex flex-col items-center gap-3">
        {docAction ? (
          // Action documentaire (relance, contrôle, décision, montage) : on traite les pièces, on n'appelle pas.
          <>
            <Link to={`${basePath}/${lead.id}?onglet=documents`} className="inline-flex w-full max-w-md items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3.5 text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-blue-700">
              <FileText className="h-4 w-4" /> {docActionLabel}
            </Link>
            {tel && (
              <button type="button" onClick={onCall} className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:underline">
                <Phone className="h-3.5 w-3.5" /> Appeler le client
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={onCall} disabled={!tel} title={tel ? undefined : 'Aucun numéro de téléphone'} className="inline-flex w-full max-w-md items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3.5 text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-blue-700 disabled:opacity-40">
            <Phone className="h-4 w-4" /> Appeler maintenant
          </button>
        )}
        <Link to={`${basePath}/${lead.id}`} className="text-sm font-medium text-blue-600 hover:underline">Voir la fiche complète →</Link>
      </div>
    </section>
  );
}

export function MyDayPage() {
  const { user } = useAuth();
  const role: Role = user?.role ?? 'telepro';
  const uid = user?.uid ?? '';
  return (
    <MyDayView
      data={useLeadsList(role, uid)}
      uid={uid}
      userName={user?.name ?? ''}
      basePath="/mes-leads"
      onQualify={sendQualification}
      onSetStatus={sendStatus}
      profile={user?.profile ?? null}
      qualifiedToday={useQualifiedToday(uid)}
    />
  );
}

export function MyDayView({
  data,
  uid,
  userName,
  basePath,
  nowOverride,
  onQualify,
  onSetStatus,
  profile = null,
  initialSession,
  qualifiedToday = null,
}: {
  data: LeadsListData;
  uid: string;
  userName: string;
  basePath: string;
  nowOverride?: number;
  onQualify: (req: QualifyRequest) => Promise<QualifyResponse>;
  /** Change le statut opérationnel (menu Disponible / Pause, « En appel » au démarrage d'un appel). */
  onSetStatus: (status: OperationalStatus) => Promise<StatusResponse>;
  /** Profil CRM Leads (statut, plafond) ; null = pas encore rattaché à une équipe. */
  profile?: Profile | null;
  initialSession?: CallSession | null;
  /** Appels qualifiés aujourd'hui (actions terminées) ; null = inconnu, affiché « — » plutôt qu'un faux zéro. */
  qualifiedToday?: number | null;
}) {
  const liveNow = useNow(1000);
  const now = nowOverride ?? liveNow;

  const [session, setSessionState] = useState<CallSession | null>(() => (initialSession !== undefined ? initialSession : loadSession(uid, Date.now())));
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setSession = (s: CallSession | null) => {
    setSessionState(s);
    saveSession(uid, s);
  };

  // Un appel démarré depuis une barre d'alerte alors que cet écran est déjà ouvert : on relit la session enregistrée.
  useEffect(() => {
    const reload = () => setSessionState(loadSession(uid, Date.now()));
    window.addEventListener(CALL_SESSION_EVENT, reload);
    return () => window.removeEventListener(CALL_SESSION_EVENT, reload);
  }, [uid]);

  // Le message de confirmation est bref (§25.9) : il se retire seul.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 10_000);
    return () => clearTimeout(t);
  }, [done]);

  const queue = useMemo(() => buildDayQueue(data.items, uid, now), [data.items, uid, now]);
  const stats = useMemo(() => buildDayStats(data.items, uid, now), [data.items, uid, now]);
  const name = firstName(userName);
  const campaignOf = (id: string | null) => (id ? (data.names.campaigns.get(id) ?? null) : null);
  const cap = capacityInfo(stats.newLeads, profile?.capacity, now, NEW_LEADS_CAP);
  const status: OperationalStatus = profile?.operationalStatus ?? 'available';
  const statusSinceMs = (profile?.operationalStatusSince as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;

  const sessionLead = session ? (data.items.find((l) => l.id === session.leadId) ?? null) : null;

  // Un lead qui a disparu de ma file (réattribué, clôturé ailleurs) ne doit pas bloquer l'écran sur un appel fantôme.
  useEffect(() => {
    if (session && !data.loading && !sessionLead) {
      saveSession(uid, null);
      setSessionState(null);
    }
  }, [session, sessionLead, data.loading, uid]);

  const startCall = (lead: LeadListItem) => {
    if (!lead.phone) return;
    setDone(null);
    // Téléphonie native hors périmètre V1 (cahier §1.2) : les appels se font depuis le téléphone du télépro.
    // « Appeler » DÉCLARE donc le début de l'appel (statut En appel, durée, §12.1.2) sans lancer d'application.
    setSession(buildCallSession(lead.id, Date.now(), newRequestId(), status));
    // Statut « En appel » (§12.1.2) : sans bloquer l'appel si le serveur ne répond pas.
    if (profile && status !== 'on_call') void onSetStatus('on_call');
  };
  /** Appel abandonné sans résultat : on rétablit le statut d'avant l'appel (sinon il resterait « En appel »). */
  const cancelCall = () => {
    if (session && status === 'on_call') void onSetStatus(statusAfterCall(session.resumeStatus));
    setSession(null);
  };
  const copyPhone = async (phone: string | null) => {
    if (!phone) return;
    setCopied(await copyText(formatPhoneDisplay(phone)));
    setTimeout(() => setCopied(false), 3000);
  };
  const endCall = () => session && setSession({ ...session, phase: 'qualifying', endedAtMs: Date.now() });

  const submit = async (input: CallOutcomeInput): Promise<QualifyResponse> => {
    if (!session || !sessionLead) return { ok: false as const, message: 'Appel introuvable.', errors: {}, retryable: false };
    const res = await onQualify({
      leadId: session.leadId,
      requestId: session.requestId,
      expectedStatus: sessionLead.status,
      durationSeconds: callDurationSeconds(session, Date.now()),
      resumeStatus: session.resumeStatus,
      input,
    });
    if (res.ok) {
      setSession(null);
      setDone(res.summary);
    }
    return res;
  };

  if (session?.phase === 'qualifying' && sessionLead) {
    return (
      <div className="w-full">
        <QualificationPanel
          lead={sessionLead}
          durationSeconds={callDurationSeconds(session, now)}
          endedAtMs={session.endedAtMs}
          nowMs={now}
          requestId={session.requestId}
          userId={uid}
          onSubmit={submit}
          onCancel={() => setSession({ ...session, phase: 'calling', endedAtMs: null })}
        />
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">{name ? `Bonjour ${name}` : 'Bonjour'}</h1>
          <p className="mt-1 text-slate-500">{queue.current ? 'Voici votre prochaine action' : 'Aucune action en attente'}</p>
        </div>
        {profile ? (
          <StatusMenu status={status} sinceMs={statusSinceMs} suspended={profile.distributionSuspended === true} onChange={onSetStatus} />
        ) : (
          <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-500" title="Aucune équipe : un administrateur doit vous rattacher à une équipe.">
            <span className="h-2 w-2 rounded-full bg-slate-400" aria-hidden="true" /> Non rattaché
          </span>
        )}
      </div>

      {done && (
        <div role="status" className="mt-5 flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <span className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0" /> {done}</span>
          <button type="button" onClick={() => setDone(null)} aria-label="Fermer" className="text-emerald-700 hover:text-emerald-900"><X className="h-4 w-4" /></button>
        </div>
      )}

      {profile && status === 'paused' && (
        <div role="status" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="flex items-start gap-2"><Pause className="mt-0.5 h-4 w-4 flex-shrink-0" /> Vous êtes en pause : aucun nouveau lead ne vous est attribué. Vos leads en cours restent à traiter.</span>
          <button type="button" onClick={() => void onSetStatus('available')} className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-blue-700">Reprendre</button>
        </div>
      )}
      {profile && cap.full && (
        <div role="status" className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Plafond atteint : {cap.used} / {cap.cap} leads Nouveaux. Plus aucun lead ne vous est attribué tant que vous n'êtes pas repassé à {cap.cap - 1} : traitez encore {cap.toFree} lead{cap.toFree > 1 ? 's' : ''}.</span>
        </div>
      )}
      {profile?.distributionSuspended === true && (
        <div role="status" className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> Votre distribution est suspendue par votre manager : aucun nouveau lead ne vous est attribué, quel que soit votre statut.
        </div>
      )}

      {data.error && (
        <div role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {data.error}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={<PhoneCall className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" value={qualifiedToday ?? '—'} label="appels qualifiés aujourd'hui" />
        <Tile icon={<Users className="h-5 w-5 text-blue-600" />} tone="bg-blue-50" value={<span className={cap.full ? 'text-red-600' : undefined}>{cap.used}<span className="text-base font-semibold text-slate-400"> / {cap.cap}</span></span>} label={cap.full ? 'nouveaux leads : plafond atteint' : 'nouveaux leads'} />
        <Tile icon={<FileText className="h-5 w-5 text-emerald-600" />} tone="bg-emerald-50" value={stats.documentsInProgress} label="dossiers en documents" />
        <Tile icon={<Trophy className="h-5 w-5 text-amber-500" />} tone="bg-amber-50" value={stats.converted} label="ventes (leads convertis)" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {data.loading ? (
          <p className="rounded-xl border border-slate-200 bg-white p-8 text-slate-500">Chargement…</p>
        ) : session?.phase === 'calling' && sessionLead ? (
          <section className="rounded-xl border-2 border-emerald-300 bg-white p-6" aria-label="Appel en cours">
            <span className="inline-block rounded-md bg-emerald-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700">Appel en cours</span>
            <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{sessionLead.fullName || 'Sans nom'}</h2>
                {sessionLead.productCode && <p className="mt-0.5 text-sm text-slate-600">Projet : {sessionLead.productCode}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p className="flex items-center gap-2 text-2xl font-bold tracking-wide text-slate-900"><Phone className="h-5 w-5 text-blue-600" />{formatPhoneDisplay(sessionLead.phone)}</p>
                  <button type="button" onClick={() => void copyPhone(sessionLead.phone)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                    <Copy className="h-4 w-4" /> {copied ? 'Numéro copié' : 'Copier le numéro'}
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-600">Composez ce numéro depuis votre téléphone.{sessionLead.phone && <> <a href={`tel:${sessionLead.phone}`} className="text-blue-600 hover:underline">Ouvrir dans une application téléphone</a> (softphone, téléphone relié).</>}</p>
              </div>
              <p className="text-right text-4xl font-bold tabular-nums text-slate-900" role="timer" aria-label="Durée de l'appel">{formatDuration(callDurationSeconds(session, now))}</p>
            </div>
            <p className="mt-5 text-sm text-slate-600">Quand l'appel est terminé, déclarez son résultat : la prochaine action est calculée automatiquement.</p>
            <div className="mt-5 flex flex-col items-center gap-3">
              <button type="button" onClick={endCall} className="inline-flex w-full max-w-md items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3.5 text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-blue-700">
                <PhoneCall className="h-4 w-4" /> Terminer l'appel
              </button>
              <button type="button" onClick={cancelCall} className="text-sm font-medium text-slate-500 hover:text-slate-800 hover:underline">Annuler (aucun appel passé)</button>
            </div>
          </section>
        ) : queue.current ? (
          <PriorityCard action={queue.current} now={now} campaign={campaignOf(queue.current.lead.campaignId)} basePath={basePath} onCall={() => startCall(queue.current!.lead)} />
        ) : (
          <section className="rounded-xl border border-slate-200 bg-white p-10 text-center">
            <h2 className="text-lg font-semibold text-slate-900">Rien à traiter pour le moment</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">Vos prochains leads arriveront ici dès leur attribution, sans recharger la page. Restez connecté pour en recevoir.</p>
          </section>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label="Ensuite">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900">Ensuite</h2>
            <Link to={basePath} className="text-xs font-medium text-blue-600 hover:underline">Voir tout</Link>
          </div>
          {queue.upcoming.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Aucune autre action planifiée.</p>
          ) : (
            <ul className="mt-4 space-y-2.5">
              {queue.upcoming.map((a) => {
                const tone = dueTone(a, now);
                return (
                  <li key={a.lead.id}>
                    <Link to={`${basePath}/${a.lead.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
                      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                        {a.isNewLead ? <Users className="h-4 w-4" /> : /document/.test(a.lead.nextAction?.type ?? '') ? <FileText className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-slate-500">{a.dueAtMs !== null ? hm(a.dueAtMs) : 'À prendre'}</span>
                        <span className="block truncate text-sm font-semibold text-slate-900">{a.title}</span>
                        <span className="block truncate text-xs text-slate-500">{a.lead.fullName}{a.lead.productCode ? ` — ${a.lead.productCode}` : ''}</span>
                      </span>
                      <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', TONE_DOT[tone])} role="img" aria-label={TONE_LABEL[tone]} title={TONE_LABEL[tone]} />
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-400" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {queue.total > 1 + queue.upcoming.length && <p className="mt-3 text-xs text-slate-500">+ {queue.total - 1 - queue.upcoming.length} autre(s) action(s) dans « Mes leads ».</p>}
        </section>
      </div>

      <section className="mt-6 grid items-center gap-6 rounded-xl border border-slate-200 bg-white px-6 py-4 md:grid-cols-[auto_1fr_1fr_1fr]" aria-label="Aujourd'hui">
        <h2 className="text-base font-bold text-slate-900">Aujourd'hui</h2>
        <div>
          <p className="text-sm text-slate-700"><span className="font-semibold">{cap.used}</span> / {cap.cap} nouveaux leads{cap.full && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">Plafond atteint</span>}</p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={cap.cap} aria-valuenow={Math.min(cap.used, cap.cap)} aria-label="Capacité de leads nouveaux">
            <div className={cn('h-full rounded-full', cap.full ? 'bg-red-500' : 'bg-blue-600')} style={{ width: `${cap.percent}%` }} />
          </div>
        </div>
        <p className="text-sm text-slate-700"><span className="font-semibold">{stats.receivedToday}</span> lead(s) reçu(s) aujourd'hui</p>
        <p className="text-sm text-slate-700"><span className={cn('font-semibold', stats.lateActions > 0 && 'text-red-600')}>{stats.lateActions}</span> action(s) en retard</p>
      </section>

      <p className="mt-4 text-xs text-slate-400">Les objectifs s'afficheront avec la configuration des objectifs.</p>
    </div>
  );
}
