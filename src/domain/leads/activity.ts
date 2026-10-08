// Dernières actions utiles sur un lead (fiche télépro, fig. 22 « Activité en temps réel »). Déduites des dates que le
// serveur inscrit déjà sur le lead : aucune relecture de l'historique, donc pas de lecture supplémentaire par lead.
// « Utile » = une action commerciale réelle ; ouvrir une fiche ou bouger la souris n'en est pas une (§12.7).

export type ActivityKind = 'taken' | 'nr' | 'note' | 'docs_requested' | 'docs_followup' | 'docs_received' | 'docs_complete';

export interface ActivityEntry {
  atMs: number;
  kind: ActivityKind;
  label: string;
}

export interface ActivityInput {
  slaStoppedAtMs: number | null;
  nrLastAtMs: number | null;
  nrAttempt: number;
  noteAtMs: number | null;
  noteText: string | null;
  docsRequestedAtMs: number | null;
  docsFollowUpAtMs: number | null;
  docsReceivedAtMs: number | null;
  docsCompletedAtMs: number | null;
}

const MAX_NOTE = 60;

/** Actions datées d'un lead, de la plus récente à la plus ancienne. Une date absente ou invalide n'en fait pas une action. */
export function buildActivity(i: ActivityInput): ActivityEntry[] {
  const ok = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const out: ActivityEntry[] = [];
  if (ok(i.slaStoppedAtMs)) out.push({ atMs: i.slaStoppedAtMs, kind: 'taken', label: 'Lead pris en charge' });
  if (ok(i.nrLastAtMs)) out.push({ atMs: i.nrLastAtMs, kind: 'nr', label: i.nrAttempt > 0 ? `Pas de réponse (NR${i.nrAttempt})` : 'Pas de réponse' });
  if (ok(i.noteAtMs) && i.noteText) out.push({ atMs: i.noteAtMs, kind: 'note', label: `Note : ${i.noteText.length > MAX_NOTE ? `${i.noteText.slice(0, MAX_NOTE - 1)}…` : i.noteText}` });
  if (ok(i.docsRequestedAtMs)) out.push({ atMs: i.docsRequestedAtMs, kind: 'docs_requested', label: 'Documents demandés' });
  if (ok(i.docsFollowUpAtMs)) out.push({ atMs: i.docsFollowUpAtMs, kind: 'docs_followup', label: 'Relance documentaire' });
  if (ok(i.docsReceivedAtMs)) out.push({ atMs: i.docsReceivedAtMs, kind: 'docs_received', label: 'Pièce reçue' });
  if (ok(i.docsCompletedAtMs)) out.push({ atMs: i.docsCompletedAtMs, kind: 'docs_complete', label: 'Dossier complet' });
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** Dernières actions de plusieurs leads, avec le nom du lead concerné. */
export function recentActivity<T extends { fullName: string; activity?: ActivityEntry[] }>(leads: readonly T[], limit: number): (ActivityEntry & { lead: T })[] {
  return leads
    .flatMap((lead) => (lead.activity ?? []).map((a) => ({ ...a, lead })))
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, limit);
}
