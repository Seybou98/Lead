import { CheckCircle2, MapPin, ShieldQuestion } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AID_LABELS, ruleFor, zoneStatus, type ProductRule } from '../../domain/products/rules';
import type { LeadListItem } from '../../domain/leads/leadList';
import { useSettings } from '../settings/useSettings';

/** Repères du produit pour le télépro (§21.2) : la zone du lead est-elle couverte, critères à confirmer, aides proposables. */
export function ProductReferenceView({ rule, lead }: { rule: ProductRule | null; lead: Pick<LeadListItem, 'postalCode' | 'productCode'> }) {
  if (!rule) return null;
  const zone = zoneStatus(rule, lead.postalCode);
  const hasContent = rule.zones.length > 0 || rule.aids.length > 0 || rule.criteria.length > 0 || !rule.active || rule.note;
  if (!hasContent) return null;
  return (
    <section aria-label="Repères du produit" className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <p className="font-semibold text-slate-900">{rule.code} : repères</p>
      {!rule.active && <p className="mt-1 text-xs font-medium text-amber-800">Produit suspendu pour de nouvelles campagnes ; ce lead continue normalement.</p>}
      {zone !== 'all' && (
        <p className={cn('mt-2 flex items-center gap-1.5', zone === 'outside' ? 'font-medium text-amber-800' : zone === 'covered' ? 'text-emerald-700' : 'text-slate-600')}>
          <MapPin className="h-4 w-4" />
          {zone === 'covered' ? 'Zone du lead couverte par ce produit.' : zone === 'outside' ? `Hors zone couverte : ce produit est proposé dans les départements ${rule.zones.join(', ')}.` : 'Code postal absent ou illisible : zone à vérifier.'}
        </p>
      )}
      {rule.aids.length > 0 && <p className="mt-2 flex items-center gap-1.5 text-slate-700"><CheckCircle2 className="h-4 w-4 text-blue-600" /> Aides compatibles : {rule.aids.map((a) => AID_LABELS[a]).join(', ')}.</p>}
      {rule.criteria.length > 0 && (
        <div className="mt-2">
          <p className="flex items-center gap-1.5 text-slate-700"><ShieldQuestion className="h-4 w-4 text-blue-600" /> À confirmer avec le client :</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-9 text-slate-700">{rule.criteria.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {rule.note && <p className="mt-2 text-xs text-slate-500">{rule.note}</p>}
    </section>
  );
}

export function ProductReference({ lead }: { lead: LeadListItem }) {
  const { products } = useSettings();
  return <ProductReferenceView rule={ruleFor(products, lead.productCode)} lead={lead} />;
}
