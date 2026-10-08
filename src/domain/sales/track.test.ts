import { describe, expect, it } from 'vitest';
import { availableSaleActions, buildSaleReminderMessage, isSecured, planSaleAction, type SaleAction, type SaleTrackContext } from './track';

const NOW = Date.UTC(2026, 9, 8, 12, 0);

const ctx = (over: Partial<SaleTrackContext['lead']> = {}, extra: Partial<SaleTrackContext> = {}): SaleTrackContext => ({
  lead: { id: 'L1', status: 'converted', ownerId: 'tel1', managerIds: ['man1'], fullName: 'Jean Dupont', saleId: 'L1', commercialState: 'sale_committed', financialState: 'none', securedAtMs: null, ...over },
  saleNumber: 'V-2026-00042',
  remainderCents: 349_000,
  actorId: 'tel1',
  actorRole: 'telepro',
  nowMs: NOW,
  ...extra,
});
const plan = (a: SaleAction, c = ctx()) => {
  const r = planSaleAction(a, c);
  if (!r.ok) throw new Error(`refusé : ${r.message}`);
  return r.plan;
};
const refused = (a: SaleAction, c = ctx()) => {
  const r = planSaleAction(a, c);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r;
};

describe('sécurisation (§23.11)', () => {
  it('sécurisée = signée ET paiement confirmé ou financement accepté', () => {
    expect(isSecured('signed', 'payment_confirmed')).toBe(true);
    expect(isSecured('signed', 'financing_accepted')).toBe(true);
  });
  it('un financement demandé ou refusé, un acompte, ou une offre non signée ne sécurisent rien', () => {
    for (const f of ['none', 'deposit_expected', 'deposit_received', 'financing_in_progress', 'financing_refused']) expect(isSecured('signed', f)).toBe(false);
    expect(isSecured('offer_sent', 'payment_confirmed')).toBe(false);
  });
});

describe('parcours comptant et financement (§23.8)', () => {
  it('comptant : offre envoyée → signée → acompte attendu → reçu → paiement confirmé, sécurisée à la fin seulement', () => {
    let c = ctx();
    const step = (a: SaleAction) => {
      const p = plan(a, c);
      c = ctx({ commercialState: p.commercialState, financialState: p.financialState, securedAtMs: p.newlySecuredAtMs ?? c.lead.securedAtMs });
      return p;
    };
    expect(step({ kind: 'offer_sent', channel: 'email' }).commercialState).toBe('offer_sent');
    expect(step({ kind: 'signed' }).commercialState).toBe('signed');
    expect(step({ kind: 'deposit_expected', amountCents: 90_000 }).financialState).toBe('deposit_expected');
    const recu = step({ kind: 'deposit_received' });
    expect(recu.financialState).toBe('deposit_received');
    expect(recu.newlySecuredAtMs).toBeNull();
    const fin = step({ kind: 'payment_confirmed' });
    expect(fin.newlySecuredAtMs).toBe(NOW);
    expect(fin.message).toContain('sécurisée');
    expect(fin.notifications[0]).toMatchObject({ title: 'Vente sécurisée', recipientIds: ['man1'] });
  });
  it('financement : demandé → accepté, sécurisée', () => {
    const started = plan({ kind: 'financing_started', organism: 'Floa' });
    expect(started).toMatchObject({ financialState: 'financing_in_progress', trackPatch: { financingOrganism: 'Floa' }, newlySecuredAtMs: null });
    const accepted = plan({ kind: 'financing_accepted' }, ctx({ commercialState: 'signed', financialState: 'financing_in_progress' }));
    expect(accepted.financialState).toBe('financing_accepted');
    expect(accepted.newlySecuredAtMs).toBe(NOW);
  });
  it('financement accepté mais vente non signée : pas sécurisée', () => {
    const p = plan({ kind: 'financing_accepted' }, ctx({ commercialState: 'offer_sent', financialState: 'financing_in_progress' }));
    expect(p.newlySecuredAtMs).toBeNull();
  });
  it('signature après un règlement déjà confirmé : sécurisée à la signature', () => {
    const p = plan({ kind: 'signed' }, ctx({ commercialState: 'offer_sent', financialState: 'payment_confirmed' }));
    expect(p.newlySecuredAtMs).toBe(NOW);
  });
  it('déjà sécurisée : la date de sécurisation ne bouge plus', () => {
    const p = plan({ kind: 'retract', reason: 'Rétractation sous 14 jours' }, ctx({ commercialState: 'signed', financialState: 'payment_confirmed', securedAtMs: 123 }, { actorId: 'man1', actorRole: 'manager' }));
    expect(p.newlySecuredAtMs).toBeNull();
  });
  it('refus de financement : motif obligatoire, la vente reste ouverte, les responsables sont prévenus (jamais perdue)', () => {
    const c = ctx({ commercialState: 'signed', financialState: 'financing_in_progress' });
    expect(refused({ kind: 'financing_refused', reason: 'non' }, c).code).toBe('invalid');
    const p = plan({ kind: 'financing_refused', reason: 'Revenus insuffisants' }, c);
    expect(p).toMatchObject({ financialState: 'financing_refused', commercialState: 'signed' });
    expect(p.notifications[0]).toMatchObject({ title: 'Financement refusé', recipientIds: ['man1'] });
    expect(p.message).toContain('autre solution');
  });
  it('après un refus : nouveau financement ou passage au comptant', () => {
    const c = ctx({ commercialState: 'signed', financialState: 'financing_refused' });
    expect(plan({ kind: 'financing_started', organism: 'Sofinco' }, c).financialState).toBe('financing_in_progress');
    expect(plan({ kind: 'payment_confirmed' }, c).financialState).toBe('payment_confirmed');
  });
});

