import { Construction } from 'lucide-react';

/** Écran provisoire : indique la section du cahier des charges et la phase qui le construit. */
export function Placeholder({
  title,
  description,
  section,
  phase,
}: {
  title: string;
  description: string;
  section: string;
  phase: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-slate-500">{description}</p>
      <div className="mt-8 flex items-start gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-5">
        <Construction className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
        <div className="text-sm text-slate-600">
          <p className="font-medium text-slate-800">À construire — {phase}</p>
          <p className="mt-1">Référence cahier des charges : {section}.</p>
        </div>
      </div>
    </div>
  );
}
