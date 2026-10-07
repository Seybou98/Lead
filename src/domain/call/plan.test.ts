import { describe, expect, it } from 'vitest';
import { nextWorkingTime } from '../engine/schedule';
import {
  currentNrAttempt,
  DEFAULT_CALL_RULES,
  formatWhen,
  loadDeltaFor,
  nextNrAttemptAt,
  planCallOutcome,
  type QualifyContext,
  type QualifyLead,
} from './plan';
import type { CallOutcomeInput } from './outcomes';

const TZ = 'Europe/Paris';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Mercredi 7 octobre 2026, 10:46 à Paris (CEST = UTC+2)
const NOW = Date.UTC(2026, 9, 7, 8, 46);
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h - 2, m); // heure de Paris, octobre (UTC+2)

const lead = (over: Partial<QualifyLead> = {}): QualifyLead => ({
  id: 'L1',
  status: 'new',
  ownerId: 'u1',
  productCode: 'pac',
  nr: { attempt: 0, cycle: 1 },
  nextActionId: 'L1_take_new_lead',
  ...over,
});

const ctx = (over: Partial<QualifyContext> = {}): QualifyContext => ({
  lead: lead(),
  actorId: 'u1',
  actorRole: 'telepro',
  nowMs: NOW,
  requestId: 'req1',
  durationSeconds: 95,
  rules: DEFAULT_CALL_RULES,
  ...over,
});

const ok = (input: CallOutcomeInput, c = ctx()) => {
  const r = planCallOutcome(input, c);
  if (!r.ok) throw new Error(`refusé : ${r.message}`);
  return r.plan;
};
const ko = (input: CallOutcomeInput, c = ctx()) => {
  const r = planCallOutcome(input, c);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r;
};

describe('nextWorkingTime', () => {
  const s = DEFAULT_CALL_RULES.schedule;
  it("garde l'instant s'il est en horaires", () => {
    expect(nextWorkingTime(s, at(7, 14))).toBe(at(7, 14));
  });
  it("après la fermeture, passe à l'ouverture du lendemain", () => {
    expect(nextWorkingTime(s, at(7, 20))).toBe(at(8, 9));
  });
  it('avant l’ouverture, tombe pile sur 09:00', () => {
    expect(nextWorkingTime(s, at(7, 6, 17))).toBe(at(7, 9));
  });
  it('le vendredi soir, saute le week-end jusqu’au lundi', () => {
    expect(nextWorkingTime(s, at(9, 19, 30))).toBe(at(12, 9));
  });
  it('planning vide : null', () => {
    expect(nextWorkingTime({ timezone: TZ, weekly: [] }, NOW)).toBeNull();
  });
});

