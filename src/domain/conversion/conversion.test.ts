import { describe, expect, it } from 'vitest';
import { computeRecap, formatEuros, parseEuroCents, priceOfProduct, type OfferLine } from './finance';
import { draftFromLead, emptyDraft, sanitizeDraft, type MontageDraft } from './montage';
import { canCreateSale, DEFAULT_CONVERSION_RULES, evaluateControls, lockReason, type ControlInput } from './controls';
import { noValidation, planConversionAction, saleNumber, type ConversionContext, type StoredValidation } from './plan';

const NOW = Date.parse('2026-10-08T10:00:00Z');
const line = (over: Partial<OfferLine> = {}): OfferLine => ({ id: 'l1', productId: 'p1', label: 'PAC Air/Eau', service: 'Fourniture et pose', qty: 1, unitHtCents: 1_000_000, vatRate: 20, ...over });

/** Dossier de la maquette (fig. 1) : 15 990 € TTC − 8 000 € MPR − 4 500 € CEE = 3 490 € à charge. */
function completeDraft(over: Partial<MontageDraft> = {}): MontageDraft {
  const d = emptyDraft();
  d.identity = { fullName: 'Jean Dupont', phone: '0612345678', email: 'jean@x.fr', addressLine: '15 rue des Lilas', postalCode: '69003', city: 'Lyon' };
  d.project = { housingType: 'Maison individuelle', occupancy: 'Propriétaire occupant', livingAreaM2: 125, currentHeating: 'Chaudière fioul', climateZone: 'H1', cadastralRef: '', previsitDate: '' };
  d.aids = { mprCents: 800_000, ceeCents: 450_000, delegate: 'TotalEnergies', rfrCents: null, householdSize: 3, eligibility: 'validated', ceeDoubleChecked: true };
  d.offer = { lines: [line({ unitHtCents: 1_332_500 })], discountCents: 0, financing: { mode: 'cash', downPaymentCents: 0 }, rge: true };
  d.consentConfirmed = true;
  return { ...d, ...over };
}

const docsOk = { mandatory: 6, mandatoryConform: 6, withReserve: 0 };
const controlInput = (over: Partial<ControlInput> = {}): ControlInput => ({ lead: { consent: true, productCode: 'PAC' }, draft: completeDraft(), docs: docsOk, qualificationMissing: [], rules: DEFAULT_CONVERSION_RULES, ...over });

describe('calcul financier (§11.5)', () => {
  it('reste à charge = TTC − MPR − CEE − remise (maquette : 3 490 €)', () => {
    const r = computeRecap([line({ unitHtCents: 1_332_500 })], 800_000, 450_000, 0);
    expect(r.totalTtcCents).toBe(1_599_000);
    expect(r.remainderCents).toBe(349_000);
    expect(formatEuros(r.remainderCents)).toMatch(/3\s490 €/);
  });
  it('la remise est déduite et rapportée au prix TTC', () => {
    const r = computeRecap([line()], 0, 0, 60_000);
    expect(r.totalTtcCents).toBe(1_200_000);
    expect(r.remainderCents).toBe(1_140_000);
    expect(r.discountPct).toBe(5);
  });
  it('plusieurs lignes, quantités et TVA différentes, sans flottant', () => {
    const r = computeRecap([line({ qty: 2, unitHtCents: 33_333, vatRate: 5.5 }), line({ id: 'l2', unitHtCents: 10_000, vatRate: 20 })], 0, 0, 0);
    expect(r.totalHtCents).toBe(76_666);
    expect(Number.isInteger(r.totalTtcCents)).toBe(true);
    expect(r.vatCents).toBe(r.totalTtcCents - r.totalHtCents);
  });
  it('aides supérieures au prix : reste négatif (bloqué par les contrôles)', () => expect(computeRecap([line()], 900_000, 500_000, 0).remainderCents).toBeLessThan(0));
  it('montants négatifs ou invalides ramenés à zéro', () => {
    const r = computeRecap([line()], -5, Number.NaN, -10);
    expect([r.mprCents, r.ceeCents, r.discountCents]).toEqual([0, 0, 0]);
  });
  it('parseEuroCents : virgule, espaces, symbole € ; refuse le négatif et le texte', () => {
    expect(parseEuroCents('11 990,50 €')).toBe(1_199_050);
    expect(parseEuroCents('12.5')).toBe(1250);
    expect(parseEuroCents(-1)).toBeNull();
    expect(parseEuroCents('abc')).toBeNull();
    expect(parseEuroCents('')).toBeNull();
  });
  it("prix d'un article du catalogue principal (HT, sinon TTC)", () => {
    expect(priceOfProduct({ ht: '100', tva: 20, ttc: '120.00' })).toEqual({ unitHtCents: 10_000, vatRate: 20 });
    expect(priceOfProduct({ ht: '', tva: 5.5, ttc: '105.50' })).toEqual({ unitHtCents: 10_000, vatRate: 5.5 });
    expect(priceOfProduct({ ht: '', ttc: '' })).toBeNull();
    expect(priceOfProduct(null)).toBeNull();
  });
});

