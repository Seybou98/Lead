import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { errorMessage, saveDraft } from '../../lib/adminApi';
import { DraftBanner } from './DraftBanner';
import { parseMessageTemplates } from '../../domain/messages/templates';
import {
  BODY_MAX,
  CHANNEL_LABELS,
  defaultTemplates,
  MAX_TEMPLATES,
  MESSAGE_CHANNELS,
  MESSAGE_TRIGGERS,
  renderTemplate,
  templateId,
  TRIGGER_INFO,
  validateMessages,
  VARIABLE_HELP,
  VARIABLES,
  type MessageChannel,
  type MessageContext,
  type MessageTemplate,
  type MessageTrigger,
} from '../../domain/messages/templates';
import { useConfigData } from './useConfigData';
import { Feedback, inputCls, SaveBar, SettingsCard, Switch } from './settingsUi';

const clone = (l: MessageTemplate[]): MessageTemplate[] => JSON.parse(JSON.stringify(l));
const SAMPLE: MessageContext = { prenom: 'Awa', nom: 'Diallo', produit: 'PAC', telepro: 'Sarah Cohen', pieces: ['Pièce d’identité (illisible)', 'Avis d’imposition'] };

/**
 * Modèles de message (§24.5) : un modèle par déclencheur, canal et produit. Le CRM ne les envoie pas en V1 : le télépro les
 * reçoit préparés dans « Messages » avec son identité commerciale, et les envoie lui-même. Chaque enregistrement est versionné
 * dans le journal d'audit.
 */
