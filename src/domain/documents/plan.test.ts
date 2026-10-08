import { describe, expect, it } from 'vitest';
import {
  buildReminderMessage,
  DEFAULT_DOCUMENT_RULES,
  nextFollowUpStep,
  planDocumentAction,
  summarizeDocuments,
  type DocContext,
  type DocRow,
  type DocumentActionInput,
  type DocumentPlan,
} from './plan';

const DAY = 86_400_000;
// Mercredi 7 octobre 2026, 10:00 à Paris (UTC+2).
const NOW = Date.parse('2026-10-07T08:00:00Z');
const rules = DEFAULT_DOCUMENT_RULES;

const row = (code: string, status: DocRow['status'], mandatory = true, koReason: DocRow['koReason'] = null): DocRow => ({ code, status, mandatory, koReason });
const CHECKLIST: DocRow[] = [row('identity', 'expected'), row('tax_notice', 'expected'), row('proof_of_address', 'expected'), row('bank_details', 'expected', false)];

function ctx(over: Partial<DocContext> & { docs?: DocRow[] } = {}): DocContext {
  return {
    lead: {
      id: 'L1', status: 'awaiting_documents', ownerId: 'tel1', managerIds: ['man1'], nextActionId: 'act-old',
      lastRequestAtMs: NOW - DAY, lastFollowUpAtMs: null, followUpCount: 0, promisedAtMs: null,
      ...over.lead,
    },
    docs: over.docs ?? CHECKLIST,
    actorId: over.actorId ?? 'tel1',
    actorRole: over.actorRole ?? 'telepro',
    nowMs: over.nowMs ?? NOW,
    requestId: 'req-00001',
    rules: over.rules ?? rules,
  };
}

function ok(input: DocumentActionInput, c: DocContext = ctx()): DocumentPlan {
  const r = planDocumentAction(input, c);
  if (!r.ok) throw new Error(`refusé : ${r.message}`);
  return r.plan;
}
const refused = (input: DocumentActionInput, c: DocContext = ctx()) => {
  const r = planDocumentAction(input, c);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r;
};

describe('summarizeDocuments (§10.2, §10.3)', () => {
  it('aucune pièce : pas de workflow', () => expect(summarizeDocuments([]).state).toBe('none'));
  it('rien reçu : demandés', () => expect(summarizeDocuments(CHECKLIST)).toMatchObject({ state: 'requested', expected: 4, received: 0, mandatory: 3 }));
  it('une pièce reçue : partiel', () => expect(summarizeDocuments([row('a', 'received'), row('b', 'expected')]).state).toBe('partial'));
  it('toutes les obligatoires reçues, non contrôlées : à contrôler (une facultative manquante ne bloque pas)', () => {
    expect(summarizeDocuments([row('a', 'received'), row('b', 'conform'), row('c', 'expected', false)]).state).toBe('received_to_check');
  });
  it('une pièce rejetée : incomplet / non conforme, et elle ne compte pas dans la progression', () => {
    const s = summarizeDocuments([row('a', 'non_conform'), row('b', 'conform'), row('c', 'expected')]);
    expect(s).toMatchObject({ state: 'incomplete_non_conform', received: 1, conform: 1 });
    expect(summarizeDocuments([row('a', 'to_reask'), row('b', 'received')]).received).toBe(1);
  });
  it('obligatoires conformes : complet, même si une facultative manque', () => {
    expect(summarizeDocuments([row('a', 'conform'), row('b', 'conform'), row('c', 'expected', false)])).toMatchObject({ state: 'complete', mandatoryConform: 2 });
  });
  it('une facultative rejetée empêche « complet » (la progression reste honnête)', () => {
    expect(summarizeDocuments([row('a', 'conform'), row('c', 'non_conform', false)]).state).toBe('incomplete_non_conform');
  });
  it('sans aucune pièce obligatoire : toutes doivent être conformes', () => {
    expect(summarizeDocuments([row('a', 'conform', false), row('b', 'received', false)]).state).toBe('received_to_check');
    expect(summarizeDocuments([row('a', 'conform', false), row('b', 'conform', false)]).state).toBe('complete');
  });
});

