// Cycle de publication d'un réglage (§21, §21.9, §21.10) : Brouillon → Tester → Vérifier l'impact → Publier.
//
//   « Une modification en préparation n'affecte aucun lead réel. Elle devient applicable uniquement après validation de sa
//    cohérence, simulation et publication explicite. »
//
// Un brouillon est un document à part (`cl_settings/draft_<module>`) : le moteur, les écrans et les fonctions serveur ne lisent
// QUE le réglage publié (sla, rules, conversion, reasons, messages). Le brouillon porte la saisie de l'administrateur et le
// réglage qu'elle produirait. Fonctions pures : les contrôles, la simulation (données fictives, aucun lead ni message créé) et
// l'analyse d'impact (leads actifs concernés) sont testables seuls.

import { CLOSED_LEAD_STATUSES } from '../enums';
import { formatDelay, parseConversionSettings, parseRulesSettings, parseSlaSettings, validateConversionSettings, validateRulesSettings, validateSlaSettings, OUTSIDE_HOURS_LABELS } from './settings';
import { parseReasonSettings, REASON_LISTS, REASON_LIST_LABELS, validateReasonSettings } from './reasons';
import { CHANNEL_LABELS, MESSAGE_TRIGGERS, parseMessageTemplates, renderTemplate, TRIGGER_INFO, triggersFor, validateMessages } from '../messages/templates';
import { AID_LABELS, campaignZoneConflicts, parseProductRules, ruleFor, validateProductRules, zoneStatus } from '../products/rules';
import type { LeadListItem } from '../leads/leadList';
import { describeChanges, type VersionModule } from './versions';

export const DRAFT_MODULES = ['sla', 'rules', 'conversion', 'reasons', 'messages', 'products'] as const;
export type DraftModule = (typeof DRAFT_MODULES)[number];

export const DRAFT_LABELS: Record<DraftModule, string> = {
  sla: 'SLA et horaires',
  rules: 'Cycles NR, rappels et documents',
  conversion: 'Verrous de conversion',
  reasons: 'Motifs et listes',
  messages: 'Modèles de message',
  products: 'Produits et offres',
};
export const DRAFT_PAGES: Record<DraftModule, string> = { sla: '/parametres/sla', rules: '/parametres/cycles', conversion: '/parametres/conversion', reasons: '/parametres/motifs', messages: '/parametres/messages', products: '/parametres/produits' };

export const isDraftModule = (v: unknown): v is DraftModule => typeof v === 'string' && (DRAFT_MODULES as readonly string[]).includes(v);
export const draftDocId = (m: DraftModule): string => `draft_${m}`;
/** Identifiant du document publié (celui que lisent le moteur et les écrans). */
export const publishedDocId = (m: DraftModule): string => m;

export interface DraftMeta {
  atMs: number;
  byId: string;
  /** Date d'enregistrement du réglage publié au moment du brouillon : sert à détecter qu'il a changé depuis. */
  baseMs: number;
}

