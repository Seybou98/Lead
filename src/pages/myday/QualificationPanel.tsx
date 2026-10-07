import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Ban,
  Bell,
  CalendarClock,
  CalendarDays,
  Check,
  Clock,
  Copy,
  FileText,
  Flame,
  Frown,
  Handshake,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Phone,
  PhoneCall,
  PhoneOff,
  ShieldCheck,
  ShieldX,
  Snowflake,
  Tag,
  Target,
  ThumbsDown,
  Timer,
  User,
  Users,
  Waves,
  Wrench,
  Euro,
  FileX,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatPhoneDisplay, type LeadListItem } from '../../domain/leads/leadList';
import {
  BAD_MOMENT_DELAYS,
  BAD_MOMENT_REASONS,
  CALLBACK_REASONS,
  CALL_CHOICES,
  CALL_CHOICE_LABELS,
  CLOSE_REASONS,
  DEFAULT_DOCUMENT_TYPES,
  DOCUMENT_CHANNELS,
  FAKE_LEAD_MOTIVES,
  INELIGIBLE_CATEGORIES,
  INELIGIBLE_MOTIVES,
  INTEREST_NEXT_ACTIONS,
  INTEREST_REASONS,
  REFUSAL_FOLLOW_UPS,
  REFUSAL_MOTIVES,
  TEMPERATURE_CHOICES,
  type BadMomentReason,
  type CallbackReason,
  type CallChoice,
  type CallOutcomeInput,
  type CloseReason,
  type DocumentChannelKey,
  type FakeLeadMotive,
  type IneligibleCategory,
  type InterestNextAction,
  type InterestReason,
  type RefusalFollowUp,
  type RefusalMotive,
} from '../../domain/call/outcomes';
import { currentNrAttempt, DEFAULT_CALL_RULES, formatWhen, MAX_NR_ATTEMPTS, nextNrAttemptAt, planCallOutcome, type CallRules } from '../../domain/call/plan';
import type { QualifyResponse } from '../../lib/qualifyApi';
import { callbackPresets, formatDuration, fromLocalFields, toLocalFields } from './callSession';
import { CancelButton, fieldClass, InfoBar, labelClass, OutcomeModal, PrimaryButton, Toggle } from './OutcomeModal';

// ── Pictogrammes de la fig. 5 : pleins et colorés, comme sur la maquette ─────

function TileIcon({ choice }: { choice: CallChoice }) {
  switch (choice) {
    case 'no_answer':
      return <Phone className="h-7 w-7 text-slate-500" />;
    case 'callback':
      return <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-white"><Clock className="h-4 w-4" strokeWidth={2.5} /></span>;
    case 'interested':
      return <Flame className="h-7 w-7 fill-orange-400 text-orange-500" />;
    case 'request_documents':
      return <FileText className="h-7 w-7 fill-emerald-600 text-white" strokeWidth={1.75} />;
    case 'close_now':
      return <Handshake className="h-7 w-7 text-blue-600" strokeWidth={2.25} />;
    case 'close':
      return <Archive className="h-7 w-7 fill-red-500 text-white" strokeWidth={1.75} />;
  }
}

type ModalKey =
  | 'no_answer'
  | 'callback'
  | 'bad_moment'
  | 'interested'
  | 'close_pick'
  | 'close_not_interested'
  | 'close_ineligible'
  | 'close_fake_lead'
  | 'close_wrong_number'
  | 'close_other';

const MODAL_OF: Partial<Record<CallChoice, ModalKey>> = { no_answer: 'no_answer', callback: 'callback', interested: 'interested', close: 'close_pick' };

const REFUSAL_ICON: Record<RefusalMotive, ReactNode> = {
  price: <Tag className="h-5 w-5" />,
  not_interested: <Frown className="h-5 w-5" />,
  competitor: <Users className="h-5 w-5" />,
  postponed: <CalendarDays className="h-5 w-5" />,
  refuses_procedures: <FileX className="h-5 w-5" />,
  no_more_contact: <PhoneOff className="h-5 w-5" />,
  other: <MoreHorizontal className="h-5 w-5" />,
};
const CATEGORY_ICON: Record<IneligibleCategory, ReactNode> = {
  technical: <Wrench className="h-4 w-4" />,
  administrative: <FileText className="h-4 w-4" />,
  financial: <Euro className="h-4 w-4" />,
  zone: <MapPin className="h-4 w-4" />,
};
const FAKE_ICON: Record<FakeLeadMotive, ReactNode> = {
  fake_number: <Phone className="h-5 w-5" />,
  invalid_number: <Ban className="h-5 w-5" />,
  usurped_identity: <Users className="h-5 w-5" />,
  duplicate: <Copy className="h-5 w-5" />,
  out_of_target: <Target className="h-5 w-5" />,
  spam: <Mail className="h-5 w-5" />,
  other: <MoreHorizontal className="h-5 w-5" />,
};
const CHANNEL_ICON: Record<DocumentChannelKey, ReactNode> = {
  whatsapp: <MessageCircle className="h-4 w-4" />,
  email: <Mail className="h-4 w-4" />,
  sms: <MessageSquare className="h-4 w-4" />,
  other: <MoreHorizontal className="h-4 w-4" />,
};
const TEMP_ICON = { hot: Flame, warm: Waves, to_work: Snowflake } as const;
const TEMP_COLOR = { hot: 'text-orange-500 bg-orange-50', warm: 'text-amber-500 bg-amber-50', to_work: 'text-blue-500 bg-blue-50' } as const;
const DELAY_ICON: Record<string, ReactNode> = { '15': <Timer className="h-6 w-6" />, '30': <Clock className="h-6 w-6" />, '60': <Clock className="h-6 w-6" />, custom: <CalendarClock className="h-6 w-6" /> };

function SmallChip({ onClick, children, active }: { onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded-full border px-3 py-1 text-xs font-medium', active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-blue-200 bg-blue-50/40 text-blue-700 hover:bg-blue-50')}>
      {children}
    </button>
  );
}

