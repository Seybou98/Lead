import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, CheckCircle2, Copy, CreditCard, FileSignature, FileText, FolderOpen, Info, Landmark, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { formatEuros } from '../../domain/conversion/finance';
import { buildLeadRows, type LeadRow } from '../../domain/leads/leadList';
import {
  AGE_FILTER_LABELS,
  buildSaleBoard,
  FINANCIAL_STATES,
  PAYMENT_FILTER_LABELS,
  SALE_COLUMNS,
  SIGNATURE_STATES,
  saleColumn,
  saleProducts,
  type AgeFilter,
  type PaymentFilter,
  type SaleColumn,
  type Tone,
} from '../../domain/sales/board';
import { buildSaleReminderMessage } from '../../domain/sales/track';
import { sendConversionAction } from '../../lib/conversionApi';
import { Modal } from '../../components/ui/Modal';
import { Feedback } from '../settings/settingsUi';
import { LEAD_LIST_LIMIT, useLeadsList, useNow } from '../leads/useLeadsData';

const PILL: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  grey: 'bg-slate-100 text-slate-600',
};

const COLUMN_STYLE: Record<SaleColumn, { head: string; icon: React.ReactNode }> = {
  to_sign: { head: 'border-orange-300 text-orange-600', icon: <FileSignature className="h-4 w-4" /> },
  to_secure: { head: 'border-blue-300 text-blue-600', icon: <Landmark className="h-4 w-4" /> },
  secured: { head: 'border-emerald-300 text-emerald-600', icon: <CheckCircle2 className="h-4 w-4" /> },
};

const SELECT = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

function Kpi({ icon, value, label, tone }: { icon: React.ReactNode; value: number; label: string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
      <div><p className="text-2xl font-bold leading-none text-slate-900">{value}</p><p className="mt-1 text-sm text-slate-600">{label}</p></div>
    </div>
  );
}

function StateRow({ icon, label, text, tone }: { icon: React.ReactNode; label: string; text: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-slate-500">{icon}{label}</span>
      <span className={cn('rounded-full px-2 py-0.5 font-medium', PILL[tone])}>{text}</span>
    </div>
  );
}

function SaleCard({ r, column, nowMs, canRemind, onOpen, onRemind }: { r: LeadRow; column: SaleColumn; nowMs: number; canRemind: boolean; onOpen: () => void; onRemind: () => void }) {
  const sig = SIGNATURE_STATES[r.commercialState ?? 'none'] ?? SIGNATURE_STATES.none;
  const fin = FINANCIAL_STATES[r.financialState ?? 'none'] ?? FINANCIAL_STATES.none;
  const d = r.docs;
  const transmitted = r.conversion?.state === 'confirmed';
  const t = r.saleTrack;
  const remindable = canRemind && column !== 'secured';
  // « Relancer » (offre à signer) et « Voir le suivi » (à sécuriser) comme sur la maquette ; une vente sécurisée s'ouvre.
  const label = column === 'to_sign' ? 'Relancer' : column === 'to_secure' ? 'Voir le suivi' : 'Ouvrir';
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{r.fullName || 'Contact sans nom'}</p>
          <p className="truncate text-xs text-slate-500">{r.productCode ?? 'Produit non renseigné'}{r.financialState === 'financing_in_progress' && t?.financingOrganism ? ` · ${t.financingOrganism}` : ''}</p>
        </div>
        <p className="whitespace-nowrap text-sm font-bold tabular-nums text-slate-900">{r.montage?.totalTtcCents ? `${formatEuros(r.montage.totalTtcCents)} TTC` : '—'}</p>
      </div>
      <div className="mt-3 space-y-1.5">
        <StateRow icon={<FileText className="h-3.5 w-3.5" />} label="Signature" text={sig.label} tone={sig.tone} />
        <StateRow icon={<CreditCard className="h-3.5 w-3.5" />} label="Paiement / financement" text={r.financialState === 'deposit_expected' && t?.depositCents ? `Acompte de ${formatEuros(t.depositCents)} attendu` : fin.label} tone={fin.tone} />
        <StateRow
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          label="Documents"
          text={d && d.mandatory > 0 ? `${d.mandatoryConform}/${d.mandatory} ${transmitted ? 'transmis' : 'conformes'}` : '—'}
          tone={d && d.mandatory > 0 && d.mandatoryConform === d.mandatory ? (transmitted ? 'green' : 'blue') : 'grey'}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-slate-400">
          {t && t.reminderCount > 0 && t.lastReminderAtMs ? `Relancé il y a ${sinceLabel(t.lastReminderAtMs, nowMs)} (${t.reminderCount})` : `${r.conversion?.clientId ? `Dossier n° ${r.conversion.clientId} · ` : ''}depuis ${sinceLabel(r.montage?.updatedAtMs ?? r.receivedAtMs, nowMs)}`}
        </span>
        <button type="button" onClick={column === 'to_sign' && remindable ? onRemind : onOpen} className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-blue-700">{column === 'to_sign' && !remindable ? 'Ouvrir' : label}</button>
      </div>
    </li>
  );
}

