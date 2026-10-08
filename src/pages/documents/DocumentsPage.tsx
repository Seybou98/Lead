import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, FileCheck2, FileText, Info, Replace, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import type { LeadListItem } from '../../domain/leads/leadList';
import { buildBoard, checkCard, completeCard, NO_BOARD_FILTERS, productsOf, relaunchCard, type BoardFilters } from '../../domain/documents/board';
import type { DocRow } from '../../domain/documents/plan';
import { sendDocumentAction } from '../../lib/documentsApi';
import { useLeadsList, useNow } from '../leads/useLeadsData';
import { FollowUpModal } from './DocumentModals';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

type Tone = 'orange' | 'blue' | 'green';
const TONE: Record<Tone, { column: string; head: string; dot: string; avatar: string; kpi: string; kpiIcon: string; kpiNumber: string }> = {
  orange: { column: 'border-orange-100 bg-orange-50/50', head: 'text-orange-700', dot: 'bg-orange-500', avatar: 'bg-orange-100 text-orange-700', kpi: 'border-l-orange-400', kpiIcon: 'bg-orange-100 text-orange-600', kpiNumber: 'text-orange-600' },
  blue: { column: 'border-blue-100 bg-blue-50/50', head: 'text-blue-700', dot: 'bg-blue-500', avatar: 'bg-blue-100 text-blue-700', kpi: 'border-l-blue-400', kpiIcon: 'bg-blue-100 text-blue-600', kpiNumber: 'text-blue-600' },
  green: { column: 'border-emerald-100 bg-emerald-50/50', head: 'text-emerald-700', dot: 'bg-emerald-500', avatar: 'bg-emerald-100 text-emerald-700', kpi: 'border-l-emerald-400', kpiIcon: 'bg-emerald-100 text-emerald-600', kpiNumber: 'text-emerald-600' },
};

function Kpi({ tone, icon, value, label }: { tone: Tone; icon: React.ReactNode; value: number; label: string }) {
  const t = TONE[tone];
  return (
    <div className={cn('flex items-center gap-4 rounded-xl border border-slate-200 border-l-4 bg-white px-5 py-4', t.kpi)}>
      <span className={cn('flex h-11 w-11 items-center justify-center rounded-full', t.kpiIcon)}>{icon}</span>
      <div>
        <p className={cn('text-2xl font-bold leading-none', t.kpiNumber)}>{value}</p>
        <p className="mt-1 text-sm text-slate-600">{label}</p>
      </div>
    </div>
  );
}

function CardShell({ tone, lead, timing, onOpen, children, action }: { tone: Tone; lead: LeadListItem; timing: string; onOpen: () => void; children: React.ReactNode; action: React.ReactNode }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', TONE[tone].avatar)}>{initials(lead.fullName)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 text-left">
              <span className="block truncate text-sm font-semibold text-slate-900 hover:underline">{lead.fullName || 'Sans nom'}</span>
              <span className="block truncate text-xs text-slate-500">{lead.productCode ?? 'Produit non renseigné'}</span>
            </button>
            {timing && (
              <span className="inline-flex flex-shrink-0 items-center gap-1 text-[11px] text-slate-500">
                <Clock className="h-3 w-3" /> {timing}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="min-w-0 flex-1">{children}</div>
            {action}
          </div>
        </div>
      </div>
    </li>
  );
}

const btn = 'flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-blue-700 disabled:opacity-50';

export function DocumentsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const data = useLeadsList(user?.role ?? 'telepro', user?.uid ?? '');
  const base = user?.role === 'telepro' ? '/mes-leads' : '/leads';
  return (
    <DocumentsView
      items={data.items}
      loading={data.loading}
      error={data.error}
      uid={user?.uid ?? ''}
      role={user?.role ?? 'telepro'}
      onOpen={(id, tab) => navigate(`${base}/${id}${tab === 'documents' ? '?onglet=documents' : ''}`)}
    />
  );
}

