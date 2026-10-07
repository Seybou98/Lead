import { useMemo, useState } from 'react';
import { Field, inputClass, Modal, parseList } from '../../components/ui/Modal';
import { WeeklyScheduleEditor, type WeeklySlot } from '../../components/ui/WeeklyScheduleEditor';
import { errorMessage, saveProfile } from '../../lib/adminApi';
import type { UserRow } from '../../domain/admin/userRows';
import type { RawProfile } from './useUsersData';

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export function ProfileModal({
  row,
  raw,
  hasActiveOverride,
  onClose,
  onSaved,
}: {
  row: UserRow;
  raw: RawProfile | undefined;
  hasActiveOverride: boolean;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const schedule = raw?.schedule ?? { timezone: 'Europe/Paris', weekly: [], breaks: [] };

  // Plus d'une plage par jour, ou des pauses : l'éditeur simple les écraserait. On les protège.
  const advancedSchedule = useMemo(() => {
    const perDay = new Map<number, number>();
    schedule.weekly.forEach((s) => perDay.set(s.day, (perDay.get(s.day) ?? 0) + 1));
    return schedule.breaks.length > 0 || [...perDay.values()].some((n) => n > 1);
  }, [schedule]);

  const [cap, setCap] = useState(raw?.newLeadsCap != null ? String(raw.newLeadsCap) : '');
  const [products, setProducts] = useState((raw?.scope.productCodes ?? []).join(', '));
  const [zones, setZones] = useState((raw?.scope.zones ?? []).join(', '));
  const [suspended, setSuspended] = useState(row.distribution === 'suspended');
  const [weekly, setWeekly] = useState<WeeklySlot[]>(schedule.weekly);
  const [override, setOverride] = useState<'keep' | 'set' | 'remove'>('keep');
  const [ovValue, setOvValue] = useState('15');
  const [ovFrom, setOvFrom] = useState(() => toLocalInput(Date.now()));
  const [ovUntil, setOvUntil] = useState(() => toLocalInput(Date.now() + 24 * 3600 * 1000));
  const [ovReason, setOvReason] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    // Vide = valeur par défaut de la configuration (10) ; sinon un plafond individuel.
    const capNum = cap.trim() === '' ? null : Number(cap);
    if (capNum !== null && (!Number.isInteger(capNum) || capNum < 0 || capNum > 100)) {
      setError('Plafond : un nombre entier entre 0 et 100, ou vide pour la valeur par défaut.');
      return;
    }
    const payload: Parameters<typeof saveProfile>[0] = {
      uid: row.uid,
      newLeadsCap: capNum,
      scope: {
        productCodes: parseList(products),
        zones: parseList(zones),
        campaignIds: raw?.scope.campaignIds ?? [],
        sourceIds: raw?.scope.sourceIds ?? [],
      },
      distributionSuspended: suspended,
      reason: reason.trim() || undefined,
    };

    if (!advancedSchedule) {
      payload.schedule = { timezone: schedule.timezone, weekly, breaks: [] };
    }

    if (override === 'remove') payload.capacityOverride = null;
    if (override === 'set') {
      const from = new Date(ovFrom).getTime();
      const until = new Date(ovUntil).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(until)) {
        setError('Dérogation : renseignez la date de début et la date de fin.');
        return;
      }
      payload.capacityOverride = { value: Number(ovValue), fromMs: from, untilMs: until, reason: ovReason.trim() };
    }

    setBusy(true);
    try {
      const res = await saveProfile(payload);
      onSaved(res.warnings);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Paramètres de ${row.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Annuler
          </button>
          <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <div className="space-y-6">
        {!row.hasProfile && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Ce télépro n'est pas encore configuré. Tant que son périmètre est vide, il ne reçoit aucun lead. Rattachez-le ensuite à une équipe depuis « Créer ou modifier une équipe ».
          </p>
        )}

        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Périmètre commercial</h3>
          <Field label="Produits autorisés" hint="Séparés par des virgules. « * » autorise tous les produits. Vide = aucun lead.">
            <input className={inputClass} value={products} onChange={(e) => setProducts(e.target.value)} placeholder="pac_air_eau, ssc" />
          </Field>
          <Field label="Zones autorisées" hint="« * » autorise toutes les zones. Vide = aucun lead.">
            <input className={inputClass} value={zones} onChange={(e) => setZones(e.target.value)} placeholder="idf, grand_est" />
          </Field>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Capacité et distribution</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plafond de nouveaux leads" hint="Laissez vide pour la valeur par défaut (10, réglable par campagne). À ce nombre, plus aucun lead n'est attribué.">
              <input type="number" min={0} max={100} className={inputClass} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Par défaut" />
            </Field>
            <label className="flex items-center gap-3 self-end rounded-lg border border-slate-200 px-4 py-3">
              <input type="checkbox" checked={suspended} onChange={(e) => setSuspended(e.target.checked)} className="h-4 w-4" />
              <span className="text-sm text-slate-800">Suspendre la distribution</span>
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-800">Dérogation temporaire de capacité</p>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={override === 'keep'} onChange={() => setOverride('keep')} /> {hasActiveOverride ? 'Conserver la dérogation en cours' : 'Aucune'}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={override === 'set'} onChange={() => setOverride('set')} /> {hasActiveOverride ? 'Remplacer' : 'Accorder'}
              </label>
              {hasActiveOverride && (
                <label className="flex items-center gap-2">
                  <input type="radio" checked={override === 'remove'} onChange={() => setOverride('remove')} /> Retirer
                </label>
              )}
            </div>
            {override === 'set' && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Plafond temporaire">
                  <input type="number" min={0} max={100} className={inputClass} value={ovValue} onChange={(e) => setOvValue(e.target.value)} />
                </Field>
                <Field label="Motif (obligatoire)">
                  <input className={inputClass} value={ovReason} onChange={(e) => setOvReason(e.target.value)} />
                </Field>
                <Field label="Du">
                  <input type="datetime-local" className={inputClass} value={ovFrom} onChange={(e) => setOvFrom(e.target.value)} />
                </Field>
                <Field label="Au (obligatoire)" hint="Le plafond normal revient automatiquement à cette date.">
                  <input type="datetime-local" className={inputClass} value={ovUntil} onChange={(e) => setOvUntil(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Horaires de travail ({schedule.timezone})</h3>
          {advancedSchedule ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Ces horaires contiennent plusieurs plages par jour ou des pauses. Ils sont conservés tels quels : cet éditeur simple ne les modifie pas.
            </p>
          ) : (
            <>
              {weekly.length === 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                  Aucune plage de travail : ce télépro sera toujours « hors horaires » et ne recevra aucun lead.
                </p>
              )}
              <WeeklyScheduleEditor initial={schedule.weekly} onChange={setWeekly} />
            </>
          )}
        </section>

        <Field label="Motif de la modification (facultatif)" hint="Conservé dans le journal d'audit.">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
