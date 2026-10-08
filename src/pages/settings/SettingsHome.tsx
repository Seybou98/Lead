import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Clock, FileText, GitBranch, History, ListChecks, Mail, Package, Repeat, Route as RouteIcon, Tag, Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sinceLabel } from '../../domain/cockpit/cockpit';
import { SchedulerStatusCard } from './SchedulerStatusCard';
import { useConfigData } from './useConfigData';

const MODULE_OF: Record<string, { label: string; href: string }> = {
  'settings:sla': { label: 'SLA et horaires', href: '/parametres/sla' },
  'settings:rules': { label: 'Cycles NR et relances', href: '/parametres/cycles' },
  checklist: { label: 'Documents', href: '/parametres/documents' },
  campaign: { label: 'Campagnes', href: '/campagnes' },
  team: { label: 'Équipes', href: '/utilisateurs' },
  profile: { label: 'Utilisateurs', href: '/utilisateurs' },
  source: { label: 'Sources', href: '/campagnes' },
  assignment: { label: "Règles d'attribution", href: '/parametres/attribution' },
};

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

function moduleKey(entityType: string, entityId: string): string | null {
  if (entityType === 'settings') return entityId === 'rules' ? 'settings:rules' : entityId.startsWith('sla') ? 'settings:sla' : null;
  return entityType in MODULE_OF ? entityType : null;
}

type Chip = { tone: 'green' | 'red' | 'amber' | 'blue' | 'grey'; label: string };
const CHIP: Record<Chip['tone'], string> = { green: 'bg-emerald-50 text-emerald-700', red: 'bg-red-50 text-red-700', amber: 'bg-amber-50 text-amber-800', blue: 'bg-blue-50 text-blue-700', grey: 'bg-slate-100 text-slate-600' };

interface ModuleCard {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  href?: string;
  chip: Chip;
}

/**
 * Centre de paramétrage métier (§21.1, fig. 25) : un coup d'œil sur chaque module, les alertes de cohérence de la
 * configuration et les dernières modifications. Un module qui n'est pas encore construit est annoncé comme tel,
 * jamais présenté comme « à jour ».
 */