describe('cadence des relances (§10.4)', () => {
  const base = { requestAtMs: NOW, lastFollowUpAtMs: null, rules };
  it('J+1, J+3 (prioritaire), J+5, J+7 (alerte rouge), puis la décision à J+14', () => {
    const kinds = [0, 1, 2, 3, 4].map((done) => nextFollowUpStep({ ...base, done })!);
    expect(kinds.map((k) => k.day)).toEqual([1, 3, 5, 7, 14]);
    expect(kinds.map((k) => k.kind)).toEqual(['followup', 'followup', 'priority', 'red_alert', 'decision']);
  });
  it('jamais le week-end : J+3 un samedi tombe le lundi à 9 h', () => {
    expect(new Date(nextFollowUpStep({ ...base, done: 1 })!.dueAtMs).toISOString()).toBe('2026-10-12T07:00:00.000Z');
  });
  it('au moins un jour après la dernière relance', () => {
    const late = nextFollowUpStep({ ...base, lastFollowUpAtMs: NOW + 4 * DAY, done: 1 })!;
    expect(late.dueAtMs).toBeGreaterThanOrEqual(NOW + 5 * DAY);
  });
  it('après la décision, elle se répète toutes les semaines', () => {
    const next = nextFollowUpStep({ ...base, done: 5 })!;
    expect(next).toMatchObject({ kind: 'decision', day: 21 });
  });
  it('délais modifiables ; liste vide : aucune échéance', () => {
    expect(nextFollowUpStep({ ...base, done: 0, rules: { ...rules, followUpDays: [2, 4] } })!.day).toBe(2);
    expect(nextFollowUpStep({ ...base, done: 0, rules: { ...rules, followUpDays: [] } })).toBeNull();
  });
  it('aucun créneau de travail : pas d\'échéance inventée', () => {
    expect(nextFollowUpStep({ ...base, done: 0, rules: { ...rules, schedule: { timezone: 'Europe/Paris', weekly: [] } } })).toBeNull();
  });
});

describe('résumé recopié sur le lead (écran Documents)', () => {
  it('liste les pièces manquantes ou rejetées, compte les pièces à contrôler, date la dernière réception', () => {
    const docs = [row('identity', 'non_conform', true, 'expired'), row('tax_notice', 'expected'), row('proof_of_address', 'received'), row('bank_details', 'conform', false)];
    const p = ok({ kind: 'receive', code: 'tax_notice' }, ctx({ docs }));
    expect(p.leadDocuments.missing).toEqual([{ code: 'identity', label: null, status: 'non_conform', koReason: 'expired' }]);
    expect(p.summary.toCheck).toBe(2);
    expect(p.leadDocuments.lastReceivedAtMs).toBe(NOW);
    expect(p.leadDocuments.completedAtMs).toBeUndefined();
  });
  it("date le passage à « complet » et l'efface si le dossier redevient incomplet", () => {
    const received = [row('identity', 'conform'), row('tax_notice', 'received')];
    expect(ok({ kind: 'check', code: 'tax_notice', verdict: 'conform' }, ctx({ docs: received })).leadDocuments.completedAtMs).toBe(NOW);
    const complete = [row('identity', 'conform'), row('tax_notice', 'conform')];
    expect(ok({ kind: 'receive', code: 'identity' }, ctx({ docs: complete })).leadDocuments.completedAtMs).toBeNull();
    expect(ok({ kind: 'receive', code: 'bank_details' }, ctx({ docs: [...complete, row('bank_details', 'expected', false)] })).leadDocuments.completedAtMs).toBeUndefined();
  });
});

