import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Field, inputClass, Modal } from '../../components/ui/Modal';
import { errorMessage, saveSpend } from '../../lib/adminApi';
import { formatEuros, type SpendView } from '../../domain/admin/campaignStats';
import { parseEuros } from '../../domain/admin/money';

const toDay = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const fromDay = (v: string) => new Date(`${v}T12:00:00`).getTime(); // midi : insensible aux changements d'heure

export function SpendModal({
  campaignId,
  campaignName,
  entries,
  onClose,
  onSaved,
}: {
  campaignId: string;
  campaignName: string;
  entries: SpendView[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const mine = useMemo(() => entries.filter((e) => e.campaignId === campaignId).sort((a, b) => b.atMs - a.atMs), [entries, campaignId]);
  const total = mine.reduce((s, e) => s + e.amountCents, 0);

  const [date, setDate] = useState(() => toDay(Date.now()));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [fixId, setFixId] = useState<string | null>(null);
  const [fixAmount, setFixAmount] = useState('');
  const [fixReason, setFixReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Le panneau reste ouvert (on peut enchaîner plusieurs saisies) : on libère le formulaire.
      setAmount('');
      setNote('');
      setFixId(null);
      onSaved(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const cents = parseEuros(amount);
    if (cents === null) return setError('Montant : un nombre positif en euros.');
    if (!date) return setError('La date est obligatoire.');
    void run(() => saveSpend({ campaignId, amountCents: cents, dateMs: fromDay(date), note: note.trim() || undefined }), 'Dépense enregistrée.');
  };

  const correct = (e: SpendView) => {
    const cents = parseEuros(fixAmount);
    if (cents === null) return setError('Montant : un nombre positif en euros.');
    if (!fixReason.trim()) return setError('Une correction exige un motif.');
    void run(() => saveSpend({ id: e.id, campaignId, amountCents: cents, dateMs: e.atMs, note: e.note ?? undefined, reason: fixReason.trim() }), 'Dépense corrigée.');
  };

  return (
    <Modal
      title={`Dépenses — ${campaignName}`}
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          Fermer
        </button>
      }
    >
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Ajouter une dépense</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Date">
              <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Montant (€)">
              <input inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1 250,00" />
            </Field>
            <Field label="Note (facultatif)">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Facture Meta, semaine 40" />
            </Field>
          </div>
          <button type="button" onClick={add} disabled={busy} className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? 'Enregistrement…' : 'Ajouter'}
          </button>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Dépenses saisies</h3>
            <span className="text-sm text-slate-600">
              Total : <strong className="text-slate-900">{formatEuros(mine.length ? total : null)}</strong>
            </span>
          </div>
          {mine.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              Aucune dépense saisie. Tant qu'il n'y en a pas, les coûts de la campagne s'affichent « — ».
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {mine.map((e) => (
                <li key={e.id ?? `${e.atMs}-${e.amountCents}`} className="px-4 py-3 text-sm">
                  <div className="flex items-center gap-4">
                    <span className="w-24 text-slate-600">{new Date(e.atMs).toLocaleDateString('fr-FR')}</span>
                    <span className="w-28 font-medium text-slate-900">{formatEuros(e.amountCents)}</span>
                    <span className="flex-1 truncate text-slate-500">{e.note ?? ''}</span>
                    {e.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setFixId(fixId === e.id ? null : (e.id ?? null));
                          setFixAmount(String(e.amountCents / 100).replace('.', ','));
                          setFixReason('');
                          setError(null);
                        }}
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Corriger
                      </button>
                    )}
                  </div>
                  {fixId === e.id && (
                    <div className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[140px_1fr_auto]">
                      <input inputMode="decimal" className={inputClass} value={fixAmount} onChange={(ev) => setFixAmount(ev.target.value)} aria-label="Nouveau montant en euros" />
                      <input className={inputClass} value={fixReason} onChange={(ev) => setFixReason(ev.target.value)} placeholder="Motif de la correction (obligatoire)" aria-label="Motif de la correction" />
                      <button type="button" onClick={() => correct(e)} disabled={busy} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                        Corriger
                      </button>
                      <p className="text-xs text-slate-500 sm:col-span-3">
                        L'ancienne valeur, la nouvelle, l'auteur, la date et le motif sont conservés dans le journal d'audit. Mettez 0 pour annuler une dépense.
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