describe('brouillon de montage', () => {
  it('reprend ce que le lead sait déjà (aucune ressaisie)', () => {
    const d = draftFromLead({ fullName: 'Léa Martin', phone: '+33612345678', email: 'lea@x.fr', address: { line: '1 rue A', postalCode: '97400', city: 'Saint-Denis' }, qualification: { isHomeOwner: 'oui', houseSurface: 90, currentHeatingType: 'fioul', numberOfPersons: 4, rfr: '24 500' } });
    expect(d.identity.fullName).toBe('Léa Martin');
    expect(d.project).toMatchObject({ occupancy: 'Propriétaire occupant', livingAreaM2: 90, currentHeating: 'fioul' });
    expect(d.aids).toMatchObject({ householdSize: 4, rfrCents: 2_450_000 });
  });
  it('ignore « non_renseigne »', () => {
    const d = draftFromLead({ fullName: 'A', phone: null, email: null, address: {}, qualification: { isHomeOwner: 'non_renseigne', houseSurface: 0 } });
    expect(d.project.occupancy).toBe('');
    expect(d.project.livingAreaM2).toBeNull();
  });
  it('sanitizeDraft impose types, bornes et longueurs', () => {
    const d = sanitizeDraft({ identity: { fullName: 'x'.repeat(500), email: ' A@B.FR ' }, aids: { mprCents: -5, eligibility: 'hack' }, offer: { lines: Array.from({ length: 80 }, () => ({ label: 'a', qty: -1, unitHtCents: 'zz', vatRate: 99 })), discountCents: 1e15 } });
    expect(d.identity.fullName).toHaveLength(120);
    expect(d.identity.email).toBe('a@b.fr');
    expect(d.aids.mprCents).toBe(0);
    expect(d.aids.eligibility).toBeNull();
    expect(d.offer.lines).toHaveLength(30);
    expect(d.offer.lines[0]).toMatchObject({ qty: 1, unitHtCents: 0, vatRate: 20 });
    expect(d.offer.discountCents).toBe(100_000_000);
  });
  it('rejette une entrée qui n’est pas un objet', () => {
    expect(sanitizeDraft(null)).toEqual(emptyDraft());
    expect(sanitizeDraft('texte')).toEqual(emptyDraft());
  });
});

