import { useState } from 'react';
import { inputClass } from './Modal';

export interface WeeklySlot {
  day: number; // 0 = dimanche … 6 = samedi
  start: string; // "HH:mm"
  end: string;
}

// Lundi → dimanche (0 = dimanche dans les données).
const DAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Lundi' },
  { day: 2, label: 'Mardi' },
  { day: 3, label: 'Mercredi' },
  { day: 4, label: 'Jeudi' },
  { day: 5, label: 'Vendredi' },
  { day: 6, label: 'Samedi' },
  { day: 0, label: 'Dimanche' },
];

interface DayState {
  on: boolean;
  start: string;
  end: string;
}

const DEFAULT_HOURS = { start: '09:00', end: '18:00' };

function toState(slots: readonly WeeklySlot[]): Record<number, DayState> {
  const out: Record<number, DayState> = {};
  for (const { day } of DAYS) {
    const slot = slots.find((s) => s.day === day);
    out[day] = slot ? { on: true, start: slot.start, end: slot.end } : { on: false, ...DEFAULT_HOURS };
  }
  return out;
}

const toSlots = (days: Record<number, DayState>): WeeklySlot[] =>
  DAYS.filter(({ day }) => days[day].on).map(({ day }) => ({ day, start: days[day].start, end: days[day].end }));

/**
 * Éditeur d'horaires hebdomadaires : une plage par jour. L'état initial vient de `initial` ; chaque
 * modification renvoie la liste complète des plages. Un jour décoché garde ses dernières heures, pour
 * les retrouver s'il est recoché. Le parent garde la main sur la valeur ; ce composant ne gère pas
 * les jours à plusieurs plages (l'appelant doit alors ne pas l'afficher).
 */
export function WeeklyScheduleEditor({ initial, onChange }: { initial: readonly WeeklySlot[]; onChange: (slots: WeeklySlot[]) => void }) {
  const [days, setDays] = useState<Record<number, DayState>>(() => toState(initial));

  const update = (day: number, patch: Partial<DayState>) => {
    setDays((prev) => {
      const next = { ...prev, [day]: { ...prev[day], ...patch } };
      onChange(toSlots(next));
      return next;
    });
  };

  return (
    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {DAYS.map(({ day, label }) => (
        <div key={day} className="flex items-center gap-4 px-4 py-2">
          <label className="flex w-36 flex-shrink-0 items-center gap-2 text-sm">
            <input type="checkbox" checked={days[day].on} onChange={(e) => update(day, { on: e.target.checked })} />
            {label}
          </label>
          <input
            type="time"
            disabled={!days[day].on}
            value={days[day].start}
            onChange={(e) => update(day, { start: e.target.value })}
            className={`${inputClass} !mt-0 w-32`}
            aria-label={`${label} : début`}
          />
          <span className="text-slate-400">à</span>
          <input
            type="time"
            disabled={!days[day].on}
            value={days[day].end}
            onChange={(e) => update(day, { end: e.target.value })}
            className={`${inputClass} !mt-0 w-32`}
            aria-label={`${label} : fin`}
          />
        </div>
      ))}
    </div>
  );
}