/** Relance : le CRM n'envoie rien (pas de canal e-mail ou SMS en V1). Il prépare le message, le télépro l'envoie puis l'enregistre. */
function ReminderModal({ r, column, onClose, onDone }: { r: LeadRow; column: SaleColumn; onClose: () => void; onDone: (message: string) => void }) {
  const message = useMemo(
    () => buildSaleReminderMessage({ firstName: (r.fullName.split(/\s+/)[0] ?? '').trim(), product: r.productCode, totalTtcCents: r.montage?.totalTtcCents ?? null, stage: column === 'to_sign' ? 'to_sign' : 'to_secure', financialState: r.financialState ?? 'none' }),
    [r, column]
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setError('Copie impossible : sélectionnez le texte et copiez-le à la main.');
    }
  };
  const done = async () => {
    setBusy(true);
    setError(null);
    const res = await sendConversionAction(r.id, { kind: 'sale_action', action: { kind: 'reminder' } });
    setBusy(false);
    if (res.ok) return onDone(res.message);
    setError(res.message);
  };
  return (
    <Modal
      title={`Relancer ${r.fullName || 'le client'}`}
      onClose={onClose}
      busy={busy}
      width="max-w-lg"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Fermer</button>
          <button type="button" onClick={() => void done()} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Enregistrement…' : "J'ai relancé"}</button>
        </>
      }
    >
      <p className="text-sm text-slate-600">Message prêt à envoyer au client ({r.phone ?? r.email ?? 'coordonnées au dossier'}). Envoyez-le par votre canal habituel, puis cliquez sur « J&apos;ai relancé » pour garder la trace.</p>
      <textarea readOnly value={message} aria-label="Message de relance" className="mt-3 min-h-40 w-full rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800" />
      <button type="button" onClick={() => void copy()} className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline"><Copy className="h-4 w-4" /> {copied ? 'Copié' : 'Copier le message'}</button>
      <Feedback errors={[]} notice={error ? { kind: 'error', text: error } : null} />
    </Modal>
  );
}

/**
 * Espace Ventes (§25.7, fig. 39) : À signer, À sécuriser, Sécurisées (celles du mois). Une vente n'est sécurisée qu'après
 * signature et confirmation du paiement ou de l'acceptation du financement. Signature électronique, règlement et
 * financement se font hors du CRM : l'équipe enregistre chaque étape depuis la fiche du dossier.
 */
export function SalesPage() {
  const { user } = useAuth();
  const nowMs = useNow(60_000);
  const data = useLeadsList(user?.role ?? 'telepro', user?.uid ?? '');
  const rows = useMemo(() => buildLeadRows(data.items, data.names), [data.items, data.names]);
  return <SalesView rows={rows} loading={data.loading} error={data.error} truncated={data.truncated} uid={user?.uid ?? ''} role={user?.role ?? 'telepro'} nowMs={nowMs} />;
}