describe('contrôles de cohérence', () => {
  it('accepter ou refuser un financement jamais demandé : impossible', () => {
    expect(refused({ kind: 'financing_accepted' }).code).toBe('unavailable');
    expect(refused({ kind: 'financing_refused', reason: 'Motif valable' }).code).toBe('unavailable');
  });
  it('offre déjà envoyée ou signée : on ne la renvoie pas', () => {
    expect(refused({ kind: 'offer_sent', channel: 'sms' }, ctx({ commercialState: 'offer_sent' })).code).toBe('unavailable');
    expect(refused({ kind: 'signed' }, ctx({ commercialState: 'signed' })).code).toBe('unavailable');
  });
  it('règlement déjà confirmé : plus de modification du règlement', () => {
    expect(refused({ kind: 'payment_confirmed' }, ctx({ commercialState: 'signed', financialState: 'payment_confirmed' })).code).toBe('unavailable');
    expect(refused({ kind: 'financing_started', organism: 'Floa' }, ctx({ commercialState: 'signed', financialState: 'financing_accepted' })).code).toBe('unavailable');
  });
  it('acompte : montant positif et pas au-delà du reste à charge', () => {
    expect(refused({ kind: 'deposit_expected', amountCents: 0 }).code).toBe('invalid');
    expect(refused({ kind: 'deposit_expected', amountCents: -5 }).code).toBe('invalid');
    expect(refused({ kind: 'deposit_expected', amountCents: Number.NaN }).code).toBe('invalid');
    expect(refused({ kind: 'deposit_expected', amountCents: 400_000 }).message).toContain('reste à charge');
    expect(plan({ kind: 'deposit_expected', amountCents: 349_000 }).trackPatch.depositCents).toBe(349_000);
  });
  it('financement : organisme obligatoire ; canal d’envoi connu', () => {
    expect(refused({ kind: 'financing_started', organism: ' ' }).code).toBe('invalid');
    expect(refused({ kind: 'offer_sent', channel: 'pigeon' as never }).code).toBe('invalid');
  });
  it('action inconnue : refusée', () => expect(refused({ kind: 'explode' } as never).code).toBe('unavailable'));
});

describe('annulation et rétractation', () => {
  const manager = ctx({}, { actorId: 'man1', actorRole: 'manager' });
  it('motif obligatoire ; réservé au manager et à l’administrateur', () => {
    expect(refused({ kind: 'cancel', reason: 'ok' }, manager).code).toBe('invalid');
    expect(refused({ kind: 'cancel', reason: 'Client revenu sur sa décision' }).code).toBe('forbidden');
    expect(plan({ kind: 'cancel', reason: 'Client revenu sur sa décision' }, manager)).toMatchObject({ commercialState: 'cancelled' });
    expect(plan({ kind: 'retract', reason: 'Rétractation sous 14 jours' }, ctx({}, { actorId: 'adm', actorRole: 'admin' }))).toMatchObject({ commercialState: 'retracted' });
  });
  it('le propriétaire est prévenu avec un signal critique', () => {
    const p = plan({ kind: 'cancel', reason: 'Client revenu sur sa décision' }, manager);
    expect(p.notifications[0]).toMatchObject({ recipientIds: ['tel1'], sound: 'critical', title: 'Vente annulée' });
    expect(p.trackPatch).toMatchObject({ cancelReason: 'Client revenu sur sa décision', cancelledAt: NOW });
  });
  it('vente annulée ou rétractée : plus aucune action, même une relance', () => {
    for (const s of ['cancelled', 'retracted']) {
      expect(refused({ kind: 'reminder' }, ctx({ commercialState: s })).message).toContain('plus aucune action');
      expect(availableSaleActions(s, 'none')).toEqual([]);
    }
  });
});

