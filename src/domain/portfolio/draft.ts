// Brouillon d'un transfert de portefeuille (fig. 24, « Enregistrer comme brouillon »; §25.9 : une opération longue peut
// être quittée et reprise sans perte). Seul le CHOIX du manager est conservé, jamais le résultat de la simulation :
// à la reprise, le plan est recalculé avec la charge du moment, donc il ne peut pas être périmé.

import { FAMILIES, type Family } from './portfolio';

export const DRAFT_CAUSES = ["Changement d'équipe", 'Absence longue', 'Départ du télépro', 'Rééquilibrage de la charge', 'Autre'] as const;

export interface TransferDraft {
  fromUid: string;
  step: number;
  cause: string;
  reasonOther: string;
  families: Family[];
  destKind: 'engine' | 'users' | 'team';
  destUsers: string[];
  destTeam: string;
}

export const DEFAULT_TRANSFER_DRAFT = (fromUid: string): TransferDraft => ({ fromUid, step: 1, cause: DRAFT_CAUSES[0], reasonOther: '', families: [...FAMILIES], destKind: 'engine', destUsers: [], destTeam: '' });

/** Identifiant : un brouillon par manager et par télépro. */
export const draftId = (actorUid: string, fromUid: string): string => `${actorUid}_${fromUid}`.slice(0, 200);

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Lecture tolérante d'un brouillon enregistré : toute valeur invalide retombe sur le défaut, jamais d'exception. */
export function parseTransferDraft(raw: unknown, fromUid: string): TransferDraft {
  const d = DEFAULT_TRANSFER_DRAFT(fromUid);
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, 50) : []);
  const families = Array.isArray(r.families) ? FAMILIES.filter((f) => (r.families as unknown[]).includes(f)) : d.families;
  return {
    fromUid,
    step: typeof r.step === 'number' && Number.isInteger(r.step) && r.step >= 1 && r.step <= 5 ? r.step : d.step,
    cause: typeof r.cause === 'string' && (DRAFT_CAUSES as readonly string[]).includes(r.cause) ? r.cause : d.cause,
    reasonOther: typeof r.reasonOther === 'string' ? r.reasonOther.slice(0, 200) : '',
    families,
    destKind: r.destKind === 'users' || r.destKind === 'team' || r.destKind === 'engine' ? r.destKind : d.destKind,
    destUsers: ids(r.destUsers),
    destTeam: typeof r.destTeam === 'string' && ID.test(r.destTeam) ? r.destTeam : '',
  };
}