describe('réception d\'une pièce', () => {
  it('passe à « reçu », crée une action « à contrôler » P1 immédiate et lève l\'heure promise', () => {
    const p = ok({ kind: 'receive', code: 'identity', channel: 'whatsapp' });
    expect(p.docPatches[0]).toMatchObject({ code: 'identity', status: 'received', channel: 'whatsapp', receivedAtMs: NOW });
    expect(p.summary).toMatchObject({ state: 'partial', received: 1, conform: 0 });
    expect(p.nextAction).toMatchObject({ type: 'document_review', priority: 'P1', dueAtMs: NOW });
    expect(p.completedActionId).toBe('act-old');
    expect(p.leadDocuments.clearPromised).toBe(true);
    expect(p.status).toBe('awaiting_documents');
  });
  it('avec un fichier : canal « dépôt » par défaut, métadonnées conservées', () => {
    const file = { storagePath: 'cl_documents/L1/identity/a.pdf', contentType: 'application/pdf', sizeBytes: 1000, originalName: 'a.pdf' };
    const p = ok({ kind: 'receive', code: 'identity', file });
    expect(p.docPatches[0]).toMatchObject({ channel: 'upload', file });
    expect(p.events[0].note).toContain('a.pdf');
  });
  it('fichier hors du dossier de dépôt, vide ou trop gros : refusé', () => {
    const f = { storagePath: 'cl_documents/L1/identity/x', contentType: 'application/pdf', sizeBytes: 10, originalName: 'x' };
    expect(refused({ kind: 'receive', code: 'identity', file: { ...f, storagePath: '../autre/x' } }).code).toBe('invalid');
    expect(refused({ kind: 'receive', code: 'identity', file: { ...f, storagePath: 'cl_documents/AUTRE/identity/x' } }).code).toBe('invalid');
    expect(refused({ kind: 'receive', code: 'identity', file: { ...f, storagePath: 'cl_documents/L1/tax_notice/x' } }).code).toBe('invalid');
    expect(refused({ kind: 'receive', code: 'identity', file: { ...f, sizeBytes: 0 } }).code).toBe('invalid');
    expect(refused({ kind: 'receive', code: 'identity', file: { ...f, sizeBytes: 16 * 1024 * 1024 } }).code).toBe('invalid');
  });
  it('pièce inconnue ou canal inconnu : refusé', () => {
    expect(refused({ kind: 'receive', code: 'constructor' }).code).toBe('invalid');
    expect(refused({ kind: 'receive', code: 'identity', channel: 'pigeon' as never }).code).toBe('invalid');
  });
  it('une pièce déjà conforme peut être remplacée : elle repasse « à contrôler »', () => {
    const docs = [row('identity', 'conform'), row('tax_notice', 'expected')];
    const p = ok({ kind: 'receive', code: 'identity' }, ctx({ docs }));
    expect(p.docPatches[0]).toMatchObject({ status: 'received', checkedBy: null });
    expect(p.events[0].note).toContain('remplacé');
  });
});

