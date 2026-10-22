import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, Info, Send } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { documentLabel, koLabel } from '../../domain/documents/plan';
import { CHANNEL_LABELS, channelLink, MESSAGE_CHANNELS, pickTemplate, renderTemplate, statusText, TRIGGER_INFO, triggersFor, MESSAGE_TRIGGERS, type MessageChannel, type MessageTemplate, type MessageTrigger } from '../../domain/messages/templates';
import { formatPhoneDisplay, type LeadListItem } from '../../domain/leads/leadList';
import { useLeadsList } from '../leads/useLeadsData';
import { useSettings } from '../settings/useSettings';

interface Item {
  lead: LeadListItem;
  trigger: MessageTrigger;
  pieces: string[];
}

const PAGE = 30;

/** Pièces à citer : seulement ce qui manque ou a été rejeté, avec le motif (jamais une pièce déjà conforme). */
export function piecesOf(l: LeadListItem): string[] {
  return (l.docs?.missing ?? [])
    .filter((m) => m.status === 'expected' || m.status === 'non_conform' || m.status === 'to_reask')
    .map((m) => `${documentLabel(m.code, m.label)}${m.status !== 'expected' && m.koReason ? ` (${koLabel(m).toLowerCase()})` : ''}`);
}

/** Messages à envoyer (§24.5, §25.2) : pour chaque lead, le message adapté à son étape, prêt à copier ou à ouvrir. */
export function MessagesView({ leads, loading, error, telepro, templates }: { leads: LeadListItem[]; loading: boolean; error: string | null; telepro: string; templates: MessageTemplate[] }) {
  const [filter, setFilter] = useState<MessageTrigger | 'all'>('all');
  const [shown, setShown] = useState(PAGE);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const lead of leads) {
      if (lead.excluded) continue;
      for (const trigger of triggersFor({ status: lead.status, documentsState: lead.documentsState, commercialState: lead.commercialState, financialState: lead.financialState })) {
        const pieces = piecesOf(lead);
        // Une relance documentaire cite les pièces : sans pièce à citer, il n'y a rien à envoyer.
        if ((trigger === 'documents_requested' || trigger === 'documents_partial') && pieces.length === 0) continue;
        out.push({ lead, trigger, pieces });
      }
    }
    return out.sort((a, b) => MESSAGE_TRIGGERS.indexOf(a.trigger) - MESSAGE_TRIGGERS.indexOf(b.trigger) || a.lead.receivedAtMs - b.lead.receivedAtMs);
  }, [leads]);
  const counts = useMemo(() => Object.fromEntries(MESSAGE_TRIGGERS.map((t) => [t, items.filter((i) => i.trigger === t).length])) as Record<MessageTrigger, number>, [items]);
  const visible = items.filter((i) => filter === 'all' || i.trigger === filter);

  return (
    <div className="w-full max-w-4xl">
      <h1 className="text-2xl font-bold text-slate-900">Messages</h1>
      <p className="mt-1 text-slate-500">Les messages à envoyer à vos clients, préparés avec votre identité commerciale. Copiez-les ou ouvrez votre messagerie, votre téléphone ou WhatsApp.</p>
      <p className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900"><Info className="mt-0.5 h-4 w-4 flex-shrink-0" /> Le CRM n’envoie rien lui-même : c’est vous qui envoyez. Pour garder la trace d’une relance documentaire, utilisez « J’ai relancé » depuis l’écran Documents.</p>

      {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <div role="tablist" aria-label="Déclencheur" className="mt-5 flex flex-wrap gap-2 text-sm">
        <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => { setFilter('all'); setShown(PAGE); }} className={cn('rounded-lg border px-3 py-1.5', filter === 'all' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>Tous ({items.length})</button>
        {MESSAGE_TRIGGERS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={filter === t} onClick={() => { setFilter(t); setShown(PAGE); }} className={cn('rounded-lg border px-3 py-1.5', filter === t ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>{TRIGGER_INFO[t].label} ({counts[t]})</button>
        ))}
      </div>

      {loading ? <p className="mt-6 text-sm text-slate-500">Chargement…</p> : visible.length === 0 ? (
        <p className="mt-6 rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">Aucun message à envoyer pour le moment.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {visible.slice(0, shown).map((i) => <MessageCard key={`${i.lead.id}:${i.trigger}`} item={i} telepro={telepro} templates={templates} />)}
        </ul>
      )}
      {visible.length > shown && <button type="button" onClick={() => setShown((n) => n + PAGE)} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Afficher plus ({visible.length - shown})</button>}
    </div>
  );
}

function MessageCard({ item, telepro, templates }: { item: Item; telepro: string; templates: MessageTemplate[] }) {
  const { lead, trigger, pieces } = item;
  const available = MESSAGE_CHANNELS.filter((c) => pickTemplate(templates, trigger, c, lead.productCode));
  const [channel, setChannel] = useState<MessageChannel>(available[0] ?? 'email');
  const [copied, setCopied] = useState(false);
  const first = lead.fullName.trim().split(/\s+/)[0] ?? '';
  const last = lead.fullName.trim().split(/\s+/).slice(1).join(' ');
  const template = pickTemplate(templates, trigger, channel, lead.productCode);
  const msg = template ? renderTemplate(template, { prenom: first, nom: last, produit: lead.productCode ?? '', telepro, pieces }) : null;
  const link = msg ? channelLink(channel, { email: lead.email, phone: lead.phone }, msg) : null;

  const copy = async () => {
    if (!msg) return;
    try {
      await navigator.clipboard.writeText(channel === 'email' ? `Objet : ${msg.subject}\n\n${msg.body}` : msg.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-slate-900">{lead.fullName || 'Contact sans nom'} <span className="font-normal text-slate-500">· {lead.productCode ?? 'produit non renseigné'}</span></p>
          <p className="text-xs text-slate-500">{TRIGGER_INFO[trigger].label} · {statusText(lead.status)}{lead.phone ? ` · ${formatPhoneDisplay(lead.phone)}` : ''}{lead.email ? ` · ${lead.email}` : ''}</p>
        </div>
        <Link to={`/leads/${lead.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Ouvrir la fiche</Link>
      </div>
      {available.length === 0 ? (
        <p className="mt-3 text-sm text-amber-800">Aucun modèle actif pour ce déclencheur : demandez à l’administrateur d’en activer un (Paramètres → Communications).</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Canal" className="mt-3 flex gap-2 text-sm">
            {available.map((c) => <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={cn('rounded-lg border px-3 py-1', channel === c ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>{CHANNEL_LABELS[c]}</button>)}
          </div>
          {msg && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
              {channel === 'email' && <p className="font-medium text-slate-900">Objet : {msg.subject}</p>}
              <p className="mt-1 whitespace-pre-line text-slate-700">{msg.body}</p>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />} {copied ? 'Copié' : 'Copier'}</button>
            {link ? (
              <a href={link} target={channel === 'whatsapp' ? '_blank' : undefined} rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Send className="h-4 w-4" /> Ouvrir {channel === 'email' ? 'ma messagerie' : channel === 'sms' ? 'mes SMS' : 'WhatsApp'}</a>
            ) : (
              <span className="text-xs text-slate-500">{channel === 'email' ? 'Pas d’adresse email sur ce lead.' : 'Pas de numéro de téléphone sur ce lead.'}</span>
            )}
          </div>
        </>
      )}
    </li>
  );
}

export function MessagesPage() {
  const { user } = useAuth();
  const list = useLeadsList(user?.role ?? 'telepro', user?.uid ?? '');
  const { messages } = useSettings();
  return <MessagesView leads={list.items} loading={list.loading} error={list.error} telepro={user?.name ?? ''} templates={messages} />;
}