describe('NR (§8.1, fig. 6)', () => {
  it('NR1 : programme NR2 selon la matrice, dans les horaires', () => {
    // 10:46 + 3 h = 13:46, mercredi : en horaires
    const p = ok({ kind: 'no_answer' });
    expect(p.status).toBe('nr');
    expect(p.nr).toEqual({ attempt: 1, cycle: 1, lastAtMs: NOW, nextAtMs: NOW + 3 * HOUR });
    expect(p.nextAction).toMatchObject({ type: 'nr_attempt', priority: 'P3', dueAtMs: NOW + 3 * HOUR });
    expect(p.callAttempt.nrNumber).toBe(1);
    expect(p.summary).toContain('NR2');
  });

  it('la tentative tombant hors horaires est reportée à l’ouverture suivante', () => {
    const late = at(7, 17, 30);
    const p = ok({ kind: 'no_answer' }, ctx({ nowMs: late })); // +3h = 20:30 → jeudi 09:00
    expect(p.nr?.nextAtMs).toBe(at(8, 9));
  });

  it('NR2 → NR3 après la tentative 2 ; le compteur avance', () => {
    const p = ok({ kind: 'no_answer' }, ctx({ lead: lead({ status: 'nr', nr: { attempt: 2, cycle: 1 } }) }));
    expect(p.nr?.attempt).toBe(3);
    expect(p.nextAction?.reason).toContain('NR4');
    expect(p.events.map((e) => e.key)).toEqual(['call_result']); // nr → nr : pas de changement de statut
  });

  it('NR5 : fin du cycle, sortie de la file, aucune action, recyclage programmé', () => {
    const p = ok({ kind: 'no_answer' }, ctx({ lead: lead({ status: 'nr', nr: { attempt: 4, cycle: 1 } }) }));
    expect(p.status).toBe('unreachable_cycle_end');
    expect(p.nextAction).toBeNull();
    expect(p.nr?.attempt).toBe(5);
    expect(p.nr?.nextAtMs).toBeGreaterThanOrEqual(NOW + 7 * DAY);
  });

  it('un lead en fin de cycle ou recyclé repart à NR1 du cycle suivant', () => {
    expect(currentNrAttempt({ status: 'unreachable_cycle_end', nr: { attempt: 5, cycle: 1 } })).toEqual({ attempt: 1, cycle: 2 });
    expect(currentNrAttempt({ status: 'recycling', nr: { attempt: 5, cycle: 2 } })).toEqual({ attempt: 1, cycle: 3 });
  });

  it('un nouveau lead démarre à NR1, un lead à rappeler aussi n’avance pas à tort', () => {
    expect(currentNrAttempt({ status: 'new', nr: { attempt: 0, cycle: 1 } })).toEqual({ attempt: 1, cycle: 1 });
    expect(currentNrAttempt({ status: 'nr', nr: { attempt: 1, cycle: 1 } })).toEqual({ attempt: 2, cycle: 1 });
  });

  it('refuse sans créneau de travail configuré', () => {
    const rules = { ...DEFAULT_CALL_RULES, schedule: { timezone: TZ, weekly: [] } };
    expect(ko({ kind: 'no_answer' }, ctx({ rules })).code).toBe('invalid');
  });

  it('nextNrAttemptAt : NR5 n’a pas de suite', () => {
    expect(nextNrAttemptAt(5, NOW, DEFAULT_CALL_RULES)).toBeNull();
    expect(nextNrAttemptAt(1, NOW, DEFAULT_CALL_RULES)).toBe(NOW + 3 * HOUR);
  });

  it('enregistre le commentaire et le refus d’appel dans l’historique', () => {
    const p = ok({ kind: 'no_answer', comment: 'Messagerie', refusedCall: true });
    expect(p.lastNote).toBe('Messagerie');
    expect(p.events[0].meta).toMatchObject({ refusedCall: true, nrNumber: 1 });
  });
});

describe('SLA et compteurs', () => {
  it('le premier résultat valide arrête le compteur SLA d’un lead Nouveau', () => {
    expect(ok({ kind: 'no_answer' }).slaStopAtMs).toBe(NOW);
  });
  it('un lead déjà traité n’a plus de compteur à arrêter', () => {
    expect(ok({ kind: 'no_answer' }, ctx({ lead: lead({ status: 'nr', nr: { attempt: 1, cycle: 1 } }) })).slaStopAtMs).toBeNull();
  });
  it('« nouveaux leads » baisse quand le lead est traité', () => {
    expect(ok({ kind: 'no_answer' }).loadDelta).toEqual({ newLeads: -1 });
  });
  it('loadDeltaFor : changement de seau, et rien si le seau est le même', () => {
    expect(loadDeltaFor('callback', 'interested')).toEqual({ callbacks: -1, interested: 1 });
    expect(loadDeltaFor('nr', 'nr')).toEqual({});
    expect(loadDeltaFor('awaiting_documents', 'missing_info')).toEqual({});
    expect(loadDeltaFor('interested', 'not_interested')).toEqual({ interested: -1 });
  });
  it('le statut change : un événement de statut est écrit avec avant/après', () => {
    const p = ok({ kind: 'no_answer' });
    expect(p.events.map((e) => e.key)).toEqual(['call_result', 'status_changed']);
    expect(p.events[1]).toMatchObject({ before: { status: 'new' }, after: { status: 'nr' } });
  });
  it('clôt l’action en cours', () => {
    expect(ok({ kind: 'no_answer' }).completedActionId).toBe('L1_take_new_lead');
  });
});