describe('contrôle d\'une pièce', () => {
  const received = [row('identity', 'received'), row('tax_notice', 'expected'), row('proof_of_address', 'expected')];
  it('conforme', () => {
    const p = ok({ kind: 'check', code: 'identity', verdict: 'conform' }, ctx({ docs: received }));
    expect(p.docPatches[0]).toMatchObject({ status: 'conform', checkedBy: 'tel1', checkedAtMs: NOW, koReason: null });
    expect(p.summary.conform).toBe(1);
  });
  it('non conforme : motif obligatoire, « autre » exige un commentaire', () => {
    expect(refused({ kind: 'check', code: 'identity', verdict: 'non_conform' }, ctx({ docs: received })).message).toMatch(/motif/i);
    expect(refused({ kind: 'check', code: 'identity', verdict: 'non_conform', koReason: 'bogus' as never }, ctx({ docs: received })).code).toBe('invalid');
    expect(refused({ kind: 'check', code: 'identity', verdict: 'non_conform', koReason: 'other' }, ctx({ docs: received })).message).toMatch(/commentaire/i);
  });
  it('non conforme : la pièce sort de la progression et une action « redemander » est créée, citant la pièce', () => {
    const p = ok({ kind: 'check', code: 'identity', verdict: 'non_conform', koReason: 'unreadable' }, ctx({ docs: received }));
    expect(p.summary).toMatchObject({ state: 'incomplete_non_conform', received: 0 });
    expect(p.nextAction).toMatchObject({ type: 'document_followup', dueAtMs: NOW });
    expect(p.nextAction!.reason).toContain("Pièce d'identité");
    expect(p.events[0].reason).toBe('Illisible');
  });
  it('on ne contrôle pas une pièce non reçue ni déjà contrôlée', () => {
    expect(refused({ kind: 'check', code: 'tax_notice', verdict: 'conform' }, ctx({ docs: received })).message).toMatch(/pas encore été reçue/);
    expect(refused({ kind: 'check', code: 'identity', verdict: 'conform' }, ctx({ docs: [row('identity', 'conform')] })).message).toMatch(/déjà été contrôlée/);
  });
  it('verdict inconnu refusé', () => expect(refused({ kind: 'check', code: 'identity', verdict: 'peut-être' as never }, ctx({ docs: received })).code).toBe('invalid'));

  it('dernière obligatoire conforme : dossier prêt à monter, compteurs déplacés, action « monter »', () => {
    const docs = [row('identity', 'conform'), row('tax_notice', 'conform'), row('proof_of_address', 'received'), row('bank_details', 'expected', false)];
    const p = ok({ kind: 'check', code: 'proof_of_address', verdict: 'conform' }, ctx({ docs }));
    expect(p.summary.state).toBe('complete');
    expect(p.status).toBe('file_ready_to_build');
    expect(p.loadDelta).toEqual({ documents: -1, filesToBuild: 1 });
    expect(p.nextAction).toMatchObject({ type: 'build_file', priority: 'P3' });
    expect(p.events.map((e) => e.type)).toEqual(['document', 'status_changed']);
  });
  it('un dossier prêt dont une pièce est remplacée revient « en attente de documents »', () => {
    const docs = [row('identity', 'conform'), row('tax_notice', 'conform'), row('proof_of_address', 'conform')];
    const p = ok({ kind: 'receive', code: 'identity' }, ctx({ docs, lead: { status: 'file_ready_to_build' } as never }));
    expect(p.status).toBe('awaiting_documents');
    expect(p.loadDelta).toEqual({ filesToBuild: -1, documents: 1 });
  });
});

describe('redemande', () => {
  it('seulement pour une pièce non conforme', () => {
    const docs = [row('identity', 'non_conform', true, 'expired'), row('tax_notice', 'received')];
    expect(ok({ kind: 'reask', code: 'identity' }, ctx({ docs })).docPatches[0]).toMatchObject({ status: 'to_reask', koReason: 'expired' });
    expect(refused({ kind: 'reask', code: 'tax_notice' }, ctx({ docs })).code).toBe('invalid');
  });
});