export function MessageTemplatesPage() {
  const data = useConfigData();
  const settings = data.settings;
  const base = settings.drafts?.messages ? parseMessageTemplates(settings.drafts.messages.doc) : settings.messages;
  const [draft, setDraft] = useState<MessageTemplate[]>(base);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [adding, setAdding] = useState<{ trigger: MessageTrigger; channel: MessageChannel; product: string }>({ trigger: 'documents_requested', channel: 'email', product: '' });
  const bodyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const loadedKey = `${settings.loading}:${JSON.stringify(base)}`;
  useEffect(() => {
    if (dirty) return;
    setDraft(clone(base));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  const change = (fn: (d: MessageTemplate[]) => MessageTemplate[]) => {
    setDraft((cur) => fn(clone(cur)));
    setDirty(true);
    setNotice(null);
  };
  const patch = (id: string, p: Partial<MessageTemplate>) => change((d) => d.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const errors = validateMessages(draft);

  const insert = (id: string, variable: string) => {
    const el = bodyRefs.current[id];
    const token = `{{${variable}}}`;
    const t = draft.find((x) => x.id === id);
    if (!t) return;
    const at = el ? el.selectionStart : t.body.length;
    patch(id, { body: `${t.body.slice(0, at)}${token}${t.body.slice(el ? el.selectionEnd : at)}` });
  };

  const add = () => {
    const id = templateId(adding.trigger, adding.channel, adding.product.trim());
    if (draft.some((t) => t.id === id)) return setNotice({ kind: 'error', text: 'Ce modèle existe déjà : modifiez-le plutôt.' });
    const base = defaultTemplates().find((t) => t.trigger === adding.trigger && t.channel === adding.channel);
    change((d) => [...d, { id, trigger: adding.trigger, channel: adding.channel, product: adding.product.trim(), subject: base?.subject ?? '', body: base?.body ?? '', active: true }]);
  };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveDraft('messages', { templates: draft });
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Brouillon enregistré. Les télépros ne le voient pas : testez-le, mesurez son impact, puis publiez-le.' });
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
        <span>Communications</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Modèles de message</h1>
      <p className="mt-1 text-slate-500">Un message par déclencheur, canal et produit, envoyé avec l’identité commerciale du télépro propriétaire. Le CRM prépare le message ; le télépro l’envoie lui-même (l’envoi automatique est une évolution).</p>

      <DraftBanner module="messages" draft={settings.drafts?.messages} />
      {!settings.saved.messages && !settings.loading && <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">Rien n’a encore été enregistré : ce sont les modèles d’origine qui s’appliquent.</p>}
      {settings.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Lecture des réglages refusée ou indisponible : vérifiez vos droits et les règles Firestore.</p>}

      <div className="mt-5 space-y-5">
        <SettingsCard title="Variables disponibles">
          <p className="text-sm text-slate-600">Cliquez sur une variable dans un modèle pour l’insérer à l’endroit du curseur.</p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {VARIABLES.map((v) => <div key={v} className="flex gap-2"><dt><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{`{{${v}}}`}</code></dt><dd className="text-slate-600">{VARIABLE_HELP[v]}</dd></div>)}
          </dl>
        </SettingsCard>

        {MESSAGE_TRIGGERS.map((trigger) => {
          const list = draft.filter((t) => t.trigger === trigger);
          const info = TRIGGER_INFO[trigger];
          return (
            <SettingsCard key={trigger} title={info.label}>
              <p className="text-sm text-slate-600">Message : {info.message} <span className="text-slate-400">· Arrêt : {info.stop}</span></p>
              {list.length === 0 && <p className="mt-3 text-sm text-slate-500">Aucun modèle : le télépro n’aura rien à envoyer pour ce déclencheur.</p>}
              <div className="mt-3 space-y-4">
                {list.map((t) => {
                  const preview = renderTemplate(t, SAMPLE);
                  const max = BODY_MAX[t.channel];
                  return (
                    <div key={t.id} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-900">{CHANNEL_LABELS[t.channel]} <span className="font-normal text-slate-500">· {t.product ? `produit ${t.product}` : 'tous les produits'}</span></p>
                        <div className="flex items-center gap-3">
                          <span className="inline-flex items-center gap-2 text-sm text-slate-600">Actif <Switch label={`Modèle actif : ${info.label} ${CHANNEL_LABELS[t.channel]}`} checked={t.active} onChange={(v) => patch(t.id, { active: v })} /></span>
                          <button type="button" aria-label={`Supprimer le modèle ${info.label} ${CHANNEL_LABELS[t.channel]}`} onClick={() => change((d) => d.filter((x) => x.id !== t.id))} className="rounded-md border border-slate-300 p-1.5 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </div>
                      {t.channel === 'email' && (
                        <label className="mt-3 block text-sm"><span className="font-medium text-slate-700">Objet</span>
                          <input aria-label={`Objet ${info.label}`} value={t.subject} maxLength={150} onChange={(e) => patch(t.id, { subject: e.target.value })} className={`${inputCls} mt-1 w-full`} />
                        </label>
                      )}
                      <label className="mt-3 block text-sm"><span className="font-medium text-slate-700">Message</span>
                        <textarea aria-label={`Message ${info.label} ${CHANNEL_LABELS[t.channel]}`} ref={(el) => { bodyRefs.current[t.id] = el; }} value={t.body} rows={t.channel === 'email' ? 8 : 5} onChange={(e) => patch(t.id, { body: e.target.value })} className={`${inputCls} mt-1 w-full font-mono text-[13px]`} />
                        <span className={`mt-1 block text-xs ${t.body.length > max ? 'text-red-600' : 'text-slate-500'}`}>{t.body.length} / {max} caractères</span>
                      </label>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {VARIABLES.map((v) => <button key={v} type="button" title={VARIABLE_HELP[v]} onClick={() => insert(t.id, v)} className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50">{`{{${v}}}`}</button>)}
                      </div>
                      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Aperçu (client fictif)</p>
                        {t.channel === 'email' && <p className="mt-1 font-medium text-slate-900">{preview.subject}</p>}
                        <p className="mt-1 whitespace-pre-line text-slate-700">{preview.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </SettingsCard>
          );
        })}

        <SettingsCard title="Ajouter un modèle">
          <p className="text-sm text-slate-600">Un modèle propre à un produit remplace le modèle général pour ce produit. Laissez le produit vide pour tous les produits.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label className="block"><span className="font-medium text-slate-700">Déclencheur</span>
              <select aria-label="Déclencheur" value={adding.trigger} onChange={(e) => setAdding({ ...adding, trigger: e.target.value as MessageTrigger })} className={`${inputCls} mt-1`}>{MESSAGE_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_INFO[t].label}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Canal</span>
              <select aria-label="Canal" value={adding.channel} onChange={(e) => setAdding({ ...adding, channel: e.target.value as MessageChannel })} className={`${inputCls} mt-1`}>{MESSAGE_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}</select>
            </label>
            <label className="block"><span className="font-medium text-slate-700">Produit (facultatif)</span>
              <input aria-label="Produit" list="message-products" value={adding.product} maxLength={80} onChange={(e) => setAdding({ ...adding, product: e.target.value })} className={`${inputCls} mt-1`} />
              <datalist id="message-products">{data.catalog.categories.map((c) => <option key={c.code} value={c.code} />)}</datalist>
            </label>
            <button type="button" onClick={add} disabled={draft.length >= MAX_TEMPLATES} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Plus className="h-4 w-4" /> Ajouter</button>
            <button type="button" onClick={() => { if (window.confirm('Remplacer tous les modèles par les modèles d’origine ? Vos modifications non enregistrées seront perdues.')) change(() => defaultTemplates()); }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"><RotateCcw className="h-4 w-4" /> Rétablir les modèles d’origine</button>
          </div>
        </SettingsCard>
      </div>

      <Feedback errors={errors} notice={notice} />
      <SaveBar onCancel={() => { setDraft(clone(base)); setDirty(false); setNotice(null); }} onSave={() => void save()} busy={busy} blocked={errors.length > 0} dirty={dirty} saveLabel="Enregistrer le brouillon" />
    </div>
  );
}