describe('droits', () => {
  it('propriétaire, manager du lead et administrateur seulement', () => {
    expect(planSaleAction({ kind: 'reminder' }, ctx()).ok).toBe(true);
    expect(planSaleAction({ kind: 'reminder' }, ctx({}, { actorId: 'man1', actorRole: 'manager' })).ok).toBe(true);
    expect(planSaleAction({ kind: 'reminder' }, ctx({}, { actorId: 'adm', actorRole: 'admin' })).ok).toBe(true);
    expect(refused({ kind: 'reminder' }, ctx({}, { actorId: 'autre' })).code).toBe('forbidden');
    expect(refused({ kind: 'reminder' }, ctx({}, { actorId: 'man9', actorRole: 'manager' })).code).toBe('forbidden');
  });
  it('lead sans vente : refusé', () => expect(refused({ kind: 'reminder' }, ctx({ saleId: null })).message).toContain("pas de vente"));
});

describe('relance et actions proposées', () => {
  it('une relance enregistre sa date, sans changer aucun état', () => {
    const p = plan({ kind: 'reminder', note: 'Message laissé' });
    expect(p).toMatchObject({ commercialState: 'sale_committed', financialState: 'none', trackPatch: { lastReminderAt: NOW }, newlySecuredAtMs: null });
    expect(p.events[0].note).toBe('Relance du client — Message laissé');
  });
  it('plus de relance quand la vente est sécurisée', () => {
    expect(availableSaleActions('signed', 'payment_confirmed')).not.toContain('reminder');
    expect(refused({ kind: 'reminder' }, ctx({ commercialState: 'signed', financialState: 'payment_confirmed' })).code).toBe('unavailable');
  });
  it('l’écran ne propose que ce que le serveur accepte, à chaque état', () => {
    const commercials = ['none', 'sale_committed', 'offer_sent', 'signed', 'cancelled', 'retracted'];
    const financials = ['none', 'deposit_expected', 'deposit_received', 'financing_in_progress', 'financing_accepted', 'financing_refused', 'payment_confirmed'];
    const sample: Record<string, SaleAction> = {
      offer_sent: { kind: 'offer_sent', channel: 'email' }, signed: { kind: 'signed' }, deposit_expected: { kind: 'deposit_expected', amountCents: 1000 }, deposit_received: { kind: 'deposit_received' },
      payment_confirmed: { kind: 'payment_confirmed' }, financing_started: { kind: 'financing_started', organism: 'Floa' }, financing_accepted: { kind: 'financing_accepted' },
      financing_refused: { kind: 'financing_refused', reason: 'Motif valable' }, cancel: { kind: 'cancel', reason: 'Motif valable' }, retract: { kind: 'retract', reason: 'Motif valable' }, reminder: { kind: 'reminder' },
    };
    for (const c of commercials) for (const f of financials) {
      const offered = availableSaleActions(c, f);
      for (const kind of Object.keys(sample)) {
        const r = planSaleAction(sample[kind], ctx({ commercialState: c, financialState: f }, { actorId: 'adm', actorRole: 'admin' }));
        expect(r.ok, `${c}/${f}/${kind}`).toBe(offered.includes(kind as SaleAction['kind']));
      }
    }
  });
});

describe('message de relance à copier', () => {
  it('offre à signer : prénom, produit et montant', () => {
    const m = buildSaleReminderMessage({ firstName: 'Jean', product: 'PAC', totalTtcCents: 1_599_000, stage: 'to_sign', financialState: 'none' });
    expect(m).toContain('Bonjour Jean,');
    expect(m).toContain('votre projet PAC');
    expect(m).toMatch(/15\s990 € TTC/);
    expect(m).toContain('signature');
  });
  it('sans prénom ni produit ni montant : reste lisible', () => {
    const m = buildSaleReminderMessage({ firstName: '', product: null, totalTtcCents: null, stage: 'to_sign', financialState: 'none' });
    expect(m.startsWith('Bonjour,')).toBe(true);
    expect(m).not.toContain('null');
    expect(m).not.toContain('undefined');
  });
  it('à sécuriser : adapté à la situation du règlement', () => {
    expect(buildSaleReminderMessage({ firstName: 'A', product: 'SSC', totalTtcCents: 1, stage: 'to_secure', financialState: 'financing_refused' })).toContain('autre solution');
    expect(buildSaleReminderMessage({ firstName: 'A', product: 'SSC', totalTtcCents: 1, stage: 'to_secure', financialState: 'financing_in_progress' })).toContain('organisme');
    expect(buildSaleReminderMessage({ firstName: 'A', product: 'SSC', totalTtcCents: 1, stage: 'to_secure', financialState: 'deposit_expected' })).toContain('règlement');
  });
});