describe('À rappeler (fig. 7) et mauvais moment (fig. 13)', () => {
  const cb: CallOutcomeInput = { kind: 'callback', atMs: NOW + 2 * HOUR, reason: 'consult_spouse', comment: 'Rappeler à 18h', confirmed: true };

  it('crée un engagement P0 à l’heure promise', () => {
    const p = ok(cb);
    expect(p.status).toBe('callback');
    expect(p.nextAction).toMatchObject({ type: 'client_callback', priority: 'P0', dueAtMs: NOW + 2 * HOUR });
    expect(p.lastNote).toBe('Rappeler à 18h');
  });
  it('exige date future, motif, commentaire et confirmation du créneau', () => {
    expect(ko({ ...cb, atMs: NOW - 2 * HOUR } as CallOutcomeInput).errors.atMs).toMatch(/passée/);
    expect(ko({ ...cb, reason: 'zzz' } as unknown as CallOutcomeInput).errors.reason).toBeDefined();
    expect(ko({ ...cb, comment: '   ' }).errors.comment).toBeDefined();
    expect(ko({ ...cb, confirmed: false }).errors.confirmed).toBeDefined();
  });
  it('refuse une date absurde ou absente', () => {
    expect(ko({ ...cb, atMs: NOW + 400 * DAY }).errors.atMs).toMatch(/lointaine/);
    expect(ko({ ...cb, atMs: Number.NaN }).errors.atMs).toBeDefined();
  });
  it('mauvais moment : rappel court P1, ne compte pas comme NR, n’avance pas le cycle', () => {
    const p = ok({ kind: 'bad_moment', atMs: NOW + 30 * MIN, reason: 'busy', note: 'Court', confirmed: true });
    expect(p.status).toBe('callback');
    expect(p.subStatus).toBe('bad_moment');
    expect(p.nextAction).toMatchObject({ type: 'short_callback', priority: 'P1' });
    expect(p.nr).toBeUndefined();
    expect(p.callAttempt.nrNumber).toBeNull();
    expect(p.events[0].meta).toMatchObject({ countsAsNr: false });
  });
  it('mauvais moment : au plus 3 jours, créneau confirmé', () => {
    expect(ko({ kind: 'bad_moment', atMs: NOW + 5 * DAY, reason: 'busy', confirmed: true }).errors.atMs).toBeDefined();
    expect(ko({ kind: 'bad_moment', atMs: NOW + HOUR, reason: 'busy', confirmed: false }).errors.confirmed).toBeDefined();
  });
});

describe('Intéressé (fig. 8, §9)', () => {
  const base: CallOutcomeInput = { kind: 'interested', temperature: 'hot', reason: 'consult_spouse', nextAction: 'call', nextActionAtMs: NOW + DAY, comment: 'Très intéressé' };
  it('fixe la température et programme la prochaine action P2', () => {
    const p = ok(base);
    expect(p.status).toBe('interested');
    expect(p.temperature).toBe('hot');
    expect(p.nextAction).toMatchObject({ type: 'interested_followup', priority: 'P2', dueAtMs: NOW + DAY });
    expect(p.loadDelta).toEqual({ newLeads: -1, interested: 1 });
  });
  it('refuse sans motif, sans action, sans date, sans commentaire ou avec température inconnue', () => {
    expect(ko({ ...base, reason: 'x' } as unknown as CallOutcomeInput).errors.reason).toBeDefined();
    expect(ko({ ...base, nextAction: 'x' } as unknown as CallOutcomeInput).errors.nextAction).toBeDefined();
    expect(ko({ ...base, nextActionAtMs: NOW - DAY }).errors.nextActionAtMs).toBeDefined();
    expect(ko({ ...base, comment: '' }).errors.comment).toBeDefined();
    expect(ko({ ...base, temperature: 'lava' } as unknown as CallOutcomeInput).errors.temperature).toBeDefined();
  });
});

describe('Documents (fig. 9, §10)', () => {
  const base: CallOutcomeInput = { kind: 'request_documents', documents: ['identity', 'tax_notice'], channel: 'email', promisedAtMs: null };
  it('sans promesse : première relance à J+1, dans les horaires', () => {
    const p = ok(base);
    expect(p.status).toBe('awaiting_documents');
    expect(p.nextAction).toMatchObject({ type: 'document_followup', priority: 'P2' });
    expect(p.nextAction?.dueAtMs).toBe(NOW + DAY); // jeudi 10:46
    expect(p.documents?.types.map((t) => t.code)).toEqual(['identity', 'tax_notice']);
  });
  it('une heure promise remplace la relance générique, avec la marge de 30 min', () => {
    const promised = NOW + 6 * HOUR;
    const p = ok({ ...base, promisedAtMs: promised });
    expect(p.nextAction).toMatchObject({ type: 'promised_docs_missing', dueAtMs: promised + 30 * MIN });
    expect(p.documents?.promisedAtMs).toBe(promised);
  });
  it('relance du vendredi soir : report au lundi matin', () => {
    const p = ok(base, ctx({ nowMs: at(9, 18) }));
    expect(p.nextAction?.dueAtMs).toBeGreaterThanOrEqual(at(12, 9));
  });
  it('exige au moins une pièce connue et un canal', () => {
    expect(ko({ ...base, documents: [] }).errors.documents).toBeDefined();
    expect(ko({ ...base, documents: ['identity', 'inconnue'] }).errors.documents).toBeDefined();
    expect(ko({ ...base, channel: 'pigeon' } as unknown as CallOutcomeInput).errors.channel).toBeDefined();
  });
  it('ne compte pas deux fois la même pièce', () => {
    expect(ok({ ...base, documents: ['identity', 'identity'] }).documents?.types).toHaveLength(1);
  });
  it('date promise dans le passé refusée', () => {
    expect(ko({ ...base, promisedAtMs: NOW - DAY }).errors.promisedAtMs).toBeDefined();
  });
});