describe('verrou de conversion (§11.2, §11.6)', () => {
  it('dossier complet : tout est validé, la vente peut être créée', () => {
    const r = evaluateControls(controlInput());
    expect(r.clean).toBe(true);
    expect(r.toConfirm).toEqual([]);
    expect(canCreateSale(r, noValidation())).toBe(true);
    expect(lockReason(r, noValidation())).toBeNull();
  });
  it('contrôle obligatoire manquant : bloquant, et le message dit quoi', () => {
    const d = completeDraft();
    d.identity.addressLine = '';
    const r = evaluateControls(controlInput({ draft: d }));
    expect(r.clean).toBe(false);
    expect(r.blocking.find((c) => c.key === 'identity')?.detail).toContain('adresse');
    expect(lockReason(r, noValidation())).toBe('1 contrôle bloquant');
    expect(canCreateSale(r, noValidation())).toBe(false);
  });
  it('documents : tous obligatoires conformes exigés', () => {
    const r = evaluateControls(controlInput({ docs: { mandatory: 6, mandatoryConform: 5, withReserve: 0 } }));
    expect(r.blocking.find((c) => c.key === 'documents')?.detail).toContain('5 / 6');
    expect(evaluateControls(controlInput({ docs: { mandatory: 0, mandatoryConform: 0, withReserve: 0 } })).clean).toBe(false);
  });
  it('document validé avec réserve : exception pour le manager, pas un blocage', () => {
    const r = evaluateControls(controlInput({ docs: { mandatory: 6, mandatoryConform: 6, withReserve: 1 } }));
    expect(r.clean).toBe(true);
    expect(r.toConfirm.map((c) => c.key)).toEqual(['documents']);
  });
  it('éligibilité : refusée bloque, incertaine ou absente passe par le manager', () => {
    const refused = completeDraft();
    refused.aids.eligibility = 'refused';
    expect(evaluateControls(controlInput({ draft: refused })).blocking.map((c) => c.key)).toContain('eligibility');
    const unsure = completeDraft();
    unsure.aids.eligibility = 'to_confirm';
    expect(evaluateControls(controlInput({ draft: unsure })).toConfirm.map((c) => c.key)).toEqual(['eligibility']);
    const none = completeDraft();
    none.aids.eligibility = null;
    expect(evaluateControls(controlInput({ draft: none })).toConfirm.map((c) => c.key)).toEqual(['eligibility']);
  });
  it('remise au-delà du seuil : exception ; sous le seuil : ok', () => {
    const over = completeDraft();
    over.offer.discountCents = 200_000;
    expect(evaluateControls(controlInput({ draft: over })).toConfirm.map((c) => c.key)).toEqual(['discount']);
    const under = completeDraft();
    under.offer.discountCents = 50_000;
    const r = evaluateControls(controlInput({ draft: under }));
    expect(r.toConfirm).toEqual([]);
    expect(r.controls.find((c) => c.key === 'discount')?.level).toBe('ok');
  });
  it('produit hors catalogue : accord explicite du manager (gravité haute)', () => {
    const d = completeDraft();
    d.offer.lines = [line({ productId: null, label: 'Matériel spécial', unitHtCents: 1_332_500 })];
    const c = evaluateControls(controlInput({ draft: d })).toConfirm.find((x) => x.key === 'catalog');
    expect(c?.severity).toBe('high');
  });
  it('CEE : délégataire et double valorisation obligatoires', () => {
    const d = completeDraft();
    d.aids.delegate = '';
    d.aids.ceeDoubleChecked = false;
    const c = evaluateControls(controlInput({ draft: d })).blocking.find((x) => x.key === 'cee');
    expect(c?.detail).toContain('délégataire');
    expect(c?.detail).toContain('double valorisation');
  });
  it('sans montant CEE, pas de contrôle CEE', () => {
    const d = completeDraft();
    d.aids.ceeCents = 0;
    expect(evaluateControls(controlInput({ draft: d })).controls.some((c) => c.key === 'cee')).toBe(false);
  });
  it('RGE : non confirmée ou refusée bloque', () => {
    const none = completeDraft();
    none.offer.rge = null;
    expect(evaluateControls(controlInput({ draft: none })).blocking.map((c) => c.key)).toContain('rge');
    const no = completeDraft();
    no.offer.rge = false;
    expect(evaluateControls(controlInput({ draft: no })).blocking.find((c) => c.key === 'rge')?.detail).toContain('incompatibles');
  });
  it('aides supérieures au prix : bloqué', () => {
    const d = completeDraft();
    d.aids.mprCents = 2_000_000;
    expect(evaluateControls(controlInput({ draft: d })).blocking.map((c) => c.key)).toContain('amounts');
  });
  it('consentement absent : exception de gravité haute ; confirmé au montage : ok', () => {
    const d = completeDraft();
    d.consentConfirmed = false;
    const r = evaluateControls(controlInput({ draft: d, lead: { consent: null, productCode: 'PAC' } }));
    expect(r.toConfirm.find((c) => c.key === 'consent')?.severity).toBe('high');
    expect(evaluateControls(controlInput({ lead: { consent: true, productCode: 'PAC' }, draft: d })).controls.find((c) => c.key === 'consent')?.level).toBe('ok');
  });
  it('champs de qualification du produit manquants : listés dans le blocage', () => {
    const r = evaluateControls(controlInput({ qualificationMissing: ['Tension électrique'] }));
    expect(r.blocking.find((c) => c.key === 'project')?.detail).toContain('Tension électrique');
  });
  it('une approbation ne vaut que pour la situation validée (empreinte)', () => {
    const d = completeDraft();
    d.offer.discountCents = 200_000;
    const r = evaluateControls(controlInput({ draft: d }));
    const approved: StoredValidation = { ...noValidation(), state: 'approved', fingerprint: r.fingerprint };
    expect(canCreateSale(r, approved)).toBe(true);
    d.offer.discountCents = 250_000;
    const changed = evaluateControls(controlInput({ draft: d }));
    expect(canCreateSale(changed, approved)).toBe(false);
    expect(lockReason(changed, approved)).toMatch(/ne couvre plus/);
    expect(lockReason(r, { ...noValidation(), state: 'pending' })).toMatch(/attente/);
    expect(lockReason(r, noValidation())).toBe('1 exception à faire valider par le manager');
  });
});

