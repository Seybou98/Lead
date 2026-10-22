import { useState } from 'react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import type { ReportFilters } from '../../domain/reports/direction';
import { ExportsView } from './ExportsView';
import { HistoryView } from './HistoryView';
import { ScheduledView } from './ScheduledView';
import type { ReportsData } from './useReportsData';

type Tab = 'now' | 'scheduled' | 'history';
const TABS: [Tab, string][] = [['now', 'Exports'], ['scheduled', 'Rapports programmés'], ['history', 'Historique']];

/** Onglet « Exports » (fig. 34) : à la demande, rapports programmés, historique des envois. */
export function ExportsHub({ data, filters, now }: { data: ReportsData; filters: ReportFilters; now: number }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('now');
  // Un manager ne règle rien : il retrouve ce qui lui est envoyé, dans l'historique.
  const tabs = user?.role === 'admin' ? TABS : TABS.filter(([k]) => k !== 'scheduled');
  return (
    <div>
      <div role="tablist" aria-label="Exports" className="mt-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={cn('rounded-md px-3 py-1.5 font-medium', tab === k ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'text-slate-600 hover:text-slate-900')}>{label}</button>
        ))}
      </div>
      {tab === 'now' && <ExportsView data={data} filters={filters} now={now} />}
      {tab === 'scheduled' && <ScheduledView data={data} now={now} />}
      {tab === 'history' && <HistoryView />}
    </div>
  );
}
