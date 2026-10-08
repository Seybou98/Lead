import { useEffect, useState } from 'react';
import { arrayUnion, collection, doc, limit, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { Bell, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { ms } from '../../lib/firestoreViews';
import { useAuth } from '../../auth/AuthProvider';
import { sinceLabel } from '../../domain/cockpit/cockpit';

interface Notif {
  id: string;
  title: string;
  description: string;
  leadId: string | null;
  atMs: number;
  read: boolean;
  critical: boolean;
}

/**
 * Alertes envoyées au manager par le planificateur (rappel non effectué, lead non attribué, hors SLA, documents
 * toujours incomplets). Elles restent affichées tant qu'elles ne sont pas lues ; les lire ne règle pas la situation,
 * qui reste visible dans les cartes du cockpit tant qu'elle n'est pas corrigée (§12.6).
 */
export function ManagerNotifications({ nowMs, onOpenLead }: { nowMs: number; onOpenLead: (leadId: string) => void }) {
  const { user } = useAuth();
  const uid = user?.uid ?? '';
  const [items, setItems] = useState<Notif[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!uid) return;
    // Sans orderBy : pas d'index composite à créer ; le tri se fait ici.
    return onSnapshot(
      query(collection(db, COL.notifications), where('recipientIds', 'array-contains', uid), limit(50)),
      (s) => {
        setError(false);
        setItems(
          s.docs
            .map((d) => ({
              id: d.id,
              title: String(d.get('title') ?? ''),
              description: String(d.get('description') ?? ''),
              leadId: (d.get('leadId') as string | null) ?? null,
              atMs: ms(d.get('createdAt')) ?? 0,
              read: Array.isArray(d.get('readBy')) && (d.get('readBy') as string[]).includes(uid),
              critical: d.get('sound') === 'critical',
            }))
            .sort((a, b) => b.atMs - a.atMs)
            .slice(0, 8)
        );
      },
      () => setError(true)
    );
  }, [uid]);

  const unread = items.filter((i) => !i.read);
  const markRead = (ids: string[]) => Promise.all(ids.map((id) => updateDoc(doc(db, COL.notifications, id), { readBy: arrayUnion(uid) }).catch(() => undefined)));

  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5" aria-label="Alertes automatiques">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-base font-semibold text-slate-900">
          <span className="text-blue-600"><Bell className="h-[18px] w-[18px]" /></span> Alertes automatiques
          {unread.length > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">{unread.length}</span>}
        </h2>
        {unread.length > 0 && <button type="button" onClick={() => markRead(unread.map((i) => i.id))} className="text-sm text-blue-700 hover:underline">Tout marquer comme lu</button>}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">Lecture des alertes refusée ou indisponible.</p>}
      {!error && items.length === 0 && <p className="mt-3 flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Aucune alerte automatique pour le moment.</p>}
      <ul className="mt-3 divide-y divide-slate-100">
        {items.map((n) => (
          <li key={n.id} className={cn('flex items-start gap-3 py-2.5', n.read && 'opacity-60')}>
            <span className={cn('mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full', n.critical ? 'bg-red-500' : 'bg-orange-500')} role="img" aria-label={n.critical ? 'Critique' : 'Élevé'} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-900">{n.title}</span>
              <span className="block text-sm text-slate-600">{n.description}</span>
            </span>
            <span className="flex flex-shrink-0 flex-col items-end gap-1 text-xs text-slate-400">
              <span>il y a {sinceLabel(n.atMs, nowMs)}</span>
              <span className="flex gap-3">
                {n.leadId && <button type="button" onClick={() => { void markRead([n.id]); onOpenLead(n.leadId!); }} className="font-medium text-blue-700 hover:underline">Ouvrir</button>}
                {!n.read && <button type="button" onClick={() => markRead([n.id])} className="hover:underline">Lu</button>}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
