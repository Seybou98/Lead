import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useConfigData } from './useConfigData';

const CHECKLIST_CHIP = {
  own: { label: 'Propre', cls: 'bg-emerald-50 text-emerald-700' },
  default: { label: 'Par défaut', cls: 'bg-blue-50 text-blue-700' },
  builtin: { label: "Liste d'origine", cls: 'bg-amber-50 text-amber-800' },
} as const;

/**
 * Produits & couverture (§21.2, fig. 26) : pour chaque famille du catalogue du CRM principal, ce qui la couvre dans le
 * CRM Leads (checklist, équipes, télépros, campagnes) et les anomalies. Le catalogue lui-même reste celui du CRM
 * principal : on n'y recopie ni n'y modifie rien d'ici.
 */
export function ProductsPage() {
  const data = useConfigData();
  const alertsOf = (product: string) => data.alerts.filter((a) => a.id.endsWith(`:${product}`));
  const articles = new Map(data.catalog.categories.map((c) => [c.code, c]));

  return (
    <div className="w-full">
      <nav aria-label="Fil d'Ariane" className="text-sm text-slate-500">
        <Link to="/parametres" className="text-blue-600 hover:underline">Paramètres</Link>
        <span className="mx-2">/</span>
        <span>Produits &amp; offres</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Produits &amp; offres</h1>
      <p className="mt-1 text-slate-500">Les produits viennent du catalogue du CRM principal. Voyez ici ce qui les couvre dans le CRM Leads.</p>
      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>{['Produit', 'Articles', 'Checklist', 'Équipes', 'Télépros', 'Campagnes actives', 'État'].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.coverage.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">{data.loading ? 'Chargement du catalogue…' : 'Le catalogue du CRM principal ne contient aucune famille de produit.'}</td></tr>}
            {data.coverage.map((c) => {
              const alerts = alertsOf(c.product);
              const chip = CHECKLIST_CHIP[c.checklist];
              return (
                <tr key={c.product} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-3"><span className="font-semibold text-slate-900">{c.product}</span><span className="block text-xs text-slate-400">{articles.get(c.product)?.samples.slice(0, 2).join(', ')}</span></td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{articles.get(c.product)?.count ?? 0}</td>
                  <td className="px-3 py-3"><Link to={`/parametres/documents?famille=${encodeURIComponent(c.product)}`} className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:underline', chip.cls)}>{chip.label} <ExternalLink className="h-3 w-3" /></Link></td>
                  <td className="px-3 py-3 text-slate-700">{c.teams.length ? c.teams.join(', ') : <span className="text-slate-400">Aucune</span>}</td>
                  <td className="px-3 py-3 tabular-nums text-slate-700">{c.telepros}</td>
                  <td className="px-3 py-3 text-slate-700">{c.activeCampaigns.length ? c.activeCampaigns.join(', ') : <span className="text-slate-400">Aucune</span>}</td>
                  <td className="px-3 py-3">
                    {alerts.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> À jour</span>
                    ) : (
                      <ul className="space-y-1">
                        {alerts.map((a) => (
                          <li key={a.id}><Link to={a.href} className={cn('inline-flex items-start gap-1 text-xs font-medium hover:underline', a.level === 'blocking' ? 'text-red-700' : 'text-amber-800')}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{a.title}</Link></li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">Éligibilité, aides et offres combinées (§21.2) : pas encore paramétrables ; un produit se rattache aux campagnes, aux équipes et aux profils par sa famille.</p>
    </div>
  );
}
