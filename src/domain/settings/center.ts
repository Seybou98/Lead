// Centre de paramétrage métier (§21.1, §21.10, fig. 25) : couverture des produits et alertes de cohérence de la
// configuration. Fonctions PURES, sans Firestore : l'écran leur passe ce qu'il a lu. Rien n'est inventé : une alerte
// n'existe que si la donnée la justifie, et chacune renvoie à l'écran qui permet de la résoudre.

import { normalizeText } from '../engine/normalize';
import { checklistKey, DEFAULT_CHECKLIST_KEY, parseChecklist } from '../documents/checklist';
import type { SlaSettings } from './settings';

export type AlertLevel = 'blocking' | 'warning';

export interface ConfigAlert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  /** Écran qui permet de la résoudre. */
  href: string;
}

export interface CoverageInput {
  /** Familles du catalogue du CRM principal. */
  categories: readonly string[];
  /** Documents bruts de cl_checklists, par clé. */
  checklists: Readonly<Record<string, unknown>>;
  teams: readonly { id: string; name: string; active: boolean; productCodes: readonly string[] }[];
  /** Télépros avec profil de distribution : leur périmètre produit. */
  profiles: readonly { uid: string; productCodes: readonly string[] }[];
  campaigns: readonly { id: string; name: string; status: string; productCode: string | null }[];
}

export interface ProductCoverage {
  product: string;
  /** own : liste propre · default : liste par défaut éditée · builtin : liste d'origine du CRM. */
  checklist: 'own' | 'default' | 'builtin';
  teams: string[];
  telepros: number;
  activeCampaigns: string[];
}

const covers = (scope: readonly string[], product: string) => scope.includes('*') || scope.some((p) => normalizeText(p) === normalizeText(product));

export function productCoverage(input: CoverageInput): ProductCoverage[] {
  const hasDefault = parseChecklist(input.checklists[DEFAULT_CHECKLIST_KEY]) !== null;
  return input.categories.map((product) => ({
    product,
    checklist: parseChecklist(input.checklists[checklistKey(product)]) ? 'own' : hasDefault ? 'default' : 'builtin',
    teams: input.teams.filter((t) => t.active && covers(t.productCodes, product)).map((t) => t.name),
    telepros: input.profiles.filter((p) => covers(p.productCodes, product)).length,
    activeCampaigns: input.campaigns.filter((c) => c.status === 'active' && c.productCode !== null && normalizeText(c.productCode) === normalizeText(product)).map((c) => c.name),
  }));
}

/**
 * Anomalies de configuration. « Bloquante » : des leads réels sont déjà touchés (campagne active sans télépro éligible).
 * « Avertissement » : à corriger, sans effet immédiat sur un lead.
 */
export function buildConfigAlerts(input: CoverageInput, ctx: { sla: SlaSettings; settingsSaved: { sla: boolean; rules: boolean } }): ConfigAlert[] {
  const out: ConfigAlert[] = [];
  const known = new Set(input.categories.map(normalizeText));

  for (const c of productCoverage(input)) {
    const active = c.activeCampaigns.length > 0;
    if (c.checklist === 'builtin') {
      out.push({
        id: `checklist:${c.product}`,
        level: active ? 'blocking' : 'warning',
        title: `Produit ${c.product} sans checklist`,
        detail: active ? `La campagne ${c.activeCampaigns.join(', ')} demande des documents avec la liste d’origine du CRM.` : 'Aucune checklist propre ni par défaut : la liste d’origine du CRM serait utilisée.',
        href: `/parametres/documents?famille=${encodeURIComponent(c.product)}`,
      });
    }
    if (active && c.telepros === 0) {
      out.push({ id: `telepros:${c.product}`, level: 'blocking', title: `Aucun télépro éligible pour ${c.product}`, detail: `Campagne active : ${c.activeCampaigns.join(', ')}. Ses leads iront en file tampon.`, href: '/utilisateurs' });
    }
    if (active && c.teams.length === 0) {
      out.push({ id: `team:${c.product}`, level: 'warning', title: `Produit ${c.product} sans équipe`, detail: `Aucune équipe active ne couvre ce produit (campagne ${c.activeCampaigns.join(', ')}).`, href: '/utilisateurs' });
    }
  }

  for (const camp of input.campaigns) {
    if (camp.status !== 'active' || camp.productCode === null) continue;
    if (!known.has(normalizeText(camp.productCode))) {
      out.push({ id: `campaign-product:${camp.id}`, level: 'warning', title: `Produit hors catalogue : ${camp.productCode}`, detail: `La campagne ${camp.name} vise un produit absent du catalogue du CRM principal.`, href: `/campagnes/${camp.id}` });
    }
  }

  if (!ctx.settingsSaved.sla) out.push({ id: 'sla-unsaved', level: 'warning', title: 'SLA et horaires non enregistrés', detail: 'Les valeurs du cahier des charges s’appliquent ; enregistrez-les pour les valider.', href: '/parametres/sla' });
  if (!ctx.settingsSaved.rules) out.push({ id: 'rules-unsaved', level: 'warning', title: 'Cycles NR et relances non enregistrés', detail: 'Les valeurs du cahier des charges s’appliquent ; enregistrez-les pour les valider.', href: '/parametres/cycles' });
  if (ctx.sla.autoReassign && !ctx.sla.fallbackTeamId) {
    out.push({ id: 'fallback-missing', level: 'warning', title: 'Réattribution automatique sans équipe de secours', detail: 'Sans équipe de secours, un lead non pris en charge ne peut passer qu’à l’équipe habituelle.', href: '/parametres/sla' });
  }

  return out.sort((a, b) => Number(b.level === 'blocking') - Number(a.level === 'blocking') || a.title.localeCompare(b.title, 'fr'));
}
