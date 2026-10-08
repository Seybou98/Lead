import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { useAuth } from '../../auth/AuthProvider';
import type { Role } from '../../domain/enums';
import type { UserRow } from '../../domain/admin/userRows';
import type { LeadListItem } from '../../domain/leads/leadList';
import type { WorkSlotLike } from '../../domain/engine/schedule';
import { buildTargets, portfolioOf, type Portfolio, type Target } from '../../domain/portfolio/portfolio';
import type { AbsenceType } from '../../domain/portfolio/absence';
import { ms } from '../../lib/firestoreViews';
import { useCockpitData, type CockpitData } from '../cockpit/useCockpitData';

export interface AbsenceView {
  id: string;
  type: AbsenceType;
  fromMs: number;
  toMs: number;
  reason: string;
  restoreDistribution: boolean;
  createdBy: string;
}

/** Horaires de travail propres au télépro (profil CRM Leads) ; null tant qu'ils ne sont pas lus. */
export interface ScheduleView {
  timezone: string;
  weekly: WorkSlotLike[];
  breaks: WorkSlotLike[];
}

export interface PortfolioData {
  role: Role;
  cockpit: CockpitData;
  loading: boolean;
  error: string | null;
  /** null : télépro introuvable dans le périmètre de l'utilisateur connecté. */
  row: UserRow | null;
  items: LeadListItem[];
  portfolio: Portfolio;
  targets: Target[];
  absences: AbsenceView[];
  /** null : horaires non lus ; weekly vide : aucun horaire propre (ceux de l'entreprise s'appliquent). */
  schedule: ScheduleView | null;
  nowMs: number;
}

/** Données de la fiche télépro, de la déclaration d'absence et de l'assistant de transfert (lecture seule). */
export function usePortfolioData(userUid: string): PortfolioData {
  const { user } = useAuth();
  const role: Role = user?.role ?? 'manager';
  const cockpit = useCockpitData(role, user?.uid ?? '');
  const [absences, setAbsences] = useState<AbsenceView[]>([]);
  const [absError, setAbsError] = useState(false);

  useEffect(
    () =>
      onSnapshot(
        query(collection(db, COL.absences), where('userId', '==', userUid)),
        (s) => {
          setAbsError(false);
          setAbsences(
            s.docs
              .map((d) => ({ id: d.id, type: (d.get('type') ?? 'other') as AbsenceType, fromMs: ms(d.get('from')) ?? 0, toMs: ms(d.get('to')) ?? 0, reason: String(d.get('reason') ?? ''), restoreDistribution: d.get('restoreDistribution') !== false, createdBy: String(d.get('createdBy') ?? '') }))
              .sort((a, b) => b.fromMs - a.fromMs)
          );
        },
        () => setAbsError(true)
      ),
    [userUid]
  );

  const [schedule, setSchedule] = useState<ScheduleView | null>(null);
  useEffect(
    () =>
      onSnapshot(
        doc(db, COL.profiles, userUid),
        (s) => {
          const sch = s.get('schedule') as { timezone?: string; weekly?: WorkSlotLike[]; breaks?: WorkSlotLike[] } | undefined;
          setSchedule({ timezone: sch?.timezone ?? 'Europe/Paris', weekly: Array.isArray(sch?.weekly) ? sch.weekly : [], breaks: Array.isArray(sch?.breaks) ? sch.breaks : [] });
        },
        () => setSchedule(null)
      ),
    [userUid]
  );

  const row = useMemo(() => cockpit.rows.find((r) => r.uid === userUid) ?? null, [cockpit.rows, userUid]);
  const portfolio = useMemo(() => portfolioOf(cockpit.items, userUid), [cockpit.items, userUid]);
  const targets = useMemo(() => buildTargets(cockpit.rows, cockpit.items), [cockpit.rows, cockpit.items]);

  return { role, cockpit, loading: cockpit.loading, error: cockpit.error ?? (absError ? 'Lecture des absences refusée ou indisponible.' : null), row, items: cockpit.items, portfolio, targets, absences, schedule, nowMs: cockpit.nowMs };
}
