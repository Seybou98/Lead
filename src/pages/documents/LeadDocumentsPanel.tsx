import { useRef, useState } from 'react';
import { getDownloadURL, ref } from 'firebase/storage';
import { AlertTriangle, Check, CheckCircle2, Clock, ExternalLink, FileText, Hammer, Paperclip, RefreshCw, Send, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { storage } from '../../lib/firebase';
import { type DocumentKoReason, type DocumentStatus, type LeadStatus } from '../../domain/enums';
import { DOCUMENT_CHANNELS } from '../../domain/call/outcomes';
import { DOCUMENT_STATUS_LABELS, documentLabel, koLabel, summarizeDocuments, type DocRow } from '../../domain/documents/plan';
import { checkFile, sendDocumentAction, uploadDocumentFile } from '../../lib/documentsApi';
import { DecisionModal, FollowUpModal } from './DocumentModals';
import { useLeadPieces, type PieceView } from './useLeadPieces';
import { useSettings } from '../settings/useSettings';

const STATUS_STYLE: Record<DocumentStatus, string> = {
  expected: 'bg-slate-100 text-slate-600',
  received: 'bg-blue-50 text-blue-700',
  conform: 'bg-emerald-50 text-emerald-700',
  non_conform: 'bg-red-50 text-red-700',
  to_reask: 'bg-amber-50 text-amber-700',
};

const when = (ms: number) => new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Progress({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold text-slate-900">{value}/{total}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Onglet Documents de la fiche (§10, §25.6) : checklist, progression (reçues/attendues et conformes/obligatoires),
 * dépôt, contrôle pièce par pièce, relance, décision à J+14 et passage au montage. Chaque geste passe par la
 * fonction serveur : le navigateur n'écrit jamais lui-même une pièce ni le statut du lead.
 */
export function LeadDocumentsPanel({
  leadId,
  firstName,
  leadStatus,
  nextActionType,
  canAct,
  openFollowUp,
  onFollowUpClosed,
}: {
  leadId: string;
  firstName: string;
  leadStatus: LeadStatus;
  nextActionType: string | null;
  canAct: boolean;
  /** true : ouvre d'emblée la fenêtre de relance (bouton « Relancer maintenant » de la prochaine action). */
  openFollowUp?: boolean;
  onFollowUpClosed?: () => void;
}) {
  const { loading, error, pieces } = useLeadPieces(leadId);
  const [follow, setFollow] = useState(false);
  const [decide, setDecide] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const { reasonCatalog } = useSettings();
  const koReasons = reasonCatalog.active.document_ko;
  const commentRequired = reasonCatalog.commentRequired.document_ko;
  const [koReasonChoice, setKoReason] = useState<DocumentKoReason>('unreadable');
  // Le motif choisi doit exister dans la liste active ; sinon on retombe sur le premier.
  const koReason = koReasons[koReasonChoice] ? koReasonChoice : (Object.keys(koReasons)[0] ?? 'other');
  const [koComment, setKoComment] = useState('');
  const [channel, setChannel] = useState<keyof typeof DOCUMENT_CHANNELS>('whatsapp');

  const rows: DocRow[] = pieces.map((p) => ({ code: p.code, label: p.label, mandatory: p.mandatory, status: p.status, koReason: p.koReason, koReasonLabel: p.koReasonLabel }));
  const summary = summarizeDocuments(rows);
  const showFollow = follow || openFollowUp === true;
  const closeFollow = () => {
    setFollow(false);
    onFollowUpClosed?.();
  };

  const ok = (text: string) => setNotice({ kind: 'ok', text });
  const fail = (text: string) => setNotice({ kind: 'error', text });
  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fn();
      if (r.ok) ok(r.message);
      else fail(r.message);
      return r.ok;
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Action impossible.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const markReceived = (code: string) => run(`rcv_${code}`, () => sendDocumentAction(leadId, { kind: 'receive', code, channel }));
  const upload = (code: string, file: File) =>
    run(`up_${code}`, async () => {
      const meta = await uploadDocumentFile(leadId, code, file);
      return sendDocumentAction(leadId, { kind: 'receive', code, file: meta });
    });
  const check = (code: string, verdict: 'conform' | 'non_conform') =>
    run(`chk_${code}`, () => sendDocumentAction(leadId, { kind: 'check', code, verdict, ...(verdict === 'non_conform' ? { koReason, comment: koComment.trim() || undefined } : {}) })).then((done) => {
      if (done) {
        setRejecting(null);
        setKoComment('');
      }
    });
  const reask = (code: string) => run(`rsk_${code}`, () => sendDocumentAction(leadId, { kind: 'reask', code }));
  const startBuilding = () => run('build', () => sendDocumentAction(leadId, { kind: 'start_building' }));

  const open = async (p: PieceView) => {
    if (!p.file) return;
    try {
      window.open(await getDownloadURL(ref(storage, p.file.storagePath)), '_blank', 'noopener');
    } catch {
      fail("Impossible d'ouvrir le fichier (droits ou fichier introuvable).");
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Chargement des documents…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700">Lecture des documents refusée ou indisponible.</p>;
  if (pieces.length === 0) {
    return <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">Aucun document n&apos;a été demandé pour ce lead. La demande se fait à la fin d&apos;un appel, avec le résultat « Demander les documents ».</p>;
  }

  const active = leadStatus === 'awaiting_documents' || leadStatus === 'missing_info' || leadStatus === 'file_ready_to_build';
  const hasMissing = rows.some((r) => r.status === 'expected' || r.status === 'non_conform' || r.status === 'to_reask');
  const decisionDue = nextActionType === 'document_decision';

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Progress label="Pièces reçues" value={summary.received} total={summary.expected} tone="bg-blue-500" />
        <Progress label="Obligatoires conformes" value={summary.mandatoryConform} total={summary.mandatory} tone="bg-emerald-500" />
      </div>

      {decisionDue && canAct && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Documents toujours incomplets : une décision est obligatoire.</span>
          <button type="button" onClick={() => setDecide(true)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">Décider</button>
        </div>
      )}

      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />}
          {notice.text}
        </p>
      )}

      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {pieces
          .slice()
          .sort((a, b) => Number(b.mandatory) - Number(a.mandatory))
          .map((p) => (
            <PieceRow
              key={p.code}
              piece={p}
              canAct={canAct && active}
              busy={busy}
              channel={channel}
              onChannel={setChannel}
              rejecting={rejecting === p.code}
              koReason={koReason}
              koReasons={koReasons}
              koCommentRequired={commentRequired.includes(koReason)}
              koComment={koComment}
              onKoReason={setKoReason}
              onKoComment={setKoComment}
              onReject={() => setRejecting(p.code)}
              onCancelReject={() => setRejecting(null)}
              onMarkReceived={() => markReceived(p.code)}
              onUpload={(f) => upload(p.code, f)}
              onCheck={(v) => check(p.code, v)}
              onReask={() => reask(p.code)}
              onOpen={() => open(p)}
              onRefuseFile={(msg) => fail(msg)}
            />
          ))}
      </ul>

      {canAct && active && (
        <div className="flex flex-wrap items-center gap-3">
          {hasMissing && (
            <button type="button" onClick={() => setFollow(true)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
              <Send className="h-4 w-4" /> Relancer le client
            </button>
          )}
          {leadStatus === 'file_ready_to_build' && (
            <button type="button" disabled={busy === 'build'} onClick={startBuilding} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
              <Hammer className="h-4 w-4" /> Passer au montage
            </button>
          )}
          {decisionDue ? null : hasMissing && (
            <button type="button" onClick={() => setDecide(true)} className="text-sm text-slate-500 underline">Décider du sort du dossier</button>
          )}
        </div>
      )}

      {showFollow && (
        <FollowUpModal
          leadId={leadId}
          firstName={firstName}
          rows={rows}
          onClose={closeFollow}
          onDone={(m) => {
            closeFollow();
            ok(m);
          }}
        />
      )}
      {decide && (
        <DecisionModal
          leadId={leadId}
          onClose={() => setDecide(false)}
          onDone={(m) => {
            setDecide(false);
            ok(m);
          }}
        />
      )}
    </div>
  );
}

function PieceRow(props: {
  piece: PieceView;
  canAct: boolean;
  busy: string | null;
  channel: keyof typeof DOCUMENT_CHANNELS;
  onChannel: (c: keyof typeof DOCUMENT_CHANNELS) => void;
  rejecting: boolean;
  koReason: DocumentKoReason;
  koReasons: Record<string, string>;
  koCommentRequired: boolean;
  koComment: string;
  onKoReason: (r: DocumentKoReason) => void;
  onKoComment: (v: string) => void;
  onReject: () => void;
  onCancelReject: () => void;
  onMarkReceived: () => void;
  onUpload: (f: File) => void;
  onCheck: (v: 'conform' | 'non_conform') => void;
  onReask: () => void;
  onOpen: () => void;
  onRefuseFile: (message: string) => void;
}) {
  const { piece: p, canAct, busy } = props;
  const input = useRef<HTMLInputElement>(null);
  const working = busy !== null && busy.endsWith(`_${p.code}`);
  const pick = (f: File | undefined) => {
    if (!f) return;
    const problem = checkFile(f);
    if (problem) props.onRefuseFile(problem);
    else props.onUpload(f);
    if (input.current) input.current.value = '';
  };
  const Icon = p.status === 'conform' ? Check : p.status === 'non_conform' ? X : p.status === 'received' ? FileText : p.status === 'to_reask' ? RefreshCw : Clock;
  const canProvide = p.status === 'expected' || p.status === 'to_reask' || p.status === 'non_conform' || p.status === 'conform' || p.status === 'received';

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full', STATUS_STYLE[p.status])}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">
            {documentLabel(p.code, p.label)}
            {p.mandatory && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Obligatoire</span>}
          </p>
          <p className="text-xs text-slate-500">
            {p.receivedAtMs !== null && <>Reçu le {when(p.receivedAtMs)}{p.channel ? ` · ${p.channel === 'upload' ? 'Dépôt' : (DOCUMENT_CHANNELS as Record<string, string>)[p.channel] ?? p.channel}` : ''}</>}
            {p.receivedAtMs === null && 'Pas encore reçu'}
            {p.koReason && <span className="text-red-600"> · {koLabel(p)}{p.koComment ? ` — ${p.koComment}` : ''}</span>}
          </p>
          {p.file && (
            <button type="button" onClick={props.onOpen} className="mt-0.5 inline-flex items-center gap-1 text-xs text-blue-700 hover:underline">
              <Paperclip className="h-3 w-3" /> {p.file.originalName} <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', STATUS_STYLE[p.status])}>{DOCUMENT_STATUS_LABELS[p.status]}</span>
      </div>

      {canAct && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-11">
          {p.status === 'received' && !props.rejecting && (
            <>
              <button type="button" disabled={working} onClick={() => props.onCheck('conform')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">Conforme</button>
              <button type="button" disabled={working} onClick={props.onReject} className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60">Non conforme</button>
            </>
          )}
          {p.status === 'non_conform' && (
            <button type="button" disabled={working} onClick={props.onReask} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-60">À redemander</button>
          )}
          {canProvide && !props.rejecting && (
            <>
              <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic" className="hidden" aria-label={`Fichier : ${documentLabel(p.code, p.label)}`} onChange={(e) => pick(e.target.files?.[0])} />
              <button type="button" disabled={working} onClick={() => input.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">
                <Paperclip className="h-3.5 w-3.5" /> {p.status === 'expected' || p.status === 'to_reask' ? 'Joindre un fichier' : 'Remplacer le fichier'}
              </button>
              {(p.status === 'expected' || p.status === 'to_reask') && (
                <span className="inline-flex items-center gap-1.5">
                  <select aria-label="Canal de réception" value={props.channel} onChange={(e) => props.onChannel(e.target.value as keyof typeof DOCUMENT_CHANNELS)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">
                    {(Object.keys(DOCUMENT_CHANNELS) as (keyof typeof DOCUMENT_CHANNELS)[]).map((k) => (
                      <option key={k} value={k}>{DOCUMENT_CHANNELS[k]}</option>
                    ))}
                  </select>
                  <button type="button" disabled={working} onClick={props.onMarkReceived} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Marquer comme reçu</button>
                </span>
              )}
            </>
          )}
          {working && <span className="text-xs text-slate-500">Enregistrement…</span>}
        </div>
      )}

      {props.rejecting && (
        <div className="mt-2.5 space-y-2 rounded-lg bg-red-50/60 p-3 pl-4">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Motif de non-conformité" value={props.koReason} onChange={(e) => props.onKoReason(e.target.value as DocumentKoReason)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
              {Object.entries(props.koReasons).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <input aria-label="Commentaire" value={props.koComment} maxLength={300} onChange={(e) => props.onKoComment(e.target.value)} placeholder={props.koCommentRequired ? 'Précisez (obligatoire)' : 'Commentaire (facultatif)'} className="min-w-[200px] flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={working} onClick={() => props.onCheck('non_conform')} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60">Confirmer : non conforme</button>
            <button type="button" onClick={props.onCancelReject} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">Annuler</button>
          </div>
        </div>
      )}
    </li>
  );
}