// ── Actions ──
const LEAD = { id: 'L1', status: 'file_building' as const, ownerId: 'tel1', managerIds: ['man1'], fullName: 'Jean Dupont', consent: true, productCode: 'PAC', campaignName: 'PAC IDF' };
function ctx(over: Partial<ConversionContext> & { leadOver?: Partial<ConversionContext['lead']> } = {}): ConversionContext {
  return {
    lead: { ...LEAD, ...over.leadOver },
    draft: over.draft === undefined ? completeDraft() : over.draft,
    docs: over.docs ?? docsOk,
    qualificationMissing: [],
    validation: over.validation ?? noValidation(),
    nextSaleSeq: over.nextSaleSeq ?? 42,
    actorId: over.actorId ?? 'tel1',
    actorRole: over.actorRole ?? 'telepro',
    nowMs: NOW,
    requestId: 'req-00001',
  };
}
const plan = (input: Parameters<typeof planConversionAction>[0], c = ctx()) => {
  const r = planConversionAction(input, c);
  if (!r.ok) throw new Error(`refusé : ${r.message}`);
  return r.plan;
};
const refused = (input: Parameters<typeof planConversionAction>[0], c = ctx()) => {
  const r = planConversionAction(input, c);
  if (r.ok) throw new Error('aurait dû être refusé');
  return r;
};
const withDiscount = () => {
  const d = completeDraft();
  d.offer.discountCents = 200_000;
  return d;
};

describe('enregistrer le brouillon', () => {
  it('dossier complet : le lead passe à « Dossier prêt »', () => {
    const p = plan({ kind: 'save_draft', draft: completeDraft() });
    expect(p.status).toBe('file_ready');
    expect(p.draft?.identity.fullName).toBe('Jean Dupont');
    expect(p.events.some((e) => e.type === 'status_changed')).toBe(true);
  });
  it('dossier incomplet : reste en montage, brouillon quand même enregistré', () => {
    const p = plan({ kind: 'save_draft', draft: { ...completeDraft(), identity: { ...completeDraft().identity, city: '' } } });
    expect(p.status).toBe('file_building');
    expect(p.summary.blocking).toBe(1);
    expect(p.draft).not.toBeNull();
  });
  it('exceptions non validées : reste en montage', () => expect(plan({ kind: 'save_draft', draft: withDiscount() }).status).toBe('file_building'));
  it("modifier le dossier annule l'approbation du manager", () => {
    const base = evaluateControls(controlInput({ draft: withDiscount() }));
    const approved: StoredValidation = { ...noValidation(), state: 'approved', fingerprint: base.fingerprint, decidedBy: 'man1' };
    const d = withDiscount();
    d.offer.discountCents = 300_000;
    const p = plan({ kind: 'save_draft', draft: d }, ctx({ validation: approved, leadOver: { status: 'file_ready' } }));
    expect(p.validation?.state).toBe('none');
    expect(p.status).toBe('file_building');
    expect(p.events.some((e) => e.meta?.op === 'approval_void')).toBe(true);
  });
  it('refusé pendant une validation en attente', () => expect(refused({ kind: 'save_draft', draft: completeDraft() }, ctx({ leadOver: { status: 'manager_validation' } })).code).toBe('unavailable'));
  it('refusé avant le montage', () => expect(refused({ kind: 'save_draft', draft: completeDraft() }, ctx({ leadOver: { status: 'awaiting_documents' } })).code).toBe('unavailable'));
  it("refusé à un télépro qui n'est pas propriétaire, accepté au manager du lead et à l'admin", () => {
    expect(refused({ kind: 'save_draft', draft: completeDraft() }, ctx({ actorId: 'autre' })).code).toBe('forbidden');
    expect(refused({ kind: 'save_draft', draft: completeDraft() }, ctx({ actorId: 'man9', actorRole: 'manager' })).code).toBe('forbidden');
    expect(plan({ kind: 'save_draft', draft: completeDraft() }, ctx({ actorId: 'man1', actorRole: 'manager' })).status).toBe('file_ready');
    expect(plan({ kind: 'save_draft', draft: completeDraft() }, ctx({ actorId: 'adm', actorRole: 'admin' })).status).toBe('file_ready');
  });
  it('refusé sur un lead clôturé', () => expect(refused({ kind: 'save_draft', draft: completeDraft() }, ctx({ leadOver: { status: 'not_interested' } })).code).toBe('lead_closed'));
});

