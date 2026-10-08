import { describe, expect, it, vi } from 'vitest';

// La couche Firestore est testée contre une base en mémoire (pas d'émulateur disponible) : on vérifie ce que
// qualifyCall ÉCRIT (champs, sous-collections, compteurs, idempotence), pas le moteur Firestore lui-même.
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { increment: (n: number) => ({ __inc: n }) } }));

import { parseCallRules, qualifyCall, type QualifyArgs } from './qualify';
import { DEFAULT_CALL_RULES } from '../../src/domain/call/plan';

type Doc = Record<string, unknown>;

class FakeDb {
  data = new Map<string, Doc>();
  writes: string[] = [];

  collection(name: string, prefix = ''): FakeCol {
    return new FakeCol(this, `${prefix}${name}`);
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    return fn(new FakeTx(this));
  }
}
class FakeCol {
  constructor(private db: FakeDb, public path: string) {}
  doc(id: string): FakeRef {
    return new FakeRef(this.db, `${this.path}/${id}`);
  }
}
class FakeRef {
  constructor(public db: FakeDb, public path: string) {}
  get id() { return this.path.split('/').pop()!; }
  collection(name: string): FakeCol {
    return this.db.collection(name, `${this.path}/`);
  }
  async get() { return snap(this.db, this.path); }
}
const snap = (db: FakeDb, path: string) => {
  const d = db.data.get(path);
  return { id: path.split('/').pop()!, exists: d !== undefined, data: () => d, get: (k: string) => d?.[k] };
};
const setDeep = (obj: Doc, key: string, val: unknown) => {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] = (cur[p] && typeof cur[p] === 'object' ? { ...(cur[p] as Doc) } : {})) as Doc;
  const last = parts[parts.length - 1];
  const inc = val as { __inc?: number };
  cur[last] = inc && typeof inc === 'object' && '__inc' in inc ? Number(cur[last] ?? 0) + (inc.__inc as number) : val;
};
class FakeTx {
  private wrote = false;
  constructor(private db: FakeDb) {}
  async get(ref: FakeRef) {
    if (this.wrote) throw new Error('lecture après écriture : interdit dans une transaction Firestore');
    return snap(this.db, ref.path);
  }
  update(ref: FakeRef, patch: Doc) {
    this.wrote = true;
    const cur = this.db.data.get(ref.path);
    if (!cur) throw new Error(`update d'un document inexistant : ${ref.path}`);
    for (const [k, v] of Object.entries(patch)) setDeep(cur, k, v);
    this.db.writes.push(`update ${ref.path}`);
  }
  set(ref: FakeRef, data: Doc, opts?: { merge?: boolean }) {
    this.wrote = true;
    const cur = this.db.data.get(ref.path);
    this.db.data.set(ref.path, opts?.merge && cur ? { ...cur, ...data } : { ...data });
    this.db.writes.push(`set ${ref.path}`);
  }
}

const NOW = Date.UTC(2026, 9, 7, 8, 46);
const T = (ms: number) => ({ toMillis: () => ms });

function seed(over: Doc = {}) {
  const db = new FakeDb();
  db.data.set('cl_leads/L1', {
    id: 'L1',
    status: 'new',
    ownerId: 'u1',
    teamId: 't1',
    managerIds: ['m1'],
    productCode: 'pac',
    nr: { attempt: 0, cycle: 1, lastAt: null, nextAt: null },
    sla: { startedAt: T(NOW - 120_000), stoppedAt: null, nextAlertAt: T(NOW), alertCount: 0 },
    nextAction: { actionId: 'L1_take_new_lead', type: 'take_new_lead', dueAt: T(NOW), priority: 'P1', reason: 'x' },
    quality: { excluded: false },
    version: 1,
    ...over,
  });
  db.data.set('cl_actions/L1_take_new_lead', { id: 'L1_take_new_lead', state: 'open', leadId: 'L1' });
  db.data.set('cl_profiles/u1', { load: { newLeads: 3, callbacks: 0, interested: 0, documents: 0, filesToBuild: 0, recycling: 0 } });
  return db;
}

const args = (over: Partial<QualifyArgs> = {}): QualifyArgs => ({
  uid: 'u1',
  role: 'telepro',
  leadId: 'L1',
  requestId: 'req-12345678',
  expectedStatus: 'new',
  input: { kind: 'no_answer', comment: 'Messagerie' },
  durationSeconds: 40,
  nowMs: NOW,
  ...over,
});

const run = (db: FakeDb, a: QualifyArgs) => qualifyCall(db as never, a);
const lead = (db: FakeDb) => db.data.get('cl_leads/L1') as Doc & { nr: Doc; sla: Doc; nextAction: Doc | null; lastNote?: Doc; documents?: Doc; quality: Doc };