export function SalesView({ rows, loading, error, truncated, uid, role, nowMs }: { rows: LeadRow[]; loading: boolean; error: string | null; truncated: boolean; uid: string; role: 'admin' | 'manager' | 'telepro'; nowMs: number }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState('');
  const [payment, setPayment] = useState<PaymentFilter>('');
  const [age, setAge] = useState<AgeFilter>('');
  const [mineOnly, setMineOnly] = useState(role === 'telepro');
  const [reminder, setReminder] = useState<{ row: LeadRow; column: SaleColumn } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const products = useMemo(() => saleProducts(rows), [rows]);
  const board = useMemo(() => buildSaleBoard(rows, { search, product, payment, age, mineOnly, uid, nowMs }), [rows, search, product, payment, age, mineOnly, uid, nowMs]);
  const filtered = !!(search || product || payment || age || mineOnly);
  const empty = SALE_COLUMNS.every((c) => board.columns[c.key].length === 0);
  // Relancer : le propriétaire de la vente, son manager ou un administrateur ; la liste d'un manager est déjà bornée à son périmètre.
  const canRemind = (r: LeadRow) => role === 'admin' || role === 'manager' || r.ownerId === uid;

  return (
    <div className="w-full">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Ventes</h1>
        <p className="mt-1 text-sm text-slate-600">Suivez les actions nécessaires jusqu&apos;à la sécurisation de la vente.</p>
      </header>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<FileSignature className="h-5 w-5" />} value={board.kpis.toSign} label="offres à signer" tone="bg-orange-100 text-orange-600" />
        <Kpi icon={<Banknote className="h-5 w-5" />} value={board.kpis.paymentsPending} label="paiements en attente" tone="bg-amber-100 text-amber-600" />
        <Kpi icon={<Landmark className="h-5 w-5" />} value={board.kpis.financingInProgress} label="financements en cours" tone="bg-blue-100 text-blue-600" />
        <Kpi icon={<CheckCircle2 className="h-5 w-5" />} value={board.kpis.secured} label="ventes sécurisées ce mois" tone="bg-emerald-100 text-emerald-600" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="relative block">
          <span className="sr-only">Rechercher un client</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un client" className="w-64 rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </label>
        <select aria-label="Mode de règlement" value={payment} onChange={(e) => setPayment(e.target.value as PaymentFilter)} className={SELECT}>
          <option value="">Mode de règlement</option>
          {(Object.keys(PAYMENT_FILTER_LABELS) as Exclude<PaymentFilter, ''>[]).map((k) => <option key={k} value={k}>{PAYMENT_FILTER_LABELS[k]}</option>)}
        </select>
        <select aria-label="Produit" value={product} onChange={(e) => setProduct(e.target.value)} className={SELECT}>
          <option value="">Produit</option>
          {products.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Ancienneté" value={age} onChange={(e) => setAge(e.target.value as AgeFilter)} className={SELECT}>
          <option value="">Ancienneté</option>
          {(Object.keys(AGE_FILTER_LABELS) as Exclude<AgeFilter, ''>[]).map((k) => <option key={k} value={k}>{AGE_FILTER_LABELS[k]}</option>)}
        </select>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} className="h-4 w-4" />
          Mes ventes uniquement
        </label>
      </div>

      {notice && (
        <p role="status" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> {notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">Fermer</button>
        </p>
      )}
      {error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" /> {error}</p>}
      {truncated && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Seuls les {LEAD_LIST_LIMIT} leads les plus récents sont lus : les colonnes peuvent être incomplètes.</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {SALE_COLUMNS.map((c) => {
          const list = board.columns[c.key];
          const style = COLUMN_STYLE[c.key];
          return (
            <section key={c.key} aria-label={c.label} className="rounded-xl border border-slate-200 bg-slate-50/60">
              <h2 className={cn('flex items-center gap-2 rounded-t-xl border-t-4 bg-white px-4 py-3 text-sm font-bold uppercase tracking-wide', style.head)}>
                {style.icon} {c.label} ({list.length})
              </h2>
              <ul className="space-y-3 p-3">
                {loading && <li className="py-6 text-center text-sm text-slate-500">Chargement…</li>}
                {!loading && list.length === 0 && <li className="py-6 text-center text-sm text-slate-400">{empty && !filtered ? 'Aucune vente pour le moment.' : 'Aucune vente.'}</li>}
                {list.map((r) => (
                  <SaleCard key={r.id} r={r} column={saleColumn(r) ?? c.key} nowMs={nowMs} canRemind={canRemind(r)} onOpen={() => navigate(`/dossiers/${r.id}`)} onRemind={() => setReminder({ row: r, column: c.key })} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <p className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        <Info className="h-4 w-4 flex-shrink-0 text-blue-600" /> Une vente est sécurisée uniquement après signature et confirmation du paiement ou du financement.
      </p>

      {reminder && (
        <ReminderModal
          r={reminder.row}
          column={reminder.column}
          onClose={() => setReminder(null)}
          onDone={(m) => {
            setReminder(null);
            setNotice(m);
          }}
        />
      )}
    </div>
  );
}
