// Mise en forme lisible d'horaires hebdomadaires : « Lun.–Ven. : 8h00–20h00, Sam. : 9h00–18h00 ».
// Fonction pure : sert au résumé de la fiche campagne (fig. 16).

export interface SlotLike {
  day: number; // 0 = dimanche … 6 = samedi
  start: string; // "HH:mm"
  end: string;
}

const LABEL: Record<number, string> = { 1: 'Lun.', 2: 'Mar.', 3: 'Mer.', 4: 'Jeu.', 5: 'Ven.', 6: 'Sam.', 0: 'Dim.' };
/** Lundi → dimanche : l'ordre d'affichage français. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** « 08:00 » → « 8h00 ». */
export function formatHour(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? `${Number(m[1])}h${m[2]}` : hhmm;
}

/**
 * Regroupe les jours consécutifs ayant exactement les mêmes plages. Un jour à plusieurs plages
 * (matin et après-midi) affiche toutes ses plages. Aucun horaire : « Aucun horaire défini ».
 */
export function formatWeeklySchedule(slots: readonly SlotLike[]): string {
  const byDay = new Map<number, string>();
  for (const day of ORDER) {
    const ranges = slots
      .filter((s) => s.day === day)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((s) => `${formatHour(s.start)}–${formatHour(s.end)}`);
    if (ranges.length) byDay.set(day, ranges.join(' et '));
  }
  if (byDay.size === 0) return 'Aucun horaire défini';

  const groups: { from: number; to: number; hours: string }[] = [];
  for (const day of ORDER) {
    const hours = byDay.get(day);
    if (!hours) continue;
    const last = groups[groups.length - 1];
    const lastIdx = last ? ORDER.indexOf(last.to) : -1;
    if (last && last.hours === hours && ORDER.indexOf(day) === lastIdx + 1) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  return groups.map((g) => `${g.from === g.to ? LABEL[g.from] : `${LABEL[g.from]}–${LABEL[g.to]}`} : ${g.hours}`).join(', ');
}