export function SettingsHome() {
  const data = useConfigData();
  const [filter, setFilter] = useState('all');
  const now = Date.now();

  const productAlerts = data.alerts.filter((a) => /^(checklist|telepros|team|campaign-product):/.test(a.id));
  const checklistAlerts = data.alerts.filter((a) => a.id.startsWith('checklist:'));
  const blocking = data.alerts.filter((a) => a.level === 'blocking').length;

  const cards: ModuleCard[] = [
    { title: 'Produits & offres', subtitle: `${data.catalog.categories.length} famille${data.catalog.categories.length > 1 ? 's' : ''} du catalogue`, icon: Package, tone: 'bg-blue-100 text-blue-600', href: '/parametres/produits', chip: productAlerts.length ? { tone: 'red', label: `${productAlerts.length} anomalie${productAlerts.length > 1 ? 's' : ''}` } : { tone: 'green', label: 'À jour' } },
    { title: 'Qualification', subtitle: 'Formulaire de fin d’appel', icon: BookOpen, tone: 'bg-amber-100 text-amber-600', chip: { tone: 'grey', label: 'À venir' } },
    { title: 'Documents', subtitle: `${data.checklistCount} checklist${data.checklistCount > 1 ? 's' : ''} enregistrée${data.checklistCount > 1 ? 's' : ''}`, icon: FileText, tone: 'bg-red-100 text-red-500', href: '/parametres/documents', chip: checklistAlerts.length ? { tone: 'red', label: `${checklistAlerts.length} sans checklist` } : { tone: 'green', label: 'À jour' } },
    { title: 'Workflows & statuts', subtitle: 'Parcours du lead', icon: Workflow, tone: 'bg-emerald-100 text-emerald-600', chip: { tone: 'grey', label: 'À venir' } },
    { title: 'Motifs & listes', subtitle: 'Motifs de clôture, de rappel…', icon: ListChecks, tone: 'bg-violet-100 text-violet-600', chip: { tone: 'grey', label: 'À venir' } },
    { title: 'Règles de conversion', subtitle: 'Critères de création de la vente', icon: GitBranch, tone: 'bg-orange-100 text-orange-600', chip: { tone: 'grey', label: 'Avec le lot Conversion' } },
    { title: 'Communications', subtitle: 'Aucun canal d’envoi en V1', icon: Mail, tone: 'bg-blue-100 text-blue-600', chip: { tone: 'grey', label: 'À venir' } },
    { title: 'Versions & publication', subtitle: `${data.audit.filter((a) => moduleKey(a.entityType, a.entityId) && ['settings:sla', 'settings:rules', 'checklist'].includes(moduleKey(a.entityType, a.entityId) as string)).length} enregistrement(s) tracé(s)`, icon: Tag, tone: 'bg-indigo-100 text-indigo-600', href: '/parametres/versions', chip: { tone: 'blue', label: 'Historique' } },
  ];
  const run: ModuleCard[] = [
    { title: "Règles d'attribution", subtitle: 'Critères, ordre de priorité, plafond, simulation', icon: RouteIcon, tone: 'bg-blue-100 text-blue-600', href: '/parametres/attribution', chip: { tone: 'blue', label: 'Par campagne' } },
    { title: 'SLA & horaires', subtitle: 'Délais, réattribution, horaires, jours fermés', icon: Clock, tone: 'bg-blue-100 text-blue-600', href: '/parametres/sla', chip: data.settings.saved.sla ? { tone: 'green', label: 'Enregistré' } : { tone: 'amber', label: 'Valeurs du cahier' } },
    { title: 'Cycles NR, rappels et documents', subtitle: 'Matrice NR1 à NR5, recyclage, relances', icon: Repeat, tone: 'bg-blue-100 text-blue-600', href: '/parametres/cycles', chip: data.settings.saved.rules ? { tone: 'green', label: 'Enregistré' } : { tone: 'amber', label: 'Valeurs du cahier' } },
  ];

  const recent = useMemo(
    () => data.audit.map((a) => ({ a, mod: moduleKey(a.entityType, a.entityId) })).filter((x): x is { a: (typeof data.audit)[number]; mod: string } => x.mod !== null && (filter === 'all' || x.mod === filter)).slice(0, 6),
    [data.audit, filter]
  );
  const last = data.audit.find((a) => moduleKey(a.entityType, a.entityId) !== null);

  const Card = ({ c }: { c: ModuleCard }) => {
    const Icon = c.icon;
    const body = (
      <>
        <span className={cn('flex h-11 w-11 items-center justify-center rounded-full', c.tone)}><Icon className="h-5 w-5" /></span>
        <h3 className="mt-3 font-semibold text-slate-900">{c.title}</h3>
        <p className="mt-0.5 text-sm text-slate-500">{c.subtitle}</p>
        <div className="mt-4 flex items-center justify-between">
          <span className={cn('rounded-md px-2 py-1 text-xs font-medium', CHIP[c.chip.tone])}>{c.chip.label}</span>
          {c.href && <ArrowRight className="h-4 w-4 text-slate-400" />}
        </div>
      </>
    );
    return c.href ? (
      <Link to={c.href} className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-blue-300 hover:shadow-sm">{body}</Link>
    ) : (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-5 opacity-80" aria-label={`${c.title} : ${c.chip.label}`}>{body}</div>
    );
  };

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Paramétrage métier</h1>
          <p className="mt-1 text-slate-500">Configurez vos produits, règles et parcours sans intervention technique.</p>
        </div>
        <p className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600" role="status">
          <History className="h-4 w-4" />
          {last ? `Dernière modification : il y a ${sinceLabel(last.atMs, now)} par ${data.userNames.get(last.actorId) ?? 'un administrateur'}` : data.loading ? 'Lecture…' : 'Aucune modification enregistrée'}
        </p>
      </div>
      {data.error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{data.error}</p>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map((c) => <Card key={c.title} c={c} />)}</div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Distribution et relances</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{run.map((c) => <Card key={c.title} c={c} />)}</div>

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label="Alertes de configuration">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <AlertTriangle className={cn('h-5 w-5', blocking ? 'text-red-600' : 'text-amber-500')} /> Alertes de configuration
            {data.alerts.length > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{data.alerts.length}</span>}
          </h2>
          {data.alerts.length === 0 ? (
            <p className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> {data.loading ? 'Analyse en cours…' : 'Aucune anomalie : la configuration est cohérente.'}</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {data.alerts.map((a) => (
                <li key={a.id}>
                  <Link to={a.href} className="flex items-start gap-3 py-3 hover:bg-slate-50">
                    <AlertTriangle className={cn('mt-0.5 h-4 w-4 flex-shrink-0', a.level === 'blocking' ? 'text-red-600' : 'text-amber-500')} aria-label={a.level === 'blocking' ? 'Bloquant' : 'Avertissement'} />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-900">{a.title}</span><span className="block text-xs text-slate-500">{a.detail}</span></span>
                    <ArrowRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label="Modifications récentes">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><History className="h-5 w-5 text-slate-500" /> Modifications récentes</h2>
            <select aria-label="Filtrer par module" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm">
              <option value="all">Tous les modules</option>
              {Object.entries(MODULE_OF).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </div>
          {recent.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">{data.loading ? 'Chargement…' : 'Aucune modification pour ce filtre.'}</p>
          ) : (
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th scope="col" className="py-1.5 font-medium">Auteur</th><th scope="col" className="py-1.5 font-medium">Module</th><th scope="col" className="py-1.5 font-medium">Horodatage</th><th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map(({ a, mod }) => {
                  const name = data.userNames.get(a.actorId) ?? (a.actorId === 'engine' ? 'Moteur' : 'Administrateur');
                  return (
                    <tr key={a.id}>
                      <td className="py-2"><span className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">{initials(name)}</span>{name}</span></td>
                      <td className="py-2 text-slate-700">{MODULE_OF[mod].label}</td>
                      <td className="py-2 text-slate-500">{new Date(a.atMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="py-2 text-right"><Link to={MODULE_OF[mod].href} aria-label={`Ouvrir ${MODULE_OF[mod].label}`} className="text-slate-400 hover:text-blue-700"><ArrowRight className="inline h-4 w-4" /></Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <SchedulerStatusCard />
    </div>
  );
}
