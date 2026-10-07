import { useEffect } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COL } from '../domain/collections';

const HEARTBEAT_MS = 30_000;

/**
 * Battement de présence (§12.7, §19.3). Le moteur d'attribution ne donne un lead qu'à un télépro
 * « connecté » : battement de moins de 2 minutes. Un onglet ouvert ne suffit pas comme preuve
 * d'activité commerciale — c'est pourquoi le statut opérationnel est un champ séparé.
 */
export function usePresence(uid: string | null) {
  useEffect(() => {
    if (!uid) return;
    const ref = doc(db, COL.presence, uid);

    const beat = (connected: boolean) =>
      setDoc(ref, { uid, connected, lastSeenAt: serverTimestamp() }).catch(() => {
        // Réseau coupé ou règles : le prochain battement réessaiera ; au pire, le moteur nous
        // considère déconnecté, ce qui est le comportement sûr.
      });

    void beat(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void beat(true);
    }, HEARTBEAT_MS);

    const onVisible = () => document.visibilityState === 'visible' && void beat(true);
    const onLeave = () => void beat(false); // au mieux : un onglet fermé brutalement n'envoie rien, le délai de 2 min couvre ce cas
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onLeave);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onLeave);
      void beat(false);
    };
  }, [uid]);
}
