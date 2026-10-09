import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_CONVERSION_SETTINGS, validateConversionSettings, type ConversionSettings } from '../../domain/settings/settings';
import { errorMessage, saveConversion } from '../../lib/adminApi';
import { useSettings } from './useSettings';
import { Feedback, NumberField, SaveBar, SettingsCard, Switch } from './settingsUi';

/** Contrôles qui bloquent toujours la vente : aucune dérogation possible (§11.6), donc rien à régler. */
const ALWAYS_BLOCKING = [
  'Documents obligatoires non conformes ou absents',
  'Identité et coordonnées incomplètes',
  'Produit, logement ou champs obligatoires du produit manquants',
  'Offre vide ou lignes incomplètes (nom, quantité, prix)',
  'Aides et remise supérieures au prix TTC',
  'Opération CEE sans délégataire ou sans contrôle de double valorisation',
  'Éligibilité refusée (dossier inéligible)',
];

/**
 * Verrous de conversion (§11.2, §11.6, §14, fig. 29) : ce qui bloque la vente et ce qui passe par une validation du
 * manager. Ces valeurs sont CELLES qu'évalue le montage du dossier, côté navigateur comme côté serveur.
 */
export function ConversionRulesPage() {
  const settings = useSettings();
  const [draft, setDraft] = useState<ConversionSettings>(DEFAULT_CONVERSION_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadedKey = `${settings.loading}:${JSON.stringify(settings.conversion)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(settings.conversion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const set = <K extends keyof ConversionSettings>(k: K, v: ConversionSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
    setNotice(null);
  };
  const errors = validateConversionSettings(draft);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveConversion(draft);
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Paramètres enregistrés. Ils s’appliquent aux prochains contrôles de dossier ; une vente déjà créée ne change pas, et une approbation déjà donnée reste valable tant que le dossier n’est pas modifié.' });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Verrous de conversion</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Verrous de conversion</h1>
      <p className="mt-1 text-slate-500">Réglez ce qui demande l&apos;accord d&apos;un manager avant de créer une vente. Une exception ne supprime jamais le contrôle : elle ouvre une demande de validation.</p>

      {!settings.saved.conversion && !settings.loading && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Aucun réglage n&apos;a encore été enregistré : ce sont les valeurs du cahier des charges qui s&apos;appliquent. Enregistrez pour les rendre vôtres.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <SettingsCard title="Exceptions soumises au manager">
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-700">Remise commerciale maximale sans validation<span className="block text-xs text-slate-500">En pourcentage du prix TTC. Au-delà : validation du manager.</span></span>
              <NumberField label="Remise maximale" value={draft.maxDiscountPct} onChange={(v) => set('maxDiscountPct', v)} min={0} max={100} suffix="%" />
            </div>
            <Switch label="Éligibilité aux aides exigée (sinon validation du manager)" checked={draft.requireEligibility} onChange={(v) => set('requireEligibility', v)} />
            <Switch label="Consentement du client exigé (sinon validation du manager)" checked={draft.requireConsent} onChange={(v) => set('requireConsent', v)} />
          </div>
          <p className="mt-4 text-xs text-slate-500">Un produit ou un tarif hors catalogue et un document validé avec réserve passent toujours par le manager : ils ne se désactivent pas.</p>
        </SettingsCard>

        <SettingsCard title="Contrôle bloquant">
          <div className="text-sm">
            <Switch label="Qualification RGE de l’opération exigée (bloquant)" checked={draft.requireRge} onChange={(v) => set('requireRge', v)} />
          </div>
          <p className="mt-4 text-sm font-medium text-slate-800">Toujours bloquants, sans dérogation :</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
            {ALWAYS_BLOCKING.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </SettingsCard>
      </div>

      <Feedback errors={dirty ? errors : []} notice={notice} />
      <SaveBar onCancel={() => { setDraft(settings.conversion); setDirty(false); setNotice(null); }} onSave={save} busy={busy} blocked={errors.length > 0} dirty={dirty} />
    </div>
  );
}
