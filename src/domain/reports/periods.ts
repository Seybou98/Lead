// Périodes proposées par les rapports (§22.1). Bornes calculées dans le fuseau du navigateur ; `toMs` est exclue.

export const PERIODS = ['month', 'prev_month', 'last30', 'quarter'] as const;
export type PeriodKey = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<PeriodKey, string> = { month: 'Ce mois', prev_month: 'Mois précédent', last30: '30 derniers jours', quarter: 'Trimestre en cours' };

export function periodRange(key: PeriodKey, nowMs: number): { fromMs: number; toMs: number } {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = d.getMonth();
  switch (key) {
    case 'month':
      return { fromMs: new Date(y, m, 1).getTime(), toMs: new Date(y, m + 1, 1).getTime() };
    case 'prev_month':
      return { fromMs: new Date(y, m - 1, 1).getTime(), toMs: new Date(y, m, 1).getTime() };
    case 'last30': {
      const end = new Date(y, m, d.getDate() + 1).getTime();
      return { fromMs: end - 30 * 86_400_000, toMs: end };
    }
    case 'quarter': {
      const q = Math.floor(m / 3) * 3;
      return { fromMs: new Date(y, q, 1).getTime(), toMs: new Date(y, q + 3, 1).getTime() };
    }
  }
}
