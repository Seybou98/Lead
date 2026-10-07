import { Link } from 'react-router-dom';
import { Clock, ListChecks, Repeat, Route as RouteIcon, ShieldCheck } from 'lucide-react';

interface Item {
  title: string;
  description: string;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  section: string;
}

const ITEMS: Item[] = [
  { title: "Règles d'attribution", description: "Critères d'éligibilité, ordre de priorité, capacité et simulation, par campagne.", href: '/parametres/attribution', icon: RouteIcon, section: '§19.3' },
  { title: 'SLA et horaires', description: "Délai de prise en charge, alertes sonores, horaires commerciaux et jours fermés.", icon: Clock, section: '§5, §14' },
  { title: 'Cycles NR et rappels', description: 'Matrice NR1 à NR5, rappels client, recyclage.', icon: Repeat, section: '§8, §14' },
  { title: 'Documents et checklists', description: 'Pièces attendues par produit, aide et financement.', icon: ListChecks, section: '§10, §21.4' },
  { title: 'Motifs et conversion', description: 'Listes de motifs, critères bloquants et dérogations.', icon: ShieldCheck, section: '§21.6, §21.7' },
];

export function SettingsHome() {
  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold text-slate-900">Paramètres</h1>
      <p className="mt-1 text-slate-500">Réglez le CRM sans intervention technique.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ITEMS.map((i) => {
          const Icon = i.icon;
          const body = (
            <>
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Icon className="h-5 w-5" /></span>
                <h2 className="font-semibold text-slate-900">{i.title}</h2>
              </div>
              <p className="mt-3 text-sm text-slate-600">{i.description}</p>
              <p className="mt-3 text-xs text-slate-400">{i.href ? `Cahier des charges ${i.section}` : `À construire — cahier des charges ${i.section}`}</p>
            </>
          );
          return i.href ? (
            <Link key={i.title} to={i.href} className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-blue-300 hover:shadow-sm">{body}</Link>
          ) : (
            <div key={i.title} className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-5 opacity-70">{body}</div>
          );
        })}
      </div>
    </div>
  );
}