function Select<T extends string>({ id, value, onChange, options, placeholder }: { id: string; value: T | ''; onChange: (v: T) => void; options: Record<string, string>; placeholder: string }) {
  return (
    <select id={id} className={fieldClass} value={value} onChange={(e) => onChange(e.target.value as T)}>
      <option value="">{placeholder}</option>
      {Object.entries(options).map(([k, v]) => (
        <option key={k} value={k}>{v}</option>
      ))}
    </select>
  );
}

function DateTime({ id, date, time, onDate, onTime }: { id: string; date: string; time: string; onDate: (v: string) => void; onTime: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className={labelClass} htmlFor={`${id}-d`}>Date <span className="text-red-500">*</span></label>
        <div className="relative">
          <input id={`${id}-d`} type="date" className={fieldClass} value={date} onChange={(e) => onDate(e.target.value)} />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor={`${id}-t`}>Heure <span className="text-red-500">*</span></label>
        <div className="relative">
          <input id={`${id}-t`} type="time" className={fieldClass} value={time} onChange={(e) => onTime(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

const Counter = ({ value, max }: { value: string; max: number }) => <p className="mt-1 text-right text-[11px] text-slate-400">{value.length} / {max}</p>;
const Req = () => <span className="text-red-500">*</span>;

const hm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export interface QualificationPanelProps {
  lead: LeadListItem;
  durationSeconds: number;
  /** Heure de fin d'appel, pour « Aujourd'hui à 14:27 ». */
  endedAtMs?: number | null;
  nowMs: number;
  /** Identifiant d'idempotence stable pour toute la saisie (voir callSession.ts). */
  requestId: string;
  rules?: CallRules;
  userId: string;
  onSubmit: (input: CallOutcomeInput) => Promise<QualifyResponse>;
  onCancel: () => void;
  /** Résultat présélectionné (reprise d'une saisie, tests visuels). */
  initialChoice?: CallChoice;
  /** Fenêtre ouverte d'emblée (tests visuels). */
  initialModal?: ModalKey;
}

export function QualificationPanel({ lead, durationSeconds, endedAtMs, nowMs, requestId, rules = DEFAULT_CALL_RULES, userId, onSubmit, onCancel, initialChoice, initialModal }: QualificationPanelProps) {
  const [choice, setChoice] = useState<CallChoice | null>(initialChoice ?? null);
  const [modal, setModal] = useState<ModalKey | null>(initialModal ?? null);

  const soon = useMemo(() => toLocalFields(nowMs + 30 * 60_000), []); // eslint-disable-line react-hooks/exhaustive-deps
  const tomorrow = useMemo(() => toLocalFields(new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate() + 1, 9, 0).getTime()), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── NR ──
  const [nrComment, setNrComment] = useState('');
  const [nrRefused, setNrRefused] = useState(false);
  // ── À rappeler / mauvais moment ──
  const [cbDate, setCbDate] = useState(soon.date);
  const [cbTime, setCbTime] = useState(soon.time);
  const [cbReason, setCbReason] = useState<CallbackReason | ''>('');
  const [cbComment, setCbComment] = useState('');
  const [cbConfirmed, setCbConfirmed] = useState(false);
  const [bmDelay, setBmDelay] = useState<string>('30');
  const [bmDate, setBmDate] = useState(soon.date);
  const [bmTime, setBmTime] = useState(soon.time);
  const [bmReason, setBmReason] = useState<BadMomentReason | ''>('');
  const [bmNote, setBmNote] = useState('');
  const [bmConfirmed, setBmConfirmed] = useState(false);
  // ── Intéressé ──
  const [intTemp, setIntTemp] = useState<'hot' | 'warm' | 'to_work' | ''>('');
  const [intReason, setIntReason] = useState<InterestReason | ''>('');
  const [intAction, setIntAction] = useState<InterestNextAction | ''>('');
  const [intDate, setIntDate] = useState(tomorrow.date);
  const [intTime, setIntTime] = useState(tomorrow.time);
  const [intComment, setIntComment] = useState('');
  // ── Documents ──
  const [docs, setDocs] = useState<string[]>(DEFAULT_DOCUMENT_TYPES.filter((d) => d.mandatory).map((d) => d.code));
  const [docChannel, setDocChannel] = useState<DocumentChannelKey | ''>('');
  const [docPromised, setDocPromised] = useState(false);
  const [docDate, setDocDate] = useState(soon.date);
  const [docTime, setDocTime] = useState(soon.time);
  const [docNote, setDocNote] = useState('');
  // ── Clôtures ──
  const [niMotive, setNiMotive] = useState<RefusalMotive | ''>('');
  const [niComment, setNiComment] = useState('');
  const [niFollow, setNiFollow] = useState<RefusalFollowUp>('close');
  const [niDate, setNiDate] = useState('');
  const [niOpposition, setNiOpposition] = useState(false);
  const [ieCategory, setIeCategory] = useState<IneligibleCategory | ''>('');
  const [ieMotive, setIeMotive] = useState('');
  const [ieProduct, setIeProduct] = useState(lead.productCode ?? '');
  const [ieJustif, setIeJustif] = useState('');
  const [ieAltOn, setIeAltOn] = useState(false);
  const [ieAlt, setIeAlt] = useState('');
  const [flMotive, setFlMotive] = useState<FakeLeadMotive | ''>('');
  const [flComment, setFlComment] = useState('');
  const [flManager, setFlManager] = useState(true);
  const [wrongComment, setWrongComment] = useState('');
  const [otherComment, setOtherComment] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const presets = useMemo(() => callbackPresets(nowMs), [nowMs]);
  const nr = currentNrAttempt({ status: lead.status, nr: lead.nr ?? { attempt: 0, cycle: 1 } });
  const nrNext = nextNrAttemptAt(nr.attempt, nowMs, rules);
  const at = (d: string, t: string) => fromLocalFields(d, t);

  // Ce qui est en cours de saisie : la fenêtre ouverte, sinon le formulaire « documents » de la fig. 5.
  const active: ModalKey | 'request_documents' | null = modal !== 'close_pick' ? (modal ?? (choice === 'request_documents' ? 'request_documents' : null)) : null;

  const input: CallOutcomeInput | null = (() => {
    switch (active) {
      case 'no_answer':
        return { kind: 'no_answer', comment: nrComment, refusedCall: nrRefused };
      case 'callback':
        return { kind: 'callback', atMs: at(cbDate, cbTime), reason: cbReason as CallbackReason, comment: cbComment, confirmed: cbConfirmed };
      case 'bad_moment':
        return { kind: 'bad_moment', atMs: at(bmDate, bmTime), reason: bmReason as BadMomentReason, note: bmNote, confirmed: bmConfirmed };
      case 'interested':
        return { kind: 'interested', temperature: intTemp as 'hot', reason: intReason as InterestReason, nextAction: intAction as InterestNextAction, nextActionAtMs: at(intDate, intTime), comment: intComment };
      case 'request_documents':
        return { kind: 'request_documents', documents: docs, channel: docChannel as DocumentChannelKey, promisedAtMs: docPromised ? at(docDate, docTime) : null, note: docNote };
      case 'close_not_interested':
        return { kind: 'close_not_interested', motive: niMotive as RefusalMotive, comment: niComment, followUp: niFollow, recycleAtMs: niFollow === 'recycle' ? at(niDate, '09:00') : null, opposition: niOpposition };
      case 'close_ineligible':
        return { kind: 'close_ineligible', category: ieCategory as IneligibleCategory, motive: ieMotive, product: ieProduct, justification: ieJustif, alternativeProduct: ieAltOn ? ieAlt || null : null };
      case 'close_fake_lead':
        return { kind: 'close_fake_lead', motive: flMotive as FakeLeadMotive, comment: flComment, requestManagerCheck: flManager };
      case 'close_wrong_number':
        return { kind: 'close_wrong_number', comment: wrongComment };
      case 'close_other':
        return { kind: 'close_other', comment: otherComment };
      default:
        return null;
    }
  })();

  // La MÊME fonction que le serveur : ce que l'écran accepte, le serveur l'accepte (il re-vérifie tout).
  const preview = useMemo(() => {
    if (!input) return null;
    return planCallOutcome(input, {
      lead: { id: lead.id, status: lead.status, ownerId: userId, productCode: lead.productCode, nr: lead.nr ?? { attempt: 0, cycle: 1 }, nextActionId: null },
      actorId: userId,
      actorRole: 'telepro',
      nowMs,
      requestId,
      durationSeconds,
      rules,
    });
    // `input` est recalculé à chaque rendu : on dépend de sa sérialisation, pas de son identité.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(input), lead.id, lead.status, userId, nowMs, requestId, rules]);

  const blocking = preview && !preview.ok ? preview : null;
  const ready = input !== null && preview?.ok === true;

  const open = (m: ModalKey | null) => {
    setModal(m);
    setTouched(false);
    setServerError(null);
  };
  const pickTile = (c: CallChoice) => {
    setChoice(c);
    setServerError(null);
    setTouched(false);
    const m = MODAL_OF[c];
    if (m) setModal(m);
  };

  const submit = async () => {
    setTouched(true);
    if (!ready || !input || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const res = await onSubmit(input);
    setSubmitting(false);
    if (!res.ok) setServerError(res.message);
  };

  const setFromPreset = (atMs: number, set: (d: string, t: string) => void) => {
    const f = toLocalFields(atMs);
    set(f.date, f.time);
  };

  const feedback = (
    <>
      {touched && blocking && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {blocking.message}</p>
      )}
      {serverError && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {serverError}</p>
      )}
    </>
  );
  const actions = (label: ReactNode, opts: { danger?: boolean } = {}) => (
    <>
      <CancelButton onClick={() => open(null)} disabled={submitting} />
      <PrimaryButton onClick={submit} disabled={submitting} danger={opts.danger}>{submitting ? 'Enregistrement…' : label}</PrimaryButton>
    </>
  );
  const common = { lead, busy: submitting, onClose: () => open(null) };

  const cbBase = cbDate && cbTime ? at(cbDate, cbTime) : Number.NaN;
  const bmBase = bmDate && bmTime ? at(bmDate, bmTime) : Number.NaN;

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-100/85 backdrop-blur-sm" role="presentation">
      <section className="mx-auto w-full max-w-5xl px-4 py-6" aria-label="Qualification de fin d'appel">
        {/* Bandeau client (fig. 5) */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500"><User className="h-5 w-5" /></span>
            <div>
              <p className="font-semibold text-slate-900">{lead.fullName || 'Sans nom'}</p>
              <p className="text-xs text-slate-500">{lead.productCode ?? 'Projet non renseigné'}</p>
            </div>
          </div>
          <p className="flex items-center gap-2 text-sm text-slate-800"><Phone className="h-4 w-4 text-slate-500" />{formatPhoneDisplay(lead.phone)}</p>
          <p className="flex items-center gap-2 text-sm text-slate-800"><Clock className="h-4 w-4 text-slate-500" />{formatDuration(durationSeconds)} <span className="text-xs text-slate-400">Durée de l'appel</span></p>
          <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">
            <PhoneCall className="h-4 w-4" />
            <span>Appel terminé<span className="block text-[11px] font-normal text-emerald-600">Aujourd'hui à {hm(endedAtMs ?? nowMs)}</span></span>
          </span>
        </div>

        {/* Choix du résultat (fig. 5) */}
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
          <h2 className="text-center text-2xl font-bold text-slate-900">Comment s'est terminé l'appel ?</h2>
          <p className="mt-1 text-center text-sm text-slate-500">Choisissez le résultat pour définir automatiquement la prochaine action.</p>

          <div className="mt-6 grid gap-3.5 sm:grid-cols-3" role="radiogroup" aria-label="Résultat de l'appel">
            {CALL_CHOICES.map((c) => {
              const disabled = c === 'close_now';
              const selected = choice === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  title={disabled ? 'La vente à distance arrive avec le lot « Vente » : en attendant, choisissez « Intéressé » ou « Demander les documents ».' : undefined}
                  onClick={() => pickTile(c)}
                  className={cn('relative rounded-xl border px-4 py-5 text-center transition', selected ? 'border-emerald-400 bg-emerald-50/60 ring-1 ring-emerald-300' : 'border-slate-200 bg-white hover:border-slate-300', disabled && 'cursor-not-allowed opacity-45 hover:border-slate-200')}
                >
                  {selected && <span className="absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white"><Check className="h-3 w-3" strokeWidth={3} /></span>}
                  <span className="mx-auto flex h-8 items-center justify-center"><TileIcon choice={c} /></span>
                  <p className="mt-2.5 text-sm font-semibold text-slate-900">{CALL_CHOICE_LABELS[c].title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{disabled ? 'Bientôt disponible' : CALL_CHOICE_LABELS[c].hint}</p>
                </button>
              );
            })}
          </div>

          {/* Documents : formulaire intégré, comme sur la fig. 5 */}
          {choice === 'request_documents' && modal === null && (
            <div className="mt-6 border-t border-slate-100 pt-5">
              <div className="flex items-center gap-2.5">
                <FileText className="h-6 w-6 fill-emerald-600 text-white" strokeWidth={1.75} />
                <div>
                  <p className="text-sm font-bold text-slate-900">Documents à demander</p>
                  <p className="text-xs text-slate-500">Sélectionnez les documents à demander au client.</p>
                </div>
              </div>
              <div className="mt-4 grid gap-6 md:grid-cols-[1fr_1fr_1fr]">
                <ul className="space-y-2.5">
                  {rules.documentTypes.map((d) => (
                    <li key={d.code}>
                      <label className="flex items-center gap-2.5 text-sm text-slate-800">
                        <input type="checkbox" checked={docs.includes(d.code)} onChange={(e) => setDocs(e.target.checked ? [...docs, d.code] : docs.filter((c) => c !== d.code))} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                        {d.label}
                      </label>
                    </li>
                  ))}
                </ul>
                <div>
                  <p className={labelClass}>Canal d'envoi <Req /></p>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(DOCUMENT_CHANNELS) as DocumentChannelKey[]).map((c) => (
                      <button key={c} type="button" onClick={() => setDocChannel(c)} aria-pressed={docChannel === c} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium', docChannel === c ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
                        {CHANNEL_ICON[c]} {DOCUMENT_CHANNELS[c]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className={labelClass}>Documents promis pour</p>
                    <label className="mb-2 flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={docPromised} onChange={(e) => setDocPromised(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                      Le client promet une date
                    </label>
                    {docPromised && <DateTime id="doc" date={docDate} time={docTime} onDate={setDocDate} onTime={setDocTime} />}
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="doc-note">Note (optionnelle)</label>
                    <textarea id="doc-note" rows={2} maxLength={300} className={fieldClass} placeholder="Ajouter une note sur l'échange avec le client…" value={docNote} onChange={(e) => setDocNote(e.target.value)} />
                    <Counter value={docNote} max={300} />
                  </div>
                </div>
              </div>
              <div className="mt-4"><InfoBar>La demande et les relances seront préparées automatiquement à votre nom.</InfoBar></div>
              {feedback}
              {ready && preview?.ok && <p className="mt-3 flex items-start gap-2 text-sm text-slate-600"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />{preview.plan.summary}</p>}
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <CancelButton onClick={onCancel} disabled={submitting} />
            <button
              type="button"
              disabled={submitting || choice === null || choice === 'close_now'}
              onClick={() => (choice === 'request_documents' ? void submit() : choice && MODAL_OF[choice] ? open(MODAL_OF[choice]!) : undefined)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Enregistrement…' : (<><ArrowRight className="h-4 w-4" /> Valider et passer au client suivant</>)}
            </button>
          </div>
        </div>
      </section>

      {/* ── Fig. 6 : Enregistrer un NR ── */}
      {modal === 'no_answer' && (
        <OutcomeModal
          {...common}
          title="Enregistrer un NR"
          width="max-w-xl"
          footerNote={nr.attempt >= MAX_NR_ATTEMPTS ? undefined : 'Le lead reviendra automatiquement dans votre file à l\'heure prévue.'}
          actions={actions(`Enregistrer NR${nr.attempt} et continuer`)}
        >
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-200 text-lg font-bold text-slate-700">NR</span>
            <p className="text-lg font-semibold text-slate-900">Aucune réponse</p>
          </div>
          <div className="mt-5">
            <div className="flex items-center" aria-label={`Tentative NR${nr.attempt} sur ${MAX_NR_ATTEMPTS}`}>
              {Array.from({ length: MAX_NR_ATTEMPTS }, (_, i) => i + 1).map((n) => (
                <div key={n} className="flex flex-1 flex-col items-start last:flex-none">
                  <div className="flex w-full items-center">
                    <span className={cn('z-10 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold', n <= nr.attempt ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-500')}>{n}</span>
                    {n < MAX_NR_ATTEMPTS && <span className={cn('h-0.5 flex-1', n < nr.attempt ? 'bg-blue-600' : 'bg-slate-200')} />}
                  </div>
                  <span className={cn('mt-1 text-[11px] font-medium', n === nr.attempt ? 'text-blue-700' : 'text-slate-500')}>NR{n}</span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-center text-xs font-semibold text-slate-700">NR{nr.attempt} sur {MAX_NR_ATTEMPTS}</p>
          </div>
          <div className="mt-4"><InfoBar>Tentative enregistrée aujourd'hui à {hm(nowMs)}</InfoBar></div>
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/70 p-4">
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white"><CalendarClock className="h-5 w-5" /></span>
            {nr.attempt >= MAX_NR_ATTEMPTS ? (
              <div className="text-sm text-slate-800"><p className="font-semibold text-blue-700">Dernière tentative du cycle</p><p className="mt-0.5">Sans réponse, le lead passe en « Injoignable — fin cycle {nr.cycle} », sort de votre file et reste consultable.</p></div>
            ) : nrNext === null ? (
              <p className="text-sm text-amber-800">Aucun créneau de travail n'est configuré : la prochaine tentative ne peut pas être calculée.</p>
            ) : (
              <div>
                <p className="text-xs font-semibold text-blue-700">Prochaine tentative calculée automatiquement</p>
                <p className="mt-0.5 text-lg font-bold text-slate-900">NR{nr.attempt + 1} · {formatWhen(nrNext, nowMs, rules.schedule.timezone).replace(/^./, (m) => m.toUpperCase())}</p>
                <p className="text-xs text-slate-600">Selon les horaires commerciaux et la séquence NR</p>
              </div>
            )}
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="nr-comment">Commentaire <span className="font-normal text-slate-400">(optionnel)</span></label>
            <input id="nr-comment" maxLength={500} className={fieldClass} placeholder="Ajouter une précision…" value={nrComment} onChange={(e) => setNrComment(e.target.value)} />
          </div>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <Toggle checked={nrRefused} onChange={setNrRefused} label={<>Le client a rejeté l'appel <span className="text-slate-400">(optionnel)</span></>} />
          </div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Fig. 7 : Programmer un rappel client ── */}
      {modal === 'callback' && (
        <OutcomeModal
          {...common}
          title="Programmer un rappel client"
          width="max-w-3xl"
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600"><Clock className="h-5 w-5" /></span>}
          footerNote="Le rappel apparaîtra automatiquement dans votre file de travail."
          actions={actions('Programmer le rappel')}
        >
          <InfoBar>Ce rappel devient un engagement pris avec le client.</InfoBar>
          <div className="mt-4 grid gap-5 md:grid-cols-[1fr_230px]">
            <div className="space-y-4">
              <DateTime id="cb" date={cbDate} time={cbTime} onDate={setCbDate} onTime={setCbTime} />
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => <SmallChip key={p.key} onClick={() => setFromPreset(p.atMs, (d, t) => { setCbDate(d); setCbTime(t); })}>{p.label}</SmallChip>)}
              </div>
              <div>
                <label className={labelClass} htmlFor="cb-reason">Motif <Req /></label>
                <Select<CallbackReason> id="cb-reason" value={cbReason} onChange={setCbReason} options={CALLBACK_REASONS} placeholder="Choisir un motif" />
              </div>
              <div>
                <label className={labelClass} htmlFor="cb-comment">Commentaire <Req /></label>
                <textarea id="cb-comment" rows={3} maxLength={500} className={fieldClass} placeholder="Ex. : Monsieur souhaite être rappelé à 18h avec son épouse." value={cbComment} onChange={(e) => setCbComment(e.target.value)} />
                <Counter value={cbComment} max={500} />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input type="checkbox" checked={cbConfirmed} onChange={(e) => setCbConfirmed(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                Le client a confirmé ce créneau
              </label>
              <button type="button" onClick={() => open('bad_moment')} className="text-sm font-medium text-blue-600 hover:underline">Le client n'a pas le temps maintenant ? Programmer un rappel rapide →</button>
            </div>
            <aside className="space-y-3">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-700">Notifications et suivi</p>
                <ol className="mt-3 space-y-3 text-xs text-slate-700">
                  {[
                    { t: cbBase - 5 * 60_000, label: 'Alerte dans 5 minutes', dot: 'bg-white ring-2 ring-slate-400', icon: <Bell className="h-3 w-3 text-slate-500" /> },
                    { t: cbBase, label: 'Priorité P0', dot: 'bg-blue-600', bold: true },
                    { t: cbBase + 5 * 60_000, label: 'Retard visible', dot: 'bg-amber-400' },
                    { t: cbBase + 30 * 60_000, label: 'Escalade manager', dot: 'bg-red-500' },
                  ].map((s) => (
                    <li key={s.label} className="flex items-center gap-2.5">
                      <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', s.dot)} />
                      <span className="tabular-nums text-slate-500">{Number.isFinite(s.t) ? hm(s.t) : '--:--'}</span>
                      <span className={s.bold ? 'font-semibold text-slate-900' : undefined}>{s.label}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <InfoBar tone="warning">Un rappel arrivé à échéance ne peut pas être ignoré sans justification.</InfoBar>
            </aside>
          </div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Fig. 13 : Rappeler rapidement (mauvais moment) ── */}
      {modal === 'bad_moment' && (
        <OutcomeModal
          {...common}
          title="Rappeler rapidement"
          width="max-w-3xl"
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-500 text-white"><User className="h-5 w-5" /></span>}
          badge={<span className="inline-flex items-center gap-1.5 rounded-lg bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700"><Clock className="h-3.5 w-3.5" /> Mauvais moment</span>}
          footerNote={undefined}
          actions={actions(<>Programmer et continuer <ArrowRight className="h-4 w-4" /></>)}
        >
          <InfoBar>Le client a répondu mais ne peut pas échanger maintenant.<br />Le lead reste actif et prioritaire.</InfoBar>
          <div className="mt-4 grid gap-5 md:grid-cols-[1fr_250px]">
            <div className="space-y-4">
              <div>
                <p className={labelClass}>Quand le rappeler ? <Req /></p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {[...BAD_MOMENT_DELAYS.map((d) => ({ key: d.key as string, label: d.label.replace('Dans ', 'Dans '), minutes: d.minutes as number | null })), { key: 'custom', label: 'Choisir une heure', minutes: null }].map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      aria-pressed={bmDelay === d.key}
                      onClick={() => {
                        setBmDelay(d.key);
                        if (d.minutes !== null) setFromPreset(nowMs + d.minutes * 60_000, (dd, tt) => { setBmDate(dd); setBmTime(tt); });
                      }}
                      className={cn('relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium', bmDelay === d.key ? 'border-teal-500 bg-teal-50/50 text-slate-900' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}
                    >
                      {bmDelay === d.key && <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-teal-500 text-white"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>}
                      <span className={bmDelay === d.key ? 'text-teal-600' : 'text-slate-500'}>{DELAY_ICON[d.key]}</span>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <DateTime id="bm" date={bmDate} time={bmTime} onDate={(v) => { setBmDate(v); setBmDelay('custom'); }} onTime={(v) => { setBmTime(v); setBmDelay('custom'); }} />
              <div>
                <label className={labelClass} htmlFor="bm-reason">Motif <Req /></label>
                <Select<BadMomentReason> id="bm-reason" value={bmReason} onChange={setBmReason} options={BAD_MOMENT_REASONS} placeholder="Choisir un motif" />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(Object.keys(BAD_MOMENT_REASONS) as BadMomentReason[]).filter((k) => k !== 'busy').map((k) => <SmallChip key={k} active={bmReason === k} onClick={() => setBmReason(k)}>{BAD_MOMENT_REASONS[k]}</SmallChip>)}
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="bm-note">Note pour le prochain appel <span className="font-normal text-slate-400">(optionnel)</span></label>
                <textarea id="bm-note" rows={2} maxLength={250} className={fieldClass} placeholder="Ex. : Disponible dans 30 minutes, appel très court." value={bmNote} onChange={(e) => setBmNote(e.target.value)} />
                <Counter value={bmNote} max={250} />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input type="checkbox" checked={bmConfirmed} onChange={(e) => setBmConfirmed(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                Créneau confirmé avec le client
              </label>
            </div>
            <aside className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <p className="text-xs font-semibold text-slate-700">Aperçu de l'action</p>
              <div className="mt-4 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-600"><CalendarClock className="h-5 w-5" /></span>
                <p className="mt-2 text-sm font-semibold text-slate-900">Prochaine action créée</p>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                <Bell className="h-3.5 w-3.5 text-slate-500" />
                <span className="flex-1">Rappel {Number.isFinite(bmBase) ? formatWhen(bmBase, nowMs, rules.schedule.timezone) : '—'}</span>
                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Priorité P1</span>
              </div>
              <p className="mt-3 text-xs text-slate-600">Le prospect reste dans la file active</p>
              <div className="mt-3"><InfoBar tone="warning">Ce statut ne compte pas comme un NR.</InfoBar></div>
            </aside>
          </div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Fig. 8 : Qualifier un prospect intéressé ── */}
      {modal === 'interested' && (
        <OutcomeModal
          {...common}
          title="Qualifier un prospect intéressé"
          width="max-w-2xl"
          badge={<span className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"><Flame className="h-3.5 w-3.5 fill-white" /> Prospect intéressé</span>}
          actions={actions('Enregistrer et programmer')}
        >
          <div>
            <p className={labelClass}>Température du lead <Req /></p>
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Température">
              {TEMPERATURE_CHOICES.map((t) => {
                const Icon = TEMP_ICON[t.key];
                return (
                  <button key={t.key} type="button" role="radio" aria-checked={intTemp === t.key} onClick={() => setIntTemp(t.key)} className={cn('relative flex items-start gap-2.5 rounded-xl border p-3 text-left', intTemp === t.key ? 'border-indigo-400 bg-indigo-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                    <span className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full', TEMP_COLOR[t.key])}><Icon className="h-5 w-5" /></span>
                    <span>
                      <span className={cn('block text-sm font-semibold', intTemp === t.key ? 'text-indigo-700' : 'text-slate-900')}>{t.title}</span>
                      <span className="block text-[11px] leading-tight text-slate-500">{t.hint}</span>
                    </span>
                    <span className={cn('absolute right-2.5 top-2.5 h-3.5 w-3.5 rounded-full border', intTemp === t.key ? 'border-indigo-500 bg-indigo-500 ring-2 ring-white ring-inset' : 'border-slate-300')} />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="int-reason">Motif de non-avancement <Req /></label>
            <Select<InterestReason> id="int-reason" value={intReason} onChange={setIntReason} options={INTEREST_REASONS} placeholder="Choisir un motif" />
          </div>
          <div className="mt-4 space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
            <p className="text-sm font-semibold text-indigo-700">Prochaine action obligatoire</p>
            <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr_0.8fr]">
              <div>
                <label className={labelClass} htmlFor="int-action">Action <Req /></label>
                <Select<InterestNextAction> id="int-action" value={intAction} onChange={setIntAction} options={INTEREST_NEXT_ACTIONS} placeholder="Choisir l'action" />
              </div>
              <div>
                <label className={labelClass} htmlFor="int-d">Date <Req /></label>
                <input id="int-d" type="date" className={fieldClass} value={intDate} onChange={(e) => setIntDate(e.target.value)} />
              </div>
              <div>
                <label className={labelClass} htmlFor="int-t">Heure <Req /></label>
                <input id="int-t" type="time" className={fieldClass} value={intTime} onChange={(e) => setIntTime(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor="int-comment">Commentaire commercial <Req /></label>
              <textarea id="int-comment" rows={3} maxLength={1000} className={fieldClass} placeholder="Ex. : Doit en parler à son épouse ce soir. Très intéressé par PAC + SSC." value={intComment} onChange={(e) => setIntComment(e.target.value)} />
              <Counter value={intComment} max={1000} />
            </div>
            {!intAction && <p className="flex items-center gap-1.5 text-xs font-medium text-red-600"><AlertTriangle className="h-3.5 w-3.5" /> Un prospect intéressé ne peut pas être enregistré sans prochaine action.</p>}
            {preview?.ok && preview.plan.nextAction && (
              <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-white p-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><CalendarClock className="h-5 w-5" /></span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Prochaine action créée</p>
                  <p className="text-xs text-slate-600">{INTEREST_NEXT_ACTIONS[intAction as InterestNextAction]} {formatWhen(preview.plan.nextAction.dueAtMs, nowMs, rules.schedule.timezone)} · <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-700">Priorité P2</span></p>
                </div>
              </div>
            )}
          </div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Clôturer : choix du motif, puis fenêtre dédiée (figs. 10 à 12) ── */}
      {modal === 'close_pick' && (
        <OutcomeModal
          {...common}
          title="Clôturer le lead"
          width="max-w-lg"
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500"><Archive className="h-5 w-5" /></span>}
          actions={<CancelButton onClick={() => open(null)} />}
        >
          <p className={labelClass}>Motif de la clôture <Req /></p>
          <ul className="space-y-2">
            {([
              ['not_interested', 'close_not_interested', <ThumbsDown key="a" className="h-5 w-5" />, 'bg-red-50 text-red-500'],
              ['ineligible', 'close_ineligible', <ShieldX key="b" className="h-5 w-5" />, 'bg-red-50 text-red-500'],
              ['fake_lead', 'close_fake_lead', <XCircle key="c" className="h-5 w-5" />, 'bg-red-50 text-red-500'],
              ['wrong_number', 'close_wrong_number', <PhoneOff key="d" className="h-5 w-5" />, 'bg-slate-100 text-slate-600'],
              ['other', 'close_other', <MoreHorizontal key="e" className="h-5 w-5" />, 'bg-slate-100 text-slate-600'],
            ] as [CloseReason, ModalKey, ReactNode, string][]).map(([r, m, icon, color]) => (
              <li key={r}>
                <button type="button" onClick={() => open(m)} className="flex w-full items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-left hover:border-slate-300 hover:bg-slate-50">
                  <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', color)}>{icon}</span>
                  <span className="text-sm font-semibold text-slate-900">{CLOSE_REASONS[r]}</span>
                  <ArrowRight className="ml-auto h-4 w-4 text-slate-400" />
                </button>
              </li>
            ))}
          </ul>
        </OutcomeModal>
      )}

      {/* ── Fig. 10 : Clôturer comme non intéressé ── */}
      {modal === 'close_not_interested' && (
        <OutcomeModal
          {...common}
          title="Clôturer comme non intéressé"
          width="max-w-2xl"
          icon={<span className="flex h-11 w-11 items-center justify-center rounded-lg border border-red-100 bg-red-50 text-red-500"><ThumbsDown className="h-5 w-5" /></span>}
          actions={actions('Confirmer la clôture', { danger: true })}
        >
          <div>
            <p className={labelClass}>Motif du refus <Req /></p>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="Motif du refus">
              {(Object.keys(REFUSAL_MOTIVES) as RefusalMotive[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={niMotive === k}
                  onClick={() => { setNiMotive(k); if (k === 'no_more_contact') { setNiOpposition(true); setNiFollow('close'); } }}
                  className={cn('relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs font-medium', niMotive === k ? 'border-blue-500 bg-blue-50/50 text-blue-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}
                >
                  {niMotive === k && <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>}
                  <span className={niMotive === k ? 'text-blue-600' : 'text-slate-500'}>{REFUSAL_ICON[k]}</span>
                  {REFUSAL_MOTIVES[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="ni-comment">Commentaire <Req /></label>
            <textarea id="ni-comment" rows={3} maxLength={1000} className={fieldClass} placeholder="Ex. : Le client reporte son projet à l'année prochaine." value={niComment} onChange={(e) => setNiComment(e.target.value)} />
            <Counter value={niComment} max={1000} />
          </div>
          <div className="mt-2">
            <p className="text-sm font-semibold text-slate-900">Suite à donner</p>
            <div className="mt-2 space-y-2">
              {(Object.keys(REFUSAL_FOLLOW_UPS) as RefusalFollowUp[]).map((f) => (
                <label key={f} className={cn('flex items-center gap-2.5 text-sm', f === 'recycle' && niOpposition ? 'text-slate-400' : 'text-slate-800')}>
                  <input type="radio" name="ni-follow" checked={niFollow === f} disabled={f === 'recycle' && niOpposition} onChange={() => setNiFollow(f)} className="h-4 w-4 text-blue-600" />
                  {REFUSAL_FOLLOW_UPS[f]}
                  {f === 'recycle' && (
                    <span className="relative ml-2">
                      <CalendarDays className="pointer-events-none absolute right-2 top-1.5 h-4 w-4 text-slate-400" />
                      <input type="date" aria-label="Date de recyclage" disabled={niFollow !== 'recycle'} className="rounded-lg border border-slate-300 px-2 py-1 pr-8 text-sm disabled:bg-slate-50" value={niDate} onChange={(e) => setNiDate(e.target.value)} />
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
          <label className="mt-4 flex items-start gap-2.5 text-sm text-slate-800">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600" checked={niOpposition} onChange={(e) => { setNiOpposition(e.target.checked); if (e.target.checked) setNiFollow('close'); }} />
            <span>Respecter l'opposition commerciale / ne plus contacter<span className="block text-xs text-slate-500">En cochant cette case, le lead sera placé en opposition commerciale et ne pourra plus recevoir d'appels ni de messages.</span></span>
          </label>
          <div className="mt-4"><InfoBar tone="warning"><span className="font-semibold">Cette action sort le lead de la file active.</span><br />Le motif restera visible dans l'historique et les statistiques.</InfoBar></div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Fig. 11 : Déclarer le lead inéligible ── */}
      {modal === 'close_ineligible' && (
        <OutcomeModal
          {...common}
          title="Déclarer le lead inéligible"
          width="max-w-2xl"
          badge={<span className="inline-flex items-center gap-2"><ShieldX className="h-6 w-6 text-red-500" /><span className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-600">Inéligible</span></span>}
          actions={actions(<><ShieldCheck className="h-4 w-4" /> Confirmer l'inéligibilité</>, { danger: true })}
        >
          <div>
            <p className={labelClass}>Catégorie d'inéligibilité <Req /></p>
            <div className="grid gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="Catégorie">
              {(Object.keys(INELIGIBLE_CATEGORIES) as IneligibleCategory[]).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={ieCategory === c} onClick={() => { setIeCategory(c); setIeMotive(''); }} className={cn('flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-xs font-medium', ieCategory === c ? 'border-blue-500 bg-blue-50/50 text-blue-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
                  <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', ieCategory === c ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500')}>{CATEGORY_ICON[c]}</span>
                  {INELIGIBLE_CATEGORIES[c]}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="ie-motive">Motif précis <Req /></label>
            <select id="ie-motive" className={fieldClass} value={ieMotive} disabled={!ieCategory} onChange={(e) => setIeMotive(e.target.value)}>
              <option value="">{ieCategory ? 'Choisir un motif précis' : "Choisissez d'abord une catégorie"}</option>
              {ieCategory && Object.entries(INELIGIBLE_MOTIVES[ieCategory]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {ieCategory && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(INELIGIBLE_MOTIVES[ieCategory]).map(([k, v]) => <SmallChip key={k} active={ieMotive === k} onClick={() => setIeMotive(k)}>{v}</SmallChip>)}
              </div>
            )}
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="ie-product">Produit concerné <Req /></label>
            <input id="ie-product" className={fieldClass} value={ieProduct} onChange={(e) => setIeProduct(e.target.value)} />
          </div>
          <div className="mt-4">
            <label className={labelClass} htmlFor="ie-justif">Justification <Req /></label>
            <textarea id="ie-justif" rows={3} maxLength={500} className={fieldClass} placeholder="Ex. : Appartement sans emplacement extérieur autorisé pour l'unité." value={ieJustif} onChange={(e) => setIeJustif(e.target.value)} />
            <Counter value={ieJustif} max={500} />
          </div>
          <div className="mt-2 space-y-3">
            <Toggle checked={ieAltOn} onChange={setIeAltOn} label={<span className="font-medium">Proposer une autre solution</span>} />
            {ieAltOn && (
              <div>
                <label className={labelClass} htmlFor="ie-alt">Solution alternative</label>
                <input id="ie-alt" className={fieldClass} placeholder="Ex. : PAC Air/Air" value={ieAlt} onChange={(e) => setIeAlt(e.target.value)} />
              </div>
            )}
          </div>
          <div className="mt-4"><InfoBar>Le lead sort du parcours {ieProduct || 'concerné'} mais peut rester exploitable pour un autre produit.</InfoBar></div>
          {feedback}
        </OutcomeModal>
      )}

      {/* ── Fig. 12 : Signaler un faux lead ── */}
      {modal === 'close_fake_lead' && (
        <OutcomeModal
          {...common}
          title="Signaler un faux lead"
          width="max-w-4xl"
          badge={<span className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600"><XCircle className="h-5 w-5" /> Faux lead</span>}
          actions={actions(<>Signaler le faux lead</>, { danger: true })}
        >
          <InfoBar tone="danger">Ce statut impacte les statistiques de qualité et de facturation de la campagne.</InfoBar>
          <div className="mt-4 grid gap-5 md:grid-cols-[1fr_250px]">
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-900">1. Motif du faux lead <Req /></p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="Motif du faux lead">
                {(Object.keys(FAKE_LEAD_MOTIVES) as FakeLeadMotive[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={flMotive === k} onClick={() => setFlMotive(k)} className={cn('relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs font-medium', flMotive === k ? 'border-red-400 bg-red-50/60 text-red-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
                    <span className={cn('absolute right-1.5 top-1.5 h-3.5 w-3.5 rounded-full border', flMotive === k ? 'border-red-500 bg-red-500 ring-2 ring-white ring-inset' : 'border-slate-300')} />
                    <span className={flMotive === k ? 'text-red-500' : 'text-slate-500'}>{FAKE_ICON[k]}</span>
                    {FAKE_LEAD_MOTIVES[k]}
                  </button>
                ))}
              </div>
              <p className="mb-2 mt-5 text-sm font-semibold text-slate-900">2. Commentaire / constat <Req /></p>
              <textarea aria-label="Commentaire / constat" rows={3} maxLength={1000} className={fieldClass} placeholder="Ex. : Le correspondant confirme ne jamais avoir demandé d'étude énergétique." value={flComment} onChange={(e) => setFlComment(e.target.value)} />
              <Counter value={flComment} max={1000} />
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-800">
                <input type="checkbox" checked={flManager} onChange={(e) => setFlManager(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                Demander une vérification manager
              </label>
            </div>
            <aside className="h-fit rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ShieldCheck className="h-4 w-4 text-slate-500" /> Vérifications CRM</p>
              <dl className="mt-3 space-y-2 text-xs">
                {[
                  { k: 'Format du numéro', v: /^\+33[1-9]\d{8}$/.test(lead.phone ?? '') ? 'Valide' : lead.phone ? 'Non standard' : 'Absent', good: /^\+33[1-9]\d{8}$/.test(lead.phone ?? '') },
                  { k: 'Doublon détecté', v: lead.duplicate ? 'Oui' : 'Non', good: !lead.duplicate },
                ].map((r) => (
                  <div key={r.k} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <dt className="text-slate-600">{r.k}</dt>
                    <dd className={cn('rounded-full px-2 py-0.5 font-semibold', r.good ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>{r.v}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
          <div className="mt-4"><InfoBar>Le lead sera retiré de la file mais conservé pour l'analyse de la campagne.</InfoBar></div>
          {feedback}
        </OutcomeModal>
      )}

      {modal === 'close_wrong_number' && (
        <OutcomeModal
          {...common}
          title="Mauvais numéro"
          width="max-w-lg"
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><PhoneOff className="h-5 w-5" /></span>}
          actions={actions('Confirmer', { danger: true })}
        >
          <InfoBar>Le numéro ne correspond pas au client. Le lead sera retiré de votre file et signalé à la qualité de la campagne.</InfoBar>
          <div className="mt-4">
            <label className={labelClass} htmlFor="wrong-comment">Commentaire <span className="font-normal text-slate-400">(optionnel)</span></label>
            <textarea id="wrong-comment" rows={2} maxLength={500} className={fieldClass} value={wrongComment} onChange={(e) => setWrongComment(e.target.value)} />
          </div>
          {feedback}
        </OutcomeModal>
      )}

      {modal === 'close_other' && (
        <OutcomeModal
          {...common}
          title="Clôturer le lead"
          width="max-w-lg"
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><MoreHorizontal className="h-5 w-5" /></span>}
          actions={actions('Confirmer la clôture', { danger: true })}
        >
          <label className={labelClass} htmlFor="other-comment">Commentaire <Req /></label>
          <textarea id="other-comment" rows={3} maxLength={1000} className={fieldClass} value={otherComment} onChange={(e) => setOtherComment(e.target.value)} />
          <Counter value={otherComment} max={1000} />
          <div className="mt-3"><InfoBar tone="warning">Cette action sort le lead de la file active. Le motif reste visible dans l'historique.</InfoBar></div>
          {feedback}
        </OutcomeModal>
      )}
    </div>
  );
}
