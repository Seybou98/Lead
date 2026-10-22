import { useEffect, useState } from 'react';
import { collection, doc, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { resolveLeadRole } from '../../config/roles';
import type { Role } from '../../domain/enums';
import { parseSchedules, type ScheduledExport } from '../../domain/reports/schedule';

/** Rapports programmés (cl_settings/exports), en temps réel. Lisibles par le personnel ; écrits par l'administrateur. */
export function useScheduledExports(): { loading: boolean; error: boolean; schedules: ScheduledExport[]; saved: boolean } {
  const [state, setState] = useState<{ loading: boolean; error: boolean; schedules: ScheduledExport[]; saved: boolean }>({ loading: true, error: false, schedules: [], saved: false });
  useEffect(
    () =>
      onSnapshot(
        doc(db, COL.settings, 'exports'),
        (s) => setState({ loading: false, error: false, schedules: parseSchedules(s.data()), saved: s.exists() }),
        () => setState({ loading: false, error: true, schedules: [], saved: false })
      ),
    []
  );
  return state;
}

export interface Recipient {
  uid: string;
  name: string;
  email: string;
  role: Role;
}

/** Destinataires possibles d'un rapport : utilisateurs actifs, administrateurs et managers (jamais les télépros). */
export function useRecipients(): { loading: boolean; recipients: Recipient[] } {
  const [state, setState] = useState<{ loading: boolean; recipients: Recipient[] }>({ loading: true, recipients: [] });
  useEffect(() => {
    let alive = true;
    getDocs(collection(db, 'users'))
      .then((s) => {
        if (!alive) return;
        const out: Recipient[] = [];
        for (const d of s.docs) {
          const x = d.data();
          if (String(x.status ?? '').toLowerCase() !== 'active') continue;
          const role = resolveLeadRole(x.role);
          if (role !== 'admin' && role !== 'manager') continue;
          const email = String(x.email ?? '').trim();
          out.push({ uid: d.id, name: String(x.name || x.displayName || `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || email || d.id), email, role });
        }
        setState({ loading: false, recipients: out.sort((a, b) => a.name.localeCompare(b.name, 'fr')) });
      })
      .catch(() => alive && setState({ loading: false, recipients: [] }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