export interface Draft {
  /** Réglage tel qu'il serait publié (même forme que le document publié). */
  doc: Record<string, unknown>;
  meta: DraftMeta;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

/** Lecture tolérante d'un document `draft_<module>` ; null s'il n'y a pas de brouillon exploitable. */
export function parseDraft(raw: unknown): Draft | null {
  const x = rec(raw);
  const doc = rec(x.doc);
  const atMs = num(x.atMs);
  if (Object.keys(doc).length === 0 || atMs === null) return null;
  return { doc, meta: { atMs, byId: typeof x.byId === 'string' ? x.byId : '', baseMs: num(x.baseMs) ?? 0 } };
}

/** Le réglage publié a changé depuis l'enregistrement du brouillon : publier écraserait une modification plus récente. */
export const isStale = (d: Draft, publishedUpdatedMs: number | null): boolean => (publishedUpdatedMs ?? 0) !== d.meta.baseMs;

// ── Contrôles et simulation ──────────────────────────────────────────────────

export interface Check {
  level: 'error' | 'warning' | 'ok';
  text: string;
}

export interface Simulation {
  /** Anomalies : une erreur bloque la publication, un avertissement se lit et s'accepte. */
  checks: Check[];
  /** Ce que le réglage donnerait avec des données fictives (rien n'est créé, aucun message n'est envoyé). */
  examples: string[];
}

const err = (errors: readonly string[]): Check[] => errors.map((text) => ({ level: 'error', text }));
const min = (m: number): string => formatDelay(m);

/** Données de contexte de la simulation et de l'impact (campagnes) : lues par l'appelant, jamais modifiées. */
export interface PublicationContext {
  campaigns?: readonly { name: string; productCode: string | null; zones?: readonly string[]; status: string }[];
}

export function simulateDraft(module: DraftModule, doc: unknown, ctx: PublicationContext = {}): Simulation {
  const checks: Check[] = [];
  const examples: string[] = [];
  if (module === 'sla') {
    const s = parseSlaSettings(doc);
    checks.push(...err(validateSlaSettings(s)));
    if (s.firstAlertMin > 15) checks.push({ level: 'warning', text: `Première alerte à ${min(s.firstAlertMin)} : un lead neuf peut attendre longtemps avant d'être signalé.` });
    if (s.schedule.weekly.length === 0) checks.push({ level: 'warning', text: 'Aucun horaire d’ouverture : le temps hors horaires ne sera jamais décompté correctement.' });
    if (s.autoReassign && !s.fallbackTeamId) checks.push({ level: 'warning', text: 'Réattribution automatique activée sans équipe de secours : un lead sans télépro disponible reste en file tampon.' });
    examples.push(`Un lead neuf reçu pendant les horaires : première alerte après ${min(s.firstAlertMin)}, retard critique après ${min(s.criticalMin)}.`);
    examples.push(s.autoReassign ? `Réattribution automatique après ${min(s.reassignMin)} (au plus ${s.maxReassignments} fois).` : 'Pas de réattribution automatique : le manager décide.');
    examples.push(`Hors horaires : ${OUTSIDE_HOURS_LABELS[s.outsideHours]}${s.suspendOutsideHours ? ' ; le temps hors horaires ne compte pas comme retard' : ''}.`);
  } else if (module === 'rules') {
    const s = parseRulesSettings(doc);
    checks.push(...err(validateRulesSettings(s)));
    if (s.maxRecycleCycles === 0) checks.push({ level: 'warning', text: 'Aucun cycle de recyclage : un lead injoignable est archivé dès la fin du premier cycle.' });
    const [a, b, c, d] = s.nrDelaysMinutes;
    examples.push(`Cycle NR : NR1 → NR2 après ${min(a)}, NR3 après ${min(b)}, NR4 après ${min(c)}, NR5 après ${min(d)} (dans les horaires).`);
    examples.push(`Injoignable : recyclage après ${s.recycleAfterDays} j, archivage après ${s.maxRecycleCycles} cycle${s.maxRecycleCycles > 1 ? 's' : ''}.`);
    examples.push(`Relances documentaires : ${s.followUpDays.map((j) => `J+${j}`).join(', ') || 'aucune'} ; décision tous les ${s.decisionRepeatDays} j.`);
  } else if (module === 'conversion') {
    const s = parseConversionSettings(doc);
    checks.push(...err(validateConversionSettings(s)));
    if (s.maxDiscountPct > 15) checks.push({ level: 'warning', text: `Remise sans validation jusqu'à ${s.maxDiscountPct} % : un dossier fortement remisé ne passera plus par le manager.` });
    if (!s.requireConsent) checks.push({ level: 'warning', text: 'Consentement du client non exigé : un dossier peut être transmis sans consentement enregistré.' });
    if (!s.requireRge) checks.push({ level: 'warning', text: 'Qualification RGE non exigée.' });
    examples.push(`Une remise jusqu'à ${s.maxDiscountPct} % se passe de validation ; au-delà, le manager valide.`);
    examples.push(`Éligibilité aux aides : ${s.requireEligibility ? 'exigée (sinon validation du manager)' : 'non exigée'} · RGE : ${s.requireRge ? 'exigée' : 'non exigée'} · consentement : ${s.requireConsent ? 'exigé (sinon validation du manager)' : 'non exigé'}.`);
    examples.push('Toujours bloquants, sans réglage : documents, identité, offre, montants, CEE, éligibilité refusée.');
  } else if (module === 'reasons') {
    const s = parseReasonSettings(doc);
    checks.push(...err(validateReasonSettings(s)));
    for (const l of REASON_LISTS) {
      const active = s[l].filter((i) => i.active).length;
      if (active === 0) checks.push({ level: 'error', text: `${REASON_LIST_LABELS[l].title} : aucune valeur active, la saisie serait impossible.` });
      examples.push(`${REASON_LIST_LABELS[l].title} : ${active} valeur${active > 1 ? 's' : ''} active${active > 1 ? 's' : ''}${s[l].length > active ? `, ${s[l].length - active} archivée${s[l].length - active > 1 ? 's' : ''}` : ''}.`);
    }
  } else if (module === 'products') {
    const rules = parseProductRules(doc);
    checks.push(...err(validateProductRules(rules)));
    for (const r of rules) {
      const live = (ctx.campaigns ?? []).filter((c) => ruleFor([r], c.productCode) && c.status === 'active');
      if (!r.active && live.length > 0) checks.push({ level: 'warning', text: `${r.code} suspendu alors que ${live.length} campagne${live.length > 1 ? 's' : ''} active${live.length > 1 ? 's' : ''} le vend${live.length > 1 ? 'ent' : ''} (${live.slice(0, 3).map((c) => c.name).join(', ')}).` });
      for (const c of (ctx.campaigns ?? []).filter((x) => ruleFor([r], x.productCode))) {
        const out = campaignZoneConflicts(r, c.zones ?? []);
        if (out.length > 0) checks.push({ level: 'warning', text: `Campagne « ${c.name} » : départements ${out.join(', ')} hors du périmètre de ${r.code}.` });
      }
      if (r.active && r.aids.length === 0) checks.push({ level: 'warning', text: `${r.code} : aucune aide compatible indiquée.` });
      examples.push(`${r.code} : ${r.active ? 'actif' : 'suspendu'} · ${r.zones.length ? `${r.zones.length} département${r.zones.length > 1 ? 's' : ''} (${r.zones.slice(0, 6).join(', ')}${r.zones.length > 6 ? '…' : ''})` : 'toute la France'} · aides : ${r.aids.map((a) => AID_LABELS[a]).join(', ') || 'aucune'} · ${r.criteria.length} critère${r.criteria.length > 1 ? 's' : ''} à confirmer.`);
    }
    if (rules.length === 0) examples.push('Aucune restriction : tous les produits restent actifs, sur toute la France, sans critère.');
  } else {
    const list = parseMessageTemplates(doc);
    checks.push(...err(validateMessages(list)));
    for (const trigger of MESSAGE_TRIGGERS) {
      if (!list.some((t) => t.trigger === trigger && t.active)) checks.push({ level: 'warning', text: `${TRIGGER_INFO[trigger].label} : aucun modèle actif, les télépros n’auront rien à envoyer.` });
    }
    const ctx = { prenom: 'Awa', nom: 'Diallo', produit: 'PAC', telepro: 'Sarah Cohen', pieces: ['Pièce d’identité (illisible)', 'Avis d’imposition'] };
    for (const t of list.filter((x) => x.active).slice(0, 12)) {
      const r = renderTemplate(t, ctx);
      examples.push(`${TRIGGER_INFO[t.trigger].label} · ${CHANNEL_LABELS[t.channel]}${t.product ? ` · ${t.product}` : ''} : ${r.body.split('\n')[0].slice(0, 110)}`);
    }
  }
  if (!checks.some((c) => c.level === 'error')) checks.unshift({ level: 'ok', text: 'Cohérence vérifiée : aucune anomalie bloquante.' });
  return { checks, examples };
}

export const hasBlocking = (s: Simulation): boolean => s.checks.some((c) => c.level === 'error');

// ── Différences ──────────────────────────────────────────────────────────────

/** Ce qui change entre le réglage publié et le brouillon, en phrases lisibles (comparaison ancienne / nouvelle version). */
export function draftChanges(module: DraftModule, published: unknown, draft: Draft): string[] {
  const before = published && Object.keys(rec(published)).length > 0 ? rec(published) : null;
  return describeChanges(module as VersionModule, before, draft.doc).filter((l) => l !== 'Aucun changement de valeur');
}

// ── Impact ───────────────────────────────────────────────────────────────────

export interface ImpactLine {
  label: string;
  /** Nombre de leads concernés ; null quand l'effet n'est pas chiffrable. */
  count: number | null;
  detail: string;
  /** Faire cliquer pour ouvrir : leads concernés. */
  leads?: LeadListItem[];
}

export interface Impact {
  lines: ImpactLine[];
  /** Leads actifs (ni clos ni exclus) examinés. */
  active: number;
  /** Ce que la publication change pour un lead déjà en cours. */
  strategy: string;
}

const isActive = (l: LeadListItem) => !CLOSED_LEAD_STATUSES.includes(l.status) && !l.excluded;

/**
 * Leads actifs concernés par la publication. Ces réglages sont lus au moment de chaque traitement : un lead en cours est
 * évalué avec la NOUVELLE règle dès la publication, mais les échéances déjà calculées (prochaine tentative NR, rappel promis)
 * restent celles qui sont portées par le lead. Seul le constructeur de qualification garde une version par lead.
 */
export function impactOf(module: DraftModule, published: unknown, draft: Draft, leads: readonly LeadListItem[], nowMs: number, ctx: PublicationContext = {}): Impact {
  const active = leads.filter(isActive);
  const lines: ImpactLine[] = [];
  let strategy = 'Les leads en cours sont évalués avec le nouveau réglage dès la publication ; les échéances déjà calculées restent celles du lead.';

  if (module === 'sla') {
    const before = parseSlaSettings(published);
    const after = parseSlaSettings(draft.doc);
    const fresh = active.filter((l) => l.status === 'new' && l.slaStoppedAtMs === null && l.slaStartedAtMs !== null);
    const age = (l: LeadListItem) => nowMs - (l.slaStartedAtMs as number);
    const nowLate = fresh.filter((l) => age(l) > before.firstAlertMin * 60_000);
    const wouldBeLate = fresh.filter((l) => age(l) > after.firstAlertMin * 60_000);
    const becomeLate = wouldBeLate.filter((l) => !nowLate.includes(l));
    const stopLate = nowLate.filter((l) => !wouldBeLate.includes(l));
    lines.push({ label: 'Leads neufs en attente de prise en charge', count: fresh.length, detail: 'Leur compteur continue ; seul le seuil d’alerte change.', leads: fresh });
    lines.push({ label: 'Passeraient « SLA dépassé »', count: becomeLate.length, detail: `Seuil ${formatDelay(before.firstAlertMin)} → ${formatDelay(after.firstAlertMin)}.`, leads: becomeLate });
    lines.push({ label: 'Ne seraient plus « SLA dépassé »', count: stopLate.length, detail: 'Ils sortiraient des alertes du cockpit.', leads: stopLate });
  } else if (module === 'rules') {
    const nr = active.filter((l) => ['nr', 'callback', 'unreachable_cycle_end', 'recycling'].includes(l.status));
    const docs = active.filter((l) => ['awaiting_documents', 'missing_info'].includes(l.status));
    lines.push({ label: 'Leads dans un cycle NR, rappel ou recyclage', count: nr.length, detail: 'Leur prochaine échéance est déjà calculée : les nouveaux délais s’appliquent à la tentative suivante.', leads: nr });
    lines.push({ label: 'Dossiers en relance documentaire', count: docs.length, detail: 'Les nouvelles relances J+n et la décision s’appliquent aux prochaines échéances.', leads: docs });
  } else if (module === 'conversion') {
    const flow = active.filter((l) => ['file_ready_to_build', 'file_building', 'missing_info', 'manager_validation', 'file_ready'].includes(l.status));
    const val = flow.filter((l) => l.status === 'manager_validation');
    lines.push({ label: 'Dossiers en montage, validation ou prêts à transmettre', count: flow.length, detail: 'Les verrous sont recalculés à leur prochaine vérification : un dossier peut devenir bloquant ou ne plus l’être.', leads: flow });
    lines.push({ label: 'Dont en attente de validation du manager', count: val.length, detail: 'Une exigence retirée ou ajoutée peut changer leur décision.', leads: val });
  } else if (module === 'reasons') {
    const before = parseReasonSettings(published);
    const after = parseReasonSettings(draft.doc);
    const used = new Map<string, number>();
    for (const l of leads) if (l.closure?.code) used.set(l.closure.code, (used.get(l.closure.code) ?? 0) + 1);
    for (const list of REASON_LISTS) {
      for (const item of before[list]) {
        const next = after[list].find((i) => i.code === item.code);
        if (item.active && (!next || !next.active)) lines.push({ label: `${REASON_LIST_LABELS[list].title} : « ${item.label} » serait archivée`, count: used.get(item.code) ?? 0, detail: 'Elle reste lisible dans les historiques et les rapports ; elle n’est plus proposée à la saisie.' });
      }
    }
    if (lines.length === 0) lines.push({ label: 'Aucune valeur archivée', count: 0, detail: 'Les changements portent sur des libellés, des ajouts ou des exigences de commentaire.' });
    strategy = 'Une valeur archivée n’est jamais supprimée : les leads et les rapports qui l’utilisent la gardent.';
  } else if (module === 'products') {
    const before = parseProductRules(published);
    const after = parseProductRules(draft.doc);
    for (const r of after) {
      const o = ruleFor(before, r.code);
      const mine = active.filter((l) => ruleFor([r], l.productCode));
      const outNow = mine.filter((l) => zoneStatus(o, l.postalCode) === 'outside');
      const outNext = mine.filter((l) => zoneStatus(r, l.postalCode) === 'outside');
      if (JSON.stringify(o?.zones ?? []) !== JSON.stringify(r.zones)) {
        lines.push({ label: `${r.code} : leads actifs hors périmètre`, count: outNext.length, detail: `${outNow.length} aujourd’hui → ${outNext.length} après publication. Ils ne sont ni clos ni réattribués : le télépro voit seulement « hors zone couverte ».`, leads: outNext });
      }
      if ((o?.active ?? true) && !r.active) lines.push({ label: `${r.code} : leads actifs sur un produit suspendu`, count: mine.length, detail: 'Les leads en cours continuent normalement ; seules de nouvelles campagnes ne le proposent plus.', leads: mine });
      if (JSON.stringify(o?.aids ?? []) !== JSON.stringify(r.aids) || JSON.stringify(o?.criteria ?? []) !== JSON.stringify(r.criteria)) lines.push({ label: `${r.code} : aides ou critères modifiés`, count: mine.length, detail: 'Les télépros voient les nouvelles aides et les nouveaux critères dans la qualification.', leads: mine });
    }
    for (const r of before) if (!ruleFor(after, r.code)) lines.push({ label: `${r.code} : configuration retirée`, count: active.filter((l) => ruleFor([r], l.productCode)).length, detail: 'Le produit redevient actif, sur toute la France, sans critère.' });
    void ctx;
    if (lines.length === 0) lines.push({ label: 'Aucun produit modifié', count: 0, detail: 'Le brouillon est identique au réglage publié.' });
    strategy = 'Périmètre, aides et critères sont des repères pour le télépro : ils ne bloquent aucune conversion et ne changent le statut d’aucun lead.';
  } else {
    const before = parseMessageTemplates(published);
    const after = parseMessageTemplates(draft.doc);
    const idsNow = new Set(before.filter((t) => t.active).map((t) => t.id));
    const idsNext = new Set(after.filter((t) => t.active).map((t) => t.id));
    for (const trigger of MESSAGE_TRIGGERS) {
      const concerned = active.filter((l) => triggersFor({ status: l.status, documentsState: l.documentsState, commercialState: l.commercialState, financialState: l.financialState }).includes(trigger));
      const changed = [...before, ...after].some((t) => t.trigger === trigger && idsNow.has(t.id) !== idsNext.has(t.id));
      const edited = after.some((t) => t.trigger === trigger && before.find((b) => b.id === t.id) && JSON.stringify(before.find((b) => b.id === t.id)) !== JSON.stringify(t));
      if (changed || edited) lines.push({ label: `${TRIGGER_INFO[trigger].label}`, count: concerned.length, detail: 'Leads dont le message à envoyer change dès la publication.', leads: concerned });
    }
    if (lines.length === 0) lines.push({ label: 'Aucun modèle modifié', count: 0, detail: 'Le brouillon est identique au réglage publié.' });
    strategy = 'Aucun message n’est envoyé par le CRM : les télépros voient les nouveaux modèles dans « Messages » dès la publication.';
  }
  return { lines, active: active.length, strategy };
}