describe('Clôtures (figs. 10 à 12)', () => {
  it('non intéressé : clôture avec motif et commentaire', () => {
    const p = ok({ kind: 'close_not_interested', motive: 'price', comment: 'Trop cher', followUp: 'close', opposition: false });
    expect(p.status).toBe('not_interested');
    expect(p.nextAction).toBeNull();
    expect(p.events[0].reason).toBe('Prix');
  });
  it('non intéressé : recyclage à une date → action P4, statut recyclage', () => {
    const p = ok({ kind: 'close_not_interested', motive: 'postponed', comment: 'Revient l’an prochain', followUp: 'recycle', recycleAtMs: NOW + 90 * DAY, opposition: false });
    expect(p.status).toBe('recycling');
    expect(p.nextAction).toMatchObject({ type: 'recycle', priority: 'P4', dueAtMs: NOW + 90 * DAY });
  });
  it('non intéressé : opposition → recyclage interdit ; « ne plus être contacté » vaut opposition', () => {
    const r = ko({ kind: 'close_not_interested', motive: 'price', comment: 'x', followUp: 'recycle', recycleAtMs: NOW + DAY, opposition: true });
    expect(r.errors.followUp).toBeDefined();
    expect(ko({ kind: 'close_not_interested', motive: 'no_more_contact', comment: 'x', followUp: 'recycle', recycleAtMs: NOW + DAY, opposition: false }).errors.followUp).toBeDefined();
    const p = ok({ kind: 'close_not_interested', motive: 'no_more_contact', comment: 'stop', followUp: 'close', opposition: false });
    expect(p.events[0].meta).toMatchObject({ opposition: true });
  });
  it('aucune clôture négative sans motif (§7.2)', () => {
    expect(ko({ kind: 'close_not_interested', motive: 'zzz', comment: 'x', followUp: 'close', opposition: false } as unknown as CallOutcomeInput).errors.motive).toBeDefined();
    expect(ko({ kind: 'close_not_interested', motive: 'price', comment: ' ', followUp: 'close', opposition: false }).errors.comment).toBeDefined();
    expect(ko({ kind: 'close_not_interested', motive: 'price', comment: 'x', followUp: 'recycle', opposition: false }).errors.recycleAtMs).toBeDefined();
  });
  it('inéligible : catégorie, motif de la catégorie, produit et justification', () => {
    const base: CallOutcomeInput = { kind: 'close_ineligible', category: 'technical', motive: 'insufficient_surface', product: 'PAC Air/Eau', justification: 'Appartement sans emplacement.' };
    const p = ok({ ...base, alternativeProduct: 'PAC Air/Air' });
    expect(p.status).toBe('ineligible');
    expect(p.events[0].meta).toMatchObject({ alternativeProduct: 'PAC Air/Air', category: 'technical' });
    expect(ko({ ...base, motive: 'tenant' }).errors.motive).toBeDefined(); // motif d'une autre catégorie
    expect(ko({ ...base, category: 'zzz' } as unknown as CallOutcomeInput).errors.category).toBeDefined();
    expect(ko({ ...base, product: '' }).errors.product).toBeDefined();
    expect(ko({ ...base, justification: '' }).errors.justification).toBeDefined();
  });
  it('faux lead : exclu des performances, manager prévenu si demandé', () => {
    const p = ok({ kind: 'close_fake_lead', motive: 'fake_number', comment: 'Jamais demandé', requestManagerCheck: true });
    expect(p.status).toBe('fake_lead');
    expect(p.quality).toEqual({ excluded: true, reason: 'fake_number' });
    expect(p.notifyManagers?.title).toBe('Faux lead à vérifier');
    expect(ok({ kind: 'close_fake_lead', motive: 'spam', comment: 'x', requestManagerCheck: false }).notifyManagers).toBeNull();
    expect(ko({ kind: 'close_fake_lead', motive: 'spam', comment: '', requestManagerCheck: false }).errors.comment).toBeDefined();
  });
  it('mauvais numéro : faux lead « numéro invalide », commentaire facultatif', () => {
    const p = ok({ kind: 'close_wrong_number' });
    expect(p.status).toBe('fake_lead');
    expect(p.quality?.reason).toBe('invalid_number');
  });
  it('autre : clôture avec commentaire obligatoire', () => {
    expect(ok({ kind: 'close_other', comment: 'Décès' }).status).toBe('not_interested');
    expect(ko({ kind: 'close_other', comment: '' }).errors.comment).toBeDefined();
  });
});