describe('demander une validation manager (§11.6)', () => {
  const ask = { kind: 'request_validation' as const, message: 'Remise accordée au client fidèle.' };
  it('exceptions seules : statut « Validation manager », managers prévenus', () => {
    const p = plan(ask, ctx({ draft: withDiscount() }));
    expect(p.status).toBe('manager_validation');
    expect(p.validation).toMatchObject({ state: 'pending', requestedBy: 'tel1', message: 'Remise accordée au client fidèle.' });
    expect(p.validation?.exceptions.map((e) => e.key)).toEqual(['discount']);
    expect(p.notifications[0]).toMatchObject({ recipientIds: ['man1'], sound: 'critical' });
    expect(p.events.some((e) => e.type === 'exception')).toBe(true);
  });
  it('un contrôle bloquant empêche toute demande', () => {
    const d = withDiscount();
    d.identity.city = '';
    expect(refused(ask, ctx({ draft: d })).message).toContain('bloquant');
  });
  it("sans exception, la demande n'a pas lieu d'être", () => expect(refused(ask).message).toContain('Aucune exception'));
  it('le message au manager est obligatoire', () => expect(refused({ kind: 'request_validation', message: ' court ' }, ctx({ draft: withDiscount() })).code).toBe('invalid'));
  it("pas de seconde demande tant qu'une est en attente", () => expect(refused(ask, ctx({ draft: withDiscount(), leadOver: { status: 'manager_validation' } })).message).toContain('déjà en attente'));
  it('refusé sans brouillon enregistré', () => expect(refused(ask, ctx({ draft: null })).code).toBe('unavailable'));
});

describe('décision du manager (§11.6)', () => {
  const pending = (): StoredValidation => {
    const r = evaluateControls(controlInput({ draft: withDiscount() }));
    return { ...noValidation(), state: 'pending', fingerprint: r.fingerprint, requestedBy: 'tel1', requestedAtMs: NOW - 1000, message: 'm', exceptions: [] };
  };
  const mctx = (over: Partial<ConversionContext> = {}) => ctx({ draft: withDiscount(), validation: pending(), leadOver: { status: 'manager_validation' }, actorId: 'man1', actorRole: 'manager', ...over });
  it('approuver : dossier prêt, propriétaire prévenu, décision tracée', () => {
    const p = plan({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx());
    expect(p.status).toBe('file_ready');
    expect(p.validation).toMatchObject({ state: 'approved', decidedBy: 'man1' });
    expect(p.notifications[0].recipientIds).toEqual(['tel1']);
    expect(p.events.find((e) => e.type === 'exception')?.meta).toMatchObject({ decision: 'approve' });
  });
  it("l'approbation exige la case « j'ai vérifié les éléments signalés »", () => expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: false }, mctx()).code).toBe('invalid'));
  it('refuser ou demander une correction exige un commentaire', () => {
    expect(refused({ kind: 'decide', decision: 'refuse', comment: '', acknowledged: false }, mctx()).code).toBe('invalid');
    expect(refused({ kind: 'decide', decision: 'correction', comment: 'ok', acknowledged: false }, mctx()).code).toBe('invalid');
    const p = plan({ kind: 'decide', decision: 'refuse', comment: 'Remise trop forte', acknowledged: false }, mctx());
    expect(p.status).toBe('file_building');
    expect(p.validation?.state).toBe('refused');
    expect(plan({ kind: 'decide', decision: 'correction', comment: 'Corriger la remise', acknowledged: false }, mctx()).validation?.state).toBe('correction');
  });
  it('le demandeur ne décide jamais de sa propre demande', () => {
    expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ actorId: 'man1', validation: { ...pending(), requestedBy: 'man1' } })).code).toBe('forbidden');
  });
  it('un télépro, même propriétaire, ne décide pas', () => expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ actorId: 'tel1', actorRole: 'telepro' })).code).toBe('forbidden'));
  it('un manager étranger au lead ne décide pas ; un administrateur peut', () => {
    expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ actorId: 'man9' })).code).toBe('forbidden');
    expect(plan({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ actorId: 'adm', actorRole: 'admin' })).status).toBe('file_ready');
  });
  it('sans demande en attente : refusé', () => expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ validation: noValidation() })).code).toBe('unavailable'));
  it('approbation impossible si le dossier a changé depuis la demande', () => {
    const d = withDiscount();
    d.offer.discountCents = 300_000;
    expect(refused({ kind: 'decide', decision: 'approve', comment: '', acknowledged: true }, mctx({ draft: d })).message).toContain('a changé');
  });
});

