import { Link } from 'react-router-dom';
import { ArrowRight, Plug, Share2 } from 'lucide-react';

/**
 * Point d'entrée des intégrations (§24, fig. 40). Seule la transmission vers le CRM principal est construite : le hub
 * complet (journal de synchronisation, erreurs et reprises, connecteur Meta) reste à faire.
 */
export function IntegrationsPage() {
  return (
    <div className="w-full">
      <h1 className="text-2xl font-bold text-slate-900">Intégrations</h1>
      <p className="mt-1 text-slate-500">Connecteurs, journal et reprises.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Link to="/integrations/transmission" className="group rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-300 hover:shadow-sm">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Share2 className="h-6 w-6" /></span>
          <h2 className="mt-4 text-base font-semibold text-slate-900">Transmission au CRM principal</h2>
          <p className="mt-1 text-sm text-slate-500">Dossiers prêts, bloqués ou transmis ; reprise d&apos;une transmission en échec.</p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700">Ouvrir <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
        </Link>
        <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><Plug className="h-6 w-6" /></span>
          <p className="mt-4 font-semibold text-slate-700">Journal, erreurs et connecteur Meta</p>
          <p className="mt-1">Pas encore construits (figs. 40 à 43).</p>
        </div>
      </div>
    </div>
  );
}