describe('droits et états', () => {
  const nr: CallOutcomeInput = { kind: 'no_answer' };
  it('seul le propriétaire (ou un administrateur) qualifie', () => {
    expect(ko(nr, ctx({ actorId: 'u2' })).code).toBe('forbidden');
    expect(ko(nr, ctx({ actorId: 'm1', actorRole: 'manager' })).code).toBe('forbidden');
    expect(ok(nr, ctx({ actorId: 'a1', actorRole: 'admin' })).status).toBe('nr');
  });
  it('refuse un lead sans propriétaire', () => {
    expect(ko(nr, ctx({ lead: lead({ ownerId: null }) })).code).toBe('unavailable');
  });
  it('refuse un lead clôturé ou en transmission', () => {
    for (const status of ['not_interested', 'converted', 'fake_lead', 'ineligible', 'unreachable_archived'] as const) {
      expect(ko(nr, ctx({ lead: lead({ status }) })).code).toBe('lead_closed');
    }
    expect(ko(nr, ctx({ lead: lead({ status: 'transmitting' }) })).code).toBe('unavailable');
  });
  it('un résultat inconnu est refusé', () => {
    expect(ko({ kind: 'teleportation' } as unknown as CallOutcomeInput).code).toBe('invalid');
  });
  it('les identifiants d’action dépendent de la demande : un rejeu donne les mêmes', () => {
    const a = ok({ kind: 'no_answer' }).nextAction?.id;
    const b = ok({ kind: 'no_answer' }).nextAction?.id;
    expect(a).toBe(b);
    expect(a).toBe('L1_nr_attempt_req1');
    expect(ok({ kind: 'no_answer' }, ctx({ requestId: 'req2' })).nextAction?.id).not.toBe(a);
  });
});

describe('saisies hostiles', () => {
  it("un motif comme « constructor » ou « __proto__ » est refusé proprement, sans erreur", () => {
    for (const reason of ['constructor', '__proto__', 'toString']) {
      expect(ko({ kind: 'callback', atMs: NOW + HOUR, reason, comment: 'x', confirmed: true } as unknown as CallOutcomeInput).errors.reason).toBeDefined();
    }
    expect(ko({ kind: 'close_ineligible', category: 'constructor', motive: 'x', product: 'p', justification: 'j' } as unknown as CallOutcomeInput).errors.category).toBeDefined();
    expect(ko({ kind: 'request_documents', documents: ['identity'], channel: 'constructor', promisedAtMs: null } as unknown as CallOutcomeInput).errors.channel).toBeDefined();
    expect(ko({ kind: 'close_not_interested', motive: '__proto__', comment: 'x', followUp: 'close', opposition: false } as unknown as CallOutcomeInput).errors.motive).toBeDefined();
  });
  it('des types inattendus ne font pas planter', () => {
    expect(ko({ kind: 'request_documents', documents: 'identity', channel: 'email', promisedAtMs: null } as unknown as CallOutcomeInput).errors.documents).toBeDefined();
    expect(ko({ kind: 'callback', atMs: '2026', reason: 'other', comment: 42, confirmed: 'oui' } as unknown as CallOutcomeInput).code).toBe('invalid');
  });
});

describe('formatWhen', () => {
  it('aujourd’hui, demain, puis jour de la semaine', () => {
    expect(formatWhen(at(7, 15, 30), NOW, TZ)).toBe("aujourd'hui à 15:30");
    expect(formatWhen(at(8, 10), NOW, TZ)).toBe('demain à 10:00');
    expect(formatWhen(at(12, 9), NOW, TZ)).toMatch(/lundi 12\/10 à 09:00/);
  });
  it('s’exprime dans le fuseau du planning, pas celui du serveur', () => {
    // 22:30 UTC mardi = 00:30 mercredi à Paris : « aujourd'hui » pour un instant à Paris ce mercredi
    expect(formatWhen(Date.UTC(2026, 9, 6, 22, 30), Date.UTC(2026, 9, 7, 8, 0), TZ)).toBe("aujourd'hui à 00:30");
  });
});