describe('création de la vente (§11.7)', () => {
  it('dossier prêt : vente numérotée, lead « Transmission en cours »', () => {
    const p = plan({ kind: 'create_sale' }, ctx({ leadOver: { status: 'file_ready' } }));
    expect(p.status).toBe('transmitting');
    expect(p.sale).toMatchObject({ number: 'V-2026-00042', totalTtcCents: 1_599_000, remainderCents: 349_000, productCode: 'PAC', ownerId: 'tel1', validatedBy: null });
    expect(p.events.some((e) => e.type === 'conversion')).toBe(true);
    expect(p.notifications[0].recipientIds).toEqual(['man1']);
  });
  it("un dossier sans exception peut passer directement de « montage » à la vente", () => expect(plan({ kind: 'create_sale' }).status).toBe('transmitting'));
  it('contrôle bloquant : refus qui explique chaque critère manquant', () => {
    const d = completeDraft();
    d.offer.rge = null;
    d.identity.city = '';
    const r = refused({ kind: 'create_sale' }, ctx({ draft: d }));
    expect(r.message).toContain('Qualification RGE');
    expect(r.message).toContain('Identité complète');
  });
  it('exception sans approbation : refusée ; avec approbation valide : créée, approbateur conservé', () => {
    expect(refused({ kind: 'create_sale' }, ctx({ draft: withDiscount() })).message).toContain('validation du manager');
    const r = evaluateControls(controlInput({ draft: withDiscount() }));
    const approved: StoredValidation = { ...noValidation(), state: 'approved', fingerprint: r.fingerprint, decidedBy: 'man1' };
    const p = plan({ kind: 'create_sale' }, ctx({ draft: withDiscount(), validation: approved, leadOver: { status: 'file_ready' } }));
    expect(p.sale?.validatedBy).toBe('man1');
  });
  it('approbation périmée (remise modifiée) : refusée', () => {
    const r = evaluateControls(controlInput({ draft: withDiscount() }));
    const approved: StoredValidation = { ...noValidation(), state: 'approved', fingerprint: r.fingerprint, decidedBy: 'man1' };
    const d = withDiscount();
    d.offer.discountCents = 400_000;
    expect(refused({ kind: 'create_sale' }, ctx({ draft: d, validation: approved, leadOver: { status: 'file_ready' } })).code).toBe('unavailable');
  });
  it('pas de seconde vente : lead déjà converti ou en transmission', () => {
    for (const status of ['converted', 'transmitting', 'transmission_error'] as const) {
      expect(refused({ kind: 'create_sale' }, ctx({ leadOver: { status } })).message).toContain('déjà créée');
    }
  });
  it('en attente de validation : refusée ; numéro de vente invalide : refusé', () => {
    expect(refused({ kind: 'create_sale' }, ctx({ leadOver: { status: 'manager_validation' } })).code).toBe('unavailable');
    expect(refused({ kind: 'create_sale' }, ctx({ nextSaleSeq: 0 })).code).toBe('invalid');
  });
  it('numéro de vente : année et séquence sur 5 chiffres', () => expect(saleNumber(NOW, 7)).toBe('V-2026-00007'));
  it('compteurs de charge : le dossier sort de « à monter » seulement quand son statut le dit', () => {
    expect(plan({ kind: 'create_sale' }).loadDelta).toEqual({});
  });
});
