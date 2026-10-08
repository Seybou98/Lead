import { useMemo, useState } from 'react';
import { ProductChips } from '../../components/ui/ProductPickers';
import { useProductCatalog } from '../products/useProductCatalog';
import { Field, inputClass, Modal, parseList } from '../../components/ui/Modal';
import { errorMessage, saveTeam } from '../../lib/adminApi';
import { resolveLeadRole } from '../../config/roles';
import type { MainUserView, TeamView } from '../../domain/admin/userRows';
import type { RawTeam } from './useUsersData';

const isActive = (u: MainUserView) => String(u.status ?? '').trim().toLowerCase() === 'active';
const label = (u: MainUserView) => u.name || u.email || u.uid;

export function TeamModal({
  team,
  raw,
  users,
  teams,
  onClose,
  onSaved,
}: {
  /** null = création */
  team: TeamView | null;
  raw: RawTeam | undefined;
  users: MainUserView[];
  teams: TeamView[];
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const managers = useMemo(
    () => users.filter((u) => isActive(u) && ['manager', 'admin'].includes(resolveLeadRole(u.role) ?? '')).sort((a, b) => label(a).localeCompare(label(b), 'fr')),
    [users]
  );
  const telepros = useMemo(
    () => users.filter((u) => isActive(u) && resolveLeadRole(u.role) === 'telepro').sort((a, b) => label(a).localeCompare(label(b), 'fr')),
    [users]
  );

  const [name, setName] = useState(team?.name ?? '');
  const [managerId, setManagerId] = useState(team?.managerId ?? '');
  const [secondaryId, setSecondaryId] = useState(team?.secondaryManagerId ?? '');
  const [members, setMembers] = useState<string[]>(team ? [...team.memberIds] : []);
  const [products, setProducts] = useState<string[]>(raw?.productCodes ?? []);
  const catalog = useProductCatalog();
  const [zones, setZones] = useState((raw?.zones ?? []).join(', '));
  const [fallbackId, setFallbackId] = useState(raw?.fallbackTeamId ?? '');
  const [active, setActive] = useState(team?.active ?? true);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = telepros.filter((u) => label(u).toLowerCase().includes(search.trim().toLowerCase()));
  // Un membre déjà dans l'équipe mais dont le compte n'est plus actif : on le montre, pour pouvoir le retirer.
  const orphans = members.filter((id) => !telepros.some((u) => u.uid === id));

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Le nom de l'équipe est obligatoire.");
    if (!managerId) return setError('Choisissez un manager principal.');
    setBusy(true);
    try {
      const res = await saveTeam({
        id: team?.id,
        name: name.trim(),
        managerId,
        secondaryManagerId: secondaryId || null,
        memberIds: members,
        productCodes: products,
        zones: parseList(zones),
        fallbackTeamId: fallbackId || null,
        active,
        reason: reason.trim() || undefined,
      });
      onSaved(res.warnings);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={team ? `Modifier l'équipe ${team.name}` : 'Créer une équipe'}
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
      <div className="space-y-5">
        <Field label="Nom de l'équipe">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Manager principal">
            <select className={inputClass} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">— Choisir —</option>
              {managers.map((u) => (
                <option key={u.uid} value={u.uid}>
                  {label(u)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Manager secondaire (facultatif)">
            <select className={inputClass} value={secondaryId} onChange={(e) => setSecondaryId(e.target.value)}>
              <option value="">— Aucun —</option>
              {managers
                .filter((u) => u.uid !== managerId)
                .map((u) => (
                  <option key={u.uid} value={u.uid}>
                    {label(u)}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {managers.length === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            Aucun utilisateur actif avec le rôle « manager » ou « administrateur » n'a été trouvé.
          </p>
        )}

        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">
              Membres <span className="text-slate-400">({members.length} sélectionné{members.length > 1 ? 's' : ''})</span>
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              aria-label="Rechercher un télépro"
            />
          </div>
          <div className="mt-2 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {telepros.length === 0 && (
              <p className="px-4 py-3 text-sm text-slate-500">
                Aucun télépro actif. Un utilisateur doit avoir le rôle « telepro commercial » dans le CRM principal.
              </p>
            )}
            {[...orphans.map((id) => ({ uid: id, name: `${id} (compte inactif ou introuvable)`, email: '', role: null, status: null })), ...shown].map((u) => (
              <label key={u.uid} className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={members.includes(u.uid)}
                  onChange={(e) => setMembers((m) => (e.target.checked ? [...m, u.uid] : m.filter((x) => x !== u.uid)))}
                />
                <span className="text-slate-800">{label(u)}</span>
                {u.email && <span className="text-xs text-slate-400">{u.email}</span>}
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-slate-700">Produits de l'équipe</span>
            <div className="mt-1"><ProductChips selected={products} onChange={setProducts} categories={catalog.categories} ariaLabel="Produits de l'équipe" /></div>
            <span className="mt-1 block text-xs text-slate-500">Familles du catalogue produits.</span>
          </div>
          <Field label="Zones de l'équipe" hint="Séparées par des virgules.">
            <input className={inputClass} value={zones} onChange={(e) => setZones(e.target.value)} />
          </Field>
        </div>

        <Field label="Équipe de secours" hint="Reçoit les leads quand plus aucun membre de cette équipe n'est disponible.">
          <select className={inputClass} value={fallbackId} onChange={(e) => setFallbackId(e.target.value)}>
            <option value="">— Aucune —</option>
            {teams
              .filter((t) => t.id !== team?.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </Field>

        <label className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4" />
          <span className="whitespace-nowrap text-sm text-slate-800">Équipe active</span>
          <span className="text-xs text-slate-500">Une équipe inactive ne reçoit plus de leads et n'attribue plus de manager à ses membres.</span>
        </label>

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