describe('relance (§10.4)', () => {
  it('compte la relance, cite les pièces manquantes et planifie la suivante (J+3)', () => {
    const p = ok({ kind: 'follow_up', channel: 'whatsapp' });
    expect(p.leadDocuments).toMatchObject({ followUpCount: 1, lastFollowUpAtMs: NOW });
    expect(p.events[0].note).toContain("Pièce d'identité");
    expect(p.events[0].note).toContain('Relance n°1');
    expect(p.nextAction).toMatchObject({ type: 'document_followup', priority: 'P2' });
    expect(p.nextAction!.dueAtMs).toBeGreaterThan(NOW);
  });
  it('la troisième relance est prioritaire, la quatrième est l\'alerte rouge, puis la décision', () => {
    const at = (done: number) => ok({ kind: 'follow_up', channel: 'sms' }, ctx({ lead: { followUpCount: done, lastRequestAtMs: NOW - 2 * DAY } as never })).nextAction!;
    expect(at(1)).toMatchObject({ type: 'document_followup', priority: 'P1' });
    expect(at(2).reason).toBe('Documents toujours incomplets');
    expect(at(3).type).toBe('document_decision');
  });
  it('relancer alors qu\'une pièce est rejetée ne recrée pas aussitôt la même action', () => {
    const docs = [row('identity', 'to_reask', true, 'unreadable'), row('tax_notice', 'expected')];
    const p = ok({ kind: 'follow_up', channel: 'email' }, ctx({ docs }));
    expect(p.nextAction!.dueAtMs).toBeGreaterThan(NOW);
  });
  it('rien à relancer ou canal inconnu : refusé', () => {
    const done = [row('identity', 'received'), row('tax_notice', 'conform')];
    expect(refused({ kind: 'follow_up', channel: 'sms' }, ctx({ docs: done })).message).toMatch(/rien à relancer/);
    expect(refused({ kind: 'follow_up', channel: 'fax' as never }).code).toBe('invalid');
  });
  it('heure promise : l\'action « documents promis non reçus » prend le relais après la marge', () => {
    const promised = NOW + 3_600_000;
    const p = ok({ kind: 'check', code: 'identity', verdict: 'conform' }, ctx({ docs: [row('identity', 'received'), row('tax_notice', 'expected')], lead: { promisedAtMs: promised } as never }));
    expect(p.nextAction).toMatchObject({ type: 'promised_docs_missing', dueAtMs: promised + 30 * 60_000 });
  });
});

describe('décision à J+14', () => {
  it('poursuivre : une nouvelle décision est replanifiée', () => {
    const p = ok({ kind: 'decide', decision: 'continue' }, ctx({ lead: { followUpCount: 4, lastRequestAtMs: NOW - 14 * DAY } as never }));
    expect(p.status).toBe('awaiting_documents');
    expect(p.nextAction).toMatchObject({ type: 'document_decision' });
    expect(p.nextAction!.dueAtMs).toBeGreaterThan(NOW);
  });
  it('clôturer : motif et commentaire obligatoires, statut de clôture, plus d\'action', () => {
    expect(refused({ kind: 'decide', decision: 'close', comment: 'x' }).message).toMatch(/motif/);
    expect(refused({ kind: 'decide', decision: 'close', closeReason: 'other' }).message).toMatch(/commentaire/);
    expect(refused({ kind: 'decide', decision: 'close', closeReason: 'hacker' as never, comment: 'x' }).code).toBe('invalid');
    const p = ok({ kind: 'decide', decision: 'close', closeReason: 'ineligible', comment: 'Revenus trop élevés' });
    expect(p).toMatchObject({ status: 'ineligible', nextAction: null });
    expect(p.loadDelta).toEqual({ documents: -1 });
    expect(p.leadDocuments.nextFollowUpAtMs).toBeNull();
  });
  it('recycler : statut recyclage, action P4 dans les horaires', () => {
    const p = ok({ kind: 'decide', decision: 'recycle' });
    expect(p.status).toBe('recycling');
    expect(p.nextAction).toMatchObject({ type: 'recycle', priority: 'P4' });
    expect(p.loadDelta).toEqual({ documents: -1, recycling: 1 });
  });
  it('décision inconnue refusée', () => expect(refused({ kind: 'decide', decision: 'abandon' as never }).code).toBe('invalid'));
});

describe('passage au montage', () => {
  it('seulement depuis « prêt à monter »', () => {
    const ready = ctx({ lead: { status: 'file_ready_to_build' } as never, docs: [row('identity', 'conform')] });
    const p = ok({ kind: 'start_building' }, ready);
    expect(p).toMatchObject({ status: 'file_building', nextAction: null });
    expect(p.loadDelta).toEqual({ filesToBuild: -1 });
    expect(refused({ kind: 'start_building' }).code).toBe('unavailable');
  });
  it('une pièce reçue après le début du montage ne change pas le statut', () => {
    const p = ok({ kind: 'receive', code: 'identity' }, ctx({ lead: { status: 'file_building' } as never }));
    expect(p.status).toBe('file_building');
    expect(p.nextAction).toBeNull();
  });
});