describe('qualifyCall — checklist du produit', () => {
  const ask = { kind: 'request_documents' as const, documents: ['attestation'], channel: 'email' as const, promisedAtMs: null };
  const withLead = (db: FakeDb) => {
    db.data.set('cl_checklists/pac', { id: 'pac', items: [{ code: 'attestation', label: 'Attestation de ramonage', mandatory: true }, { code: 'identity', label: "Pièce d'identité", mandatory: true }] });
    return db;
  };
  it('demande les pièces de la famille du lead et enregistre leur libellé', async () => {
    const db = withLead(seed({ productCode: 'PAC' }));
    const r = await run(db, args({ input: ask }));
    expect(r.ok).toBe(true);
    expect(db.data.get('cl_leads/L1/documents/attestation')).toMatchObject({ typeCode: 'attestation', label: 'Attestation de ramonage', mandatory: true, status: 'expected' });
    expect(lead(db).documents).toMatchObject({ missing: [{ code: 'attestation', label: 'Attestation de ramonage', status: 'expected' }] });
  });
  it('une pièce absente de la checklist du produit est refusée', async () => {
    const db = withLead(seed({ productCode: 'SSC' }));
    const r = await run(db, args({ input: ask }));
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
  });
  it("sans checklist enregistrée : liste d'origine", async () => {
    const db = seed({ productCode: 'PAC' });
    const r = await run(db, args({ input: { ...ask, documents: ['identity'] } }));
    expect(r.ok).toBe(true);
    expect(db.data.get('cl_leads/L1/documents/identity')).toMatchObject({ label: "Pièce d'identité" });
  });
  it('la checklist « par défaut » éditée sert aux familles sans liste propre', async () => {
    const db = seed({ productCode: 'POELE' });
    db.data.set('cl_checklists/default', { id: 'default', items: [{ code: 'attestation', label: 'Attestation', mandatory: false }] });
    expect((await run(db, args({ input: ask }))).ok).toBe(true);
  });
});