export function DocumentsView({
  items,
  loading,
  error,
  uid,
  role,
  onOpen,
  nowOverride,
}: {
  items: LeadListItem[];
  loading: boolean;
  error: string | null;
  uid: string;
  role: Role;
  onOpen: (leadId: string, tab?: 'documents') => void;
  nowOverride?: number;
}) {
  const live = useNow(30_000);
  const now = nowOverride ?? live;
  const [filters, setFilters] = useState<BoardFilters>(NO_BOARD_FILTERS);
  const [follow, setFollow] = useState<LeadListItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const board = useMemo(() => buildBoard(items, filters, uid, now), [items, filters, uid, now]);
  const products = useMemo(() => productsOf(items), [items]);
  const mayAct = (l: LeadListItem) => role === 'admin' || role === 'manager' || l.ownerId === uid;

  const startBuilding = async (l: LeadListItem) => {
    setBusy(l.id);
    setNotice(null);
    const r = await sendDocumentAction(l.id, { kind: 'start_building' });
    setBusy(null);
    setNotice({ kind: r.ok ? 'ok' : 'error', text: r.ok ? `${l.fullName} : ${r.message}` : r.message });
  };

  const followRows: DocRow[] = follow ? (follow.docs?.missing ?? []).map((m) => ({ code: m.code, label: m.label, mandatory: true, status: m.status, koReason: m.koReason })) : [];
  const select = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

  return (
    <div className="w-full">
      <h1 className="text-2xl font-bold text-slate-900">Documents</h1>
      <p className="mt-1 text-slate-500">Suivez uniquement les dossiers qui demandent une action.</p>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <Kpi tone="orange" icon={<FileText className="h-5 w-5" />} value={board.relaunch.length} label="à relancer" />
        <Kpi tone="blue" icon={<FileCheck2 className="h-5 w-5" />} value={board.check.length} label="à contrôler" />
        <Kpi tone="green" icon={<CheckCircle2 className="h-5 w-5" />} value={board.completeToday} label="complets aujourd'hui" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label="Rechercher un client"
            placeholder="Rechercher un client"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <select aria-label="Produit" className={select} value={filters.product} onChange={(e) => setFilters((f) => ({ ...f, product: e.target.value }))}>
          <option value="">Produit</option>
          {products.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select aria-label="Ancienneté" className={select} value={filters.order} onChange={(e) => setFilters((f) => ({ ...f, order: e.target.value as BoardFilters['order'] }))}>
          <option value="oldest">Ancienneté : plus anciens d&apos;abord</option>
          <option value="newest">Ancienneté : plus récents d&apos;abord</option>
        </select>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <button
            type="button"
            role="switch"
            aria-checked={filters.mineOnly}
            aria-label="Mes dossiers uniquement"
            onClick={() => setFilters((f) => ({ ...f, mineOnly: !f.mineOnly }))}
            className={cn('relative h-6 w-11 rounded-full transition-colors', filters.mineOnly ? 'bg-blue-600' : 'bg-slate-300')}
          >
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', filters.mineOnly ? 'left-[22px]' : 'left-0.5')} />
          </button>
          Mes dossiers uniquement
        </label>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mt-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm', notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {notice.text}
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Column tone="orange" title="À relancer" count={board.relaunch.length} loading={loading} empty="Aucun dossier à relancer.">
          {board.relaunch.map((l) => {
            const c = relaunchCard(l, now);
            return (
              <CardShell
                key={l.id}
                tone="orange"
                lead={l}
                timing={c.timing}
                onOpen={() => onOpen(l.id, 'documents')}
                action={
                  <button type="button" className={btn} disabled={!mayAct(l)} onClick={() => setFollow(l)}>
                    {c.reask ? 'Redémander' : 'Relancer'}
                  </button>
                }
              >
                <p className="text-xs font-semibold text-red-600">{c.headline}</p>
                {c.detail && <p className="text-[11px] text-slate-500">{c.detail}</p>}
                {c.chips.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {c.chips.map((chip) => (
                      <span key={chip} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{chip}</span>
                    ))}
                  </div>
                )}
              </CardShell>
            );
          })}
        </Column>

        <Column tone="blue" title="À contrôler" count={board.check.length} loading={loading} empty="Aucune pièce à contrôler.">
          {board.check.map((l) => {
            const c = checkCard(l, now);
            return (
              <CardShell
                key={l.id}
                tone="blue"
                lead={l}
                timing={c.timing}
                onOpen={() => onOpen(l.id, 'documents')}
                action={
                  <button type="button" className={btn} disabled={!mayAct(l)} onClick={() => onOpen(l.id, 'documents')}>
                    Contrôler
                  </button>
                }
              >
                <p className={cn('inline-flex items-center gap-1.5 text-xs font-medium', c.allReceived ? 'text-emerald-700' : 'text-blue-700')}>
                  {c.allReceived ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Replace className="h-3.5 w-3.5" />} {c.headline}
                </p>
              </CardShell>
            );
          })}
        </Column>

        <Column tone="green" title="Complets" count={board.complete.length} loading={loading} empty="Aucun dossier complet pour l'instant.">
          {board.complete.map((l) => {
            const c = completeCard(l, now);
            return (
              <CardShell
                key={l.id}
                tone="green"
                lead={l}
                timing={c.timing}
                onOpen={() => onOpen(l.id, 'documents')}
                action={
                  c.ready ? (
                    <button type="button" className={btn} disabled={!mayAct(l) || busy === l.id} onClick={() => startBuilding(l)}>
                      Passer au montage
                    </button>
                  ) : (
                    <button type="button" className={btn} onClick={() => onOpen(l.id)}>
                      Ouvrir
                    </button>
                  )
                }
              >
                <p className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {c.headline}
                </p>
              </CardShell>
            );
          })}
        </Column>
      </div>

      <p className="mt-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
        <Info className="h-4 w-4 text-blue-500" /> Les relances s&apos;arrêtent automatiquement dès réception des pièces attendues.
      </p>

      {follow && (
        <FollowUpModal
          leadId={follow.id}
          firstName={follow.fullName.split(/\s+/)[0] ?? ''}
          rows={followRows}
          onClose={() => setFollow(null)}
          onDone={(m) => {
            setNotice({ kind: 'ok', text: `${follow.fullName} : ${m}` });
            setFollow(null);
          }}
        />
      )}
    </div>
  );
}

function Column({ tone, title, count, loading, empty, children }: { tone: Tone; title: string; count: number; loading: boolean; empty: string; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <section className={cn('rounded-xl border p-3', t.column)} aria-label={title}>
      <h2 className={cn('flex items-center gap-2 px-1 pb-3 text-xs font-bold uppercase tracking-wide', t.head)}>
        <span className={cn('h-2.5 w-2.5 rounded-full', t.dot)} /> {title} ({count})
      </h2>
      <ul className="space-y-3">{children}</ul>
      {count === 0 && <p className="px-1 py-6 text-center text-sm text-slate-500">{loading ? 'Chargement…' : empty}</p>}
    </section>
  );
}