describe('droits et garde-fous', () => {
  it('un télépro ne traite pas les documents d\'un autre', () => expect(refused({ kind: 'receive', code: 'identity' }, ctx({ actorId: 'autre' })).code).toBe('forbidden'));
  it('le manager du lead et l\'admin le peuvent ; un manager d\'une autre équipe non', () => {
    expect(ok({ kind: 'receive', code: 'identity' }, ctx({ actorId: 'man1', actorRole: 'manager' })).action).toBe('receive');
    expect(ok({ kind: 'receive', code: 'identity' }, ctx({ actorId: 'root', actorRole: 'admin' })).action).toBe('receive');
    expect(refused({ kind: 'receive', code: 'identity' }, ctx({ actorId: 'man2', actorRole: 'manager' })).code).toBe('forbidden');
  });
  it('lead clôturé, sans dossier ou sans pièce : refusé', () => {
    expect(refused({ kind: 'receive', code: 'identity' }, ctx({ lead: { status: 'not_interested' } as never })).code).toBe('lead_closed');
    expect(refused({ kind: 'receive', code: 'identity' }, ctx({ lead: { status: 'interested' } as never })).code).toBe('unavailable');
    expect(refused({ kind: 'receive', code: 'identity' }, ctx({ docs: [] })).code).toBe('unavailable');
  });
  it('action inconnue refusée', () => expect(refused({ kind: 'explode' } as never).code).toBe('invalid'));
  it('ne modifie jamais les pièces reçues en entrée', () => {
    const docs = CHECKLIST.map((d) => ({ ...d }));
    ok({ kind: 'receive', code: 'identity' }, ctx({ docs }));
    expect(docs).toEqual(CHECKLIST);
  });
});

describe('libellés propres au produit', () => {
  it("une pièce hors de la liste d'origine garde son libellé partout (message, action, historique)", () => {
    const docs: DocRow[] = [{ code: 'attestation-ramonage', label: 'Attestation de ramonage', mandatory: true, status: 'expected' }, row('identity', 'expected')];
    const p = ok({ kind: 'follow_up', channel: 'sms' }, ctx({ docs }));
    expect(p.events[0].note).toContain('Attestation de ramonage');
    expect(p.leadDocuments.missing[0]).toMatchObject({ code: 'attestation-ramonage', label: 'Attestation de ramonage' });
    expect(buildReminderMessage('', docs)).toContain('- Attestation de ramonage');
  });
  it("sans libellé enregistré : liste d'origine, puis le code", () => {
    expect(buildReminderMessage('', [row('identity', 'expected'), row('inconnu', 'expected')])).toMatch(/- Pièce d'identité[\s\S]*- inconnu/);
  });
});

describe('message de relance', () => {
  it('cite exactement les pièces manquantes ou rejetées, avec le motif', () => {
    const msg = buildReminderMessage('Nadia', [row('identity', 'conform'), row('tax_notice', 'non_conform', true, 'expired'), row('proof_of_address', 'expected'), row('bank_details', 'received', false)]);
    expect(msg).toContain('Bonjour Nadia,');
    expect(msg).toContain("- Avis d'imposition (expiré)");
    expect(msg).toContain('- Justificatif de domicile');
    expect(msg).not.toContain("Pièce d'identité");
    expect(msg).not.toContain('RIB');
  });
  it('tout est reçu : message de remerciement, sans prénom : formule neutre', () => {
    expect(buildReminderMessage('', [row('identity', 'conform')])).toMatch(/^Bonjour,\n\nNous avons bien reçu/);
  });
});