describe('qualifyCall — NR', () => {
  it('écrit lead, historique, tentative, action et compteurs de façon cohérente', async () => {
    const db = seed();
    const r = await run(db, args());
    expect(r).toMatchObject({ ok: true, replay: false, status: 'nr' });

    const l = lead(db);
    expect(l.status).toBe('nr');
    expect(l.nr).toMatchObject({ attempt: 1, cycle: 1 });
    expect((l.nr.nextAt as Date).getTime()).toBe(NOW + 3 * 3600_000);
    expect((l.sla.stoppedAt as Date).getTime()).toBe(NOW);
    expect(l.sla.nextAlertAt).toBeNull();
    expect(l.lastNote).toMatchObject({ text: 'Messagerie', authorId: 'u1' });
    expect(l.nextAction).toMatchObject({ actionId: 'L1_nr_attempt_req-12345678', type: 'nr_attempt', priority: 'P3' });
    expect(l.version).toBe(2);

    // Historique immuable : un événement par fait, identifiants dérivés de la demande
    expect(db.data.get('cl_leads/L1/events/req-12345678_call_result')).toMatchObject({ type: 'call_result', actorId: 'u1' });
    expect(db.data.get('cl_leads/L1/events/req-12345678_status_changed')).toMatchObject({ before: { status: 'new' }, after: { status: 'nr' } });
    expect(db.data.get('cl_leads/L1/callAttempts/req-12345678')).toMatchObject({ result: 'no_answer', nrNumber: 1, durationSeconds: 40, userId: 'u1' });

    // Action précédente clôturée, nouvelle action ouverte et rattachée aux bons propriétaire/managers
    expect(db.data.get('cl_actions/L1_take_new_lead')).toMatchObject({ state: 'done', result: 'no_answer' });
    expect(db.data.get('cl_actions/L1_nr_attempt_req-12345678')).toMatchObject({ state: 'open', ownerId: 'u1', managerIds: ['m1'], teamId: 't1', type: 'nr_attempt' });

    // Compteur « nouveaux leads » du télépro décrémenté
    expect((db.data.get('cl_profiles/u1') as { load: Doc }).load.newLeads).toBe(2);
  });

  it('rejeu (même requestId) : rend le résultat déjà enregistré, sans rien réécrire', async () => {
    const db = seed();
    await run(db, args());
    const before = db.writes.length;
    const again = await run(db, args());
    expect(again).toMatchObject({ ok: true, replay: true, status: 'nr' });
    expect(db.writes.length).toBe(before);
    expect((db.data.get('cl_profiles/u1') as { load: Doc }).load.newLeads).toBe(2); // pas décrémenté deux fois
    expect(lead(db).version).toBe(2);
  });

  it('un requestId réutilisé par un autre utilisateur ou pour un autre lead est refusé', async () => {
    const db = seed();
    await run(db, args());
    const r = await run(db, args({ uid: 'a1', role: 'admin' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('lead modifié entre-temps (autre onglet) : refus « stale », rien d’écrit', async () => {
    const db = seed({ status: 'callback' });
    const r = await run(db, args({ expectedStatus: 'new' }));
    expect(r).toMatchObject({ ok: false, code: 'stale' });
    expect(db.writes).toEqual([]);
  });

  it('lead introuvable : not_found', async () => {
    expect(await run(new FakeDb(), args())).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('un autre télépro ne peut pas qualifier ce lead', async () => {
    const db = seed();
    expect(await run(db, args({ uid: 'u2' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(db.writes).toEqual([]);
  });

  it('lead clôturé : refus, rien d’écrit', async () => {
    const db = seed({ status: 'not_interested' });
    expect(await run(db, args({ expectedStatus: null }))).toMatchObject({ ok: false, code: 'lead_closed' });
    expect(db.writes).toEqual([]);
  });

  it('saisie invalide : refus avec le détail des champs, rien d’écrit', async () => {
    const db = seed();
    const r = await run(db, args({ input: { kind: 'callback', atMs: NOW - 3600_000, reason: 'other', comment: '', confirmed: false } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('invalid');
      expect(Object.keys(r.errors).sort()).toEqual(['atMs', 'comment', 'confirmed']);
    }
    expect(db.writes).toEqual([]);
  });

  it('NR5 : fin de cycle, aucune nouvelle action, le lead n’a plus de prochaine action', async () => {
    const db = seed({ status: 'nr', nr: { attempt: 4, cycle: 1 }, sla: { startedAt: T(0), stoppedAt: T(1) } });
    const r = await run(db, args({ expectedStatus: 'nr', input: { kind: 'no_answer' } }));
    expect(r).toMatchObject({ ok: true, status: 'unreachable_cycle_end', nextActionAtMs: null });
    expect(lead(db).nextAction).toBeNull();
    expect([...db.data.keys()].filter((k) => k.startsWith('cl_actions/') && k !== 'cl_actions/L1_take_new_lead')).toEqual([]);
    // l'arrêt du SLA n'est écrit qu'une fois (déjà arrêté ici)
    expect((lead(db).sla.stoppedAt as { toMillis: () => number }).toMillis()).toBe(1);
  });
});

describe('qualifyCall — autres résultats', () => {
  it('documents : état documentaire, pièces attendues, relance, compteur « documents »', async () => {
    const db = seed();
    const r = await run(db, args({ input: { kind: 'request_documents', documents: ['identity', 'tax_notice', 'bank_details'], channel: 'whatsapp', promisedAtMs: null } }));
    expect(r).toMatchObject({ ok: true, status: 'awaiting_documents' });
    expect(lead(db).documents).toMatchObject({ state: 'requested', expected: 3, mandatory: 2, received: 0 });
    expect(db.data.get('cl_leads/L1/documents/identity')).toMatchObject({ status: 'expected', mandatory: true, channel: 'whatsapp' });
    expect(db.data.get('cl_leads/L1/documents/bank_details')).toMatchObject({ mandatory: false });
    const p = (db.data.get('cl_profiles/u1') as { load: Doc }).load;
    expect(p.newLeads).toBe(2);
    expect(p.documents).toBe(1);
  });

  it('intéressé : température et compteur « intéressés »', async () => {
    const db = seed();
    await run(db, args({ input: { kind: 'interested', temperature: 'hot', reason: 'planning', nextAction: 'call', nextActionAtMs: NOW + 86_400_000, comment: 'Très motivé' } }));
    expect(lead(db)).toMatchObject({ status: 'interested', temperature: 'hot' });
    expect((db.data.get('cl_profiles/u1') as { load: Doc }).load.interested).toBe(1);
  });

  it('faux lead : exclu des performances et manager notifié', async () => {
    const db = seed();
    await run(db, args({ input: { kind: 'close_fake_lead', motive: 'fake_number', comment: 'Jamais demandé', requestManagerCheck: true } }));
    expect(lead(db)).toMatchObject({ status: 'fake_lead' });
    expect(lead(db).quality).toMatchObject({ excluded: true, excludedReason: 'fake_number' });
    expect(db.data.get('cl_notifications/L1_req-12345678_manager')).toMatchObject({ recipientIds: ['m1'], type: 'fake_lead_check' });
    expect(lead(db).nextAction).toBeNull();
  });

  it('profil propriétaire absent : le résultat est enregistré quand même, sans planter', async () => {
    const db = seed();
    db.data.delete('cl_profiles/u1');
    expect(await run(db, args())).toMatchObject({ ok: true });
  });

  it('sans manager, aucune notification n’est écrite', async () => {
    const db = seed({ managerIds: [] });
    await run(db, args({ input: { kind: 'close_fake_lead', motive: 'spam', comment: 'x', requestManagerCheck: true } }));
    expect([...db.data.keys()].some((k) => k.startsWith('cl_notifications/'))).toBe(false);
  });
});

describe('qualifyCall — statut « En appel » rétabli', () => {
  const withStatus = (status: string) => {
    const db = seed();
    (db.data.get('cl_profiles/u1') as Doc).operationalStatus = status;
    return db;
  };
  const status = (db: FakeDb) => (db.data.get('cl_profiles/u1') as Doc).operationalStatus;

  it('à l’enregistrement du résultat, le statut d’avant l’appel est rétabli et historisé', async () => {
    const db = withStatus('on_call');
    await run(db, { ...args(), resumeStatus: 'doc_followup' });
    expect(status(db)).toBe('doc_followup');
    expect(db.data.get(`cl_audit/status_u1_${NOW}`)).toMatchObject({ before: { operationalStatus: 'on_call' }, after: { operationalStatus: 'doc_followup' }, entityId: 'u1' });
  });

  it('sans statut d’origine valide : Disponible (jamais « rester en appel »)', async () => {
    for (const resume of [undefined, 'on_call', 'absent', 'constructor', 42]) {
      const db = withStatus('on_call');
      await run(db, { ...args(), resumeStatus: resume });
      expect(status(db)).toBe('available');
    }
  });

  it('un statut choisi entre-temps (pause) n’est pas écrasé', async () => {
    const db = withStatus('paused');
    await run(db, { ...args(), resumeStatus: 'available' });
    expect(status(db)).toBe('paused');
    expect([...db.data.keys()].some((k) => k.startsWith('cl_audit/'))).toBe(false);
  });

  it('un résultat refusé ne touche pas au statut', async () => {
    const db = withStatus('on_call');
    await run(db, { ...args(), input: { kind: 'callback', atMs: NOW - 3600_000, reason: 'other', comment: '', confirmed: false } });
    expect(status(db)).toBe('on_call');
  });
});

describe('parseCallRules', () => {
  it('absent ou invalide : valeurs par défaut', () => {
    expect(parseCallRules(undefined)).toEqual(DEFAULT_CALL_RULES);
    expect(parseCallRules({ nrDelaysMinutes: 'x', recycleAfterDays: -3, schedule: { weekly: [] } })).toEqual(DEFAULT_CALL_RULES);
  });
  it('valeurs valides : appliquées', () => {
    const r = parseCallRules({ nrDelaysMinutes: [60, 120], recycleAfterDays: 10, documentFollowUpDays: 2, promisedMarginMinutes: 15, schedule: { timezone: 'Europe/Paris', weekly: [{ day: 1, start: '08:00', end: '12:00' }] } });
    expect(r.nrDelaysMinutes).toEqual([60, 120]);
    expect(r.recycleAfterDays).toBe(10);
    expect(r.documentFollowUpDays).toBe(2);
    expect(r.promisedMarginMinutes).toBe(15);
    expect(r.schedule.weekly).toHaveLength(1);
  });
  it('une valeur hors bornes retombe sur le défaut', () => {
    expect(parseCallRules({ recycleAfterDays: 9999 }).recycleAfterDays).toBe(DEFAULT_CALL_RULES.recycleAfterDays);
    expect(parseCallRules({ nrDelaysMinutes: [0] }).nrDelaysMinutes).toEqual(DEFAULT_CALL_RULES.nrDelaysMinutes);
  });
});

describe('qualifyCall — réglages de Paramètres', () => {
  it("la matrice NR enregistrée par l'administrateur s'applique (NR2 une heure après, pas trois)", async () => {
    const db = seed();
    db.data.set('cl_settings/rules', { nrDelaysMinutes: [60, 120, 180, 240] });
    await run(db, args());
    expect(((lead(db).nr as { nextAt: Date }).nextAt).getTime()).toBe(NOW + 3600_000);
  });
  it("les jours fermés enregistrés repoussent la tentative au prochain jour ouvré", async () => {
    const db = seed();
    // Mercredi 7 octobre : fermé ; NR2 après 3 h tombe donc jeudi à l'ouverture (09:00 Paris = 07:00Z).
    db.data.set('cl_settings/sla', { schedule: { timezone: 'Europe/Paris', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '19:00' })), closedDates: ['2026-10-07'] } });
    await run(db, args());
    expect(new Date((lead(db).nr as { nextAt: Date }).nextAt).toISOString()).toBe('2026-10-08T07:00:00.000Z');
  });
  it('sans réglage enregistré : valeurs du cahier', async () => {
    const db = seed();
    await run(db, args());
    expect(((lead(db).nr as { nextAt: Date }).nextAt).getTime()).toBe(NOW + 3 * 3600_000);
  });
});
