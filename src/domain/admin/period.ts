// Périodes prédéfinies des écrans d'administration. Bornes en heure LOCALE du navigateur (une seule
// entreprise, un seul fuseau). Borne basse incluse, borne haute exclue.

export type PeriodKey = 'today' | '7d' | '30d' | 'this_month' | 'last_month' | 'all';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Aujourd'hui",
  '7d': '7 derniers jours',
  '30d': '30 derniers jours',
  this_month: 'Ce mois-ci',
  last_month: 'Mois dernier',
  all: 'Toute la période',
};

// Arithmétique de CALENDRIER (new Date(a, m, j ± n)) et non « ± 24 h » : un jour dure 23 ou 25 h
// aux changements d'heure, et une soustraction en millisecondes décalerait la borne d'une heure.
const dayStart = (d: Date, offsetDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();

export function periodRange(key: PeriodKey, nowMs: number): { fromMs: number | null; toMs: number | null } {
  const now = new Date(nowMs);
  switch (key) {
    case 'today':
      return { fromMs: dayStart(now), toMs: dayStart(now, 1) };
    case '7d':
      return { fromMs: dayStart(now, -6), toMs: dayStart(now, 1) };
    case '30d':
      return { fromMs: dayStart(now, -29), toMs: dayStart(now, 1) };
    case 'this_month':
      return { fromMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), toMs: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() };
    case 'last_month':
      return { fromMs: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), toMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
    case 'all':
      return { fromMs: null, toMs: null };
  }
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('fr-FR') + s.slice(1);

/** Libellé d'une période : « Octobre 2026 » pour le mois courant (comme la maquette), sinon le libellé fixe. */
export function periodLabel(key: PeriodKey, nowMs: number): string {
  if (key !== 'this_month' && key !== 'last_month') return PERIOD_LABELS[key];
  const r = periodRange(key, nowMs);
  return capitalize(new Date(r.fromMs as number).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
}
