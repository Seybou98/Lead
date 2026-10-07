import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSIGNMENT_CONFIG, type Candidate } from '../engine/assignment';
import { mapPayload } from './mapPayload';
import { idempotencyKeysFor, planIngestion, type CampaignInfo, type ExistingLead, type PlanInput } from './plan';

const NOW = Date.UTC(2026, 9, 5, 8, 0);

const campaign: CampaignInfo = {
  id: 'camp1',
  name: 'PAC IDF — Septembre',
  status: 'active',
  productCode: 'pac_air_eau',
  eligibleUserIds: [],
  eligibleTeamIds: ['pac'],
  fallbackTeamId: null,
};

const cand = (uid: string, over: Partial<Candidate> = {}): Candidate => ({
  uid,
  name: uid,
  accountActive: true,
  accessEndsAtMs: null,
  connected: true,
  operationalStatus: 'available',
  distributionSuspended: false,
  absent: false,
  withinSchedule: true,
  teamIds: ['pac'],
  scope: { productCodes: ['*'], zones: ['*'] },
  newLeads: 0,
  activeLoad: 0,
  capacity: { newLeadsCap: 10, override: null },
  lastAssignedAtMs: null,
  ...over,
});

const existingLead = (over: Partial<ExistingLead> = {}): ExistingLead => ({
  id: 'OLD',
  phone: '+33612345678',
  email: null,
  externalId: null,
  sourceId: 'meta',
  fullName: 'Jean Dupont',
  addressLine: '',
  postalCode: null,
  status: 'interested',
  ownerId: 'sarah',
  managerIds: ['mgr'],
  ...over,
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  nowMs: NOW,
  leadId: 'LEAD-1',
  rawLeadId: 'RAW-1',
  sourceId: 'meta',
  channel: 'webhook',
  mapped: mapPayload({ fullName: 'Jean Dupont', phone: '06 12 34 56 78', email: 'jean@x.fr', postalCode: '69003', zone: 'idf', product: 'pac_air_eau' }),
  campaign,
  unresolvedCampaignRef: null,
  existing: [],
  candidates: [cand('sarah', { activeLoad: 4, newLeads: 4 }), cand('mehdi', { activeLoad: 8, newLeads: 8 })],
  profileInfo: { sarah: { managerIds: ['mgr'], primaryTeamId: 'pac' }, mehdi: { managerIds: ['mgr'], primaryTeamId: 'pac' } },
  campaignManagerIds: ['mgr', 'mgr2'],
  config: DEFAULT_ASSIGNMENT_CONFIG,
  ...over,
});

const created = (p: ReturnType<typeof planIngestion>) => {
  if (p.kind !== 'created') throw new Error(`plan attendu « created », reçu « ${p.kind} »`);
  return p;
};

describe('lead valide → créé et attribué', () => {
  const p = created(planIngestion(input()));

  it('attribué au télépro à la charge la plus faible (fig. 17 : Sarah 4/10)', () => {
    expect(p.lead.ownerId).toBe('sarah');
    expect(p.lead.assignmentState).toBe('assigned');
    expect(p.lead.bufferReason).toBeNull();
    expect(p.decision?.chosenUid).toBe('sarah');
  });

  it('statut Nouveau, SLA démarré à la réception, première alerte à +1 min (§5.1)', () => {
    expect(p.lead.status).toBe('new');
    expect(p.lead.sla.startedAt.getTime()).toBe(NOW);
    expect(p.lead.sla.stoppedAt).toBeNull();
    expect(p.lead.sla.nextAlertAt?.getTime()).toBe(NOW + 60_000);
  });

  it('prochaine action obligatoire (RG02) et action dans la file du propriétaire', () => {
    expect(p.lead.nextAction).toMatchObject({ type: 'take_new_lead', priority: 'P1' });
    expect(p.action).toMatchObject({ leadId: 'LEAD-1', ownerId: 'sarah', state: 'open', dedupeKey: 'LEAD-1:take_new_lead' });
    expect(p.lead.nextAction?.actionId).toBe(p.action?.id);
  });

  it('données normalisées + origine conservée, jamais réécrite', () => {
    expect(p.lead.phone).toBe('+33612345678');
    expect(p.lead.email).toBe('jean@x.fr');
    expect(p.lead.origin).toMatchObject({ sourceId: 'meta', campaignId: 'camp1', rawLeadId: 'RAW-1' });
    expect(p.lead.origin.receivedAt.getTime()).toBe(NOW);
  });

  it('managers visibles = ceux du propriétaire (périmètre des règles Firestore)', () => {
    expect(p.lead.managerIds).toEqual(['mgr']);
    expect(p.lead.teamId).toBe('pac');
    expect(p.action?.managerIds).toEqual(['mgr']);
  });

  it('historique : création puis attribution, acteur système puis moteur', () => {
    expect(p.events.map((e) => [e.type, e.actorId])).toEqual([['created', 'system'], ['assigned', 'engine']]);
    expect(p.events[1]).toMatchObject({ before: { ownerId: null }, after: { ownerId: 'sarah' }, reason: 'lowest_active_load' });
  });

  it('journal de distribution : tous les candidats évalués, avec les charges figées (fig. 19)', () => {
    expect(p.distribution).toMatchObject({ event: 'assign', mode: 'real', chosenOwnerId: 'sarah', actorId: 'engine', leadId: 'LEAD-1' });
    expect(p.distribution.candidates).toEqual([
      expect.objectContaining({ uid: 'sarah', eligible: true, activeLoad: 4, newLeads: 4 }),
      expect.objectContaining({ uid: 'mehdi', eligible: true, activeLoad: 8, newLeads: 8 }),
    ]);
  });

  it('notification sonore au propriétaire uniquement', () => {
    expect(p.notifications).toHaveLength(1);
    expect(p.notifications[0]).toMatchObject({ recipientIds: ['sarah'], sound: 'new_lead', leadId: 'LEAD-1' });
  });

  it('compteur du propriétaire incrémenté et date de dernière attribution mise à jour', () => {
    expect(p.counterUpdates).toEqual([{ uid: 'sarah', newLeadsDelta: 1, lastAssignedAtMs: NOW }]);
  });

  it('clés d\'idempotence : téléphone et email (bloquent un doublon simultané)', () => {
    expect(p.idempotencyKeys).toEqual(['phone_+33612345678', 'email_jean@x.fr']);
  });
});

describe('aucun télépro éligible → file tampon, jamais perdu (§24.4)', () => {
  const p = created(planIngestion(input({ candidates: [cand('sarah', { newLeads: 10 }), cand('mehdi', { newLeads: 10 })] })));

  it('lead conservé, sans propriétaire, état explicite « buffer » (RG01) avec son motif', () => {
    expect(p.lead.ownerId).toBeNull();
    expect(p.lead.assignmentState).toBe('buffer');
    expect(p.lead.bufferReason).toBe('capacity_reached');
    expect(p.lead.nextAction).toBeNull();
    expect(p.action).toBeNull();
    expect(p.counterUpdates).toEqual([]);
  });

  it('le SLA court quand même (RG03) mais aucune alerte sonore n\'est programmée chez un télépro', () => {
    expect(p.lead.sla.startedAt.getTime()).toBe(NOW);
    expect(p.lead.sla.nextAlertAt).toBeNull();
  });

  it('visible des managers de la campagne, alerte critique', () => {
    expect(p.lead.managerIds).toEqual(['mgr', 'mgr2']);
    expect(p.notifications[0]).toMatchObject({ recipientIds: ['mgr', 'mgr2'], sound: 'critical' });
  });

  it('le journal explique pourquoi : exclusions de chaque candidat', () => {
    expect(p.distribution).toMatchObject({ event: 'buffer', chosenOwnerId: null, reason: 'capacity_reached' });
    expect(p.distribution.candidates.every((c) => !c.eligible && c.exclusions.includes('capacity_reached'))).toBe(true);
  });

  it('aucun candidat du tout : motif no_candidate', () => {
    const none = created(planIngestion(input({ candidates: [] })));
    expect(none.lead.bufferReason).toBe('no_candidate');
    expect(none.lead.assignmentState).toBe('buffer');
  });

  it('aucun manager à prévenir : pas de notification fantôme, mais le lead reste en file', () => {
    const lone = created(planIngestion(input({ candidates: [], campaignManagerIds: [] })));
    expect(lone.notifications).toEqual([]);
    expect(lone.lead.assignmentState).toBe('buffer');
  });
});

describe('campagne non active → le lead est reçu mais attend une décision', () => {
  it.each(['draft', 'suspended', 'ended'] as const)('campagne %s', (status) => {
    const p = created(planIngestion(input({ campaign: { ...campaign, status } })));
    expect(p.lead.assignmentState).toBe('buffer');
    expect(p.lead.bufferReason).toBe('campaign_not_active');
    expect(p.lead.ownerId).toBeNull();
    expect(p.decision).toBeNull();
    expect(p.events[1].note).toContain(status);
  });
});

describe("campagne d'entretien : `product` est l'équipement du client", () => {
  const entretien: CampaignInfo = { ...campaign, id: 'ent1', name: 'Entretien Chaudière — Octobre', productCode: 'entretien' };
  const mappedEntretien = mapPayload({ fullName: 'Paul Martin', phone: '0611223344', zone: 'idf', product: 'Chaudière gaz' });

  it("l'équipement va dans la qualification, comme l'ancien CRM (type de chauffage)", () => {
    const p = created(planIngestion(input({ campaign: entretien, mapped: mappedEntretien })));
    expect(p.lead.qualification).toMatchObject({ currentHeatingType: 'Chaudière gaz' });
  });

  it('il ne sert PAS à choisir le télépro : seul le produit de la campagne compte', () => {
    const p = created(
      planIngestion(
        input({
          campaign: entretien,
          mapped: mappedEntretien,
          candidates: [cand('sarah', { scope: { productCodes: ['entretien'], zones: ['*'] } })],
          profileInfo: { sarah: { managerIds: ['mgr'], primaryTeamId: 'pac' } },
        })
      )
    );
    expect(p.lead.productCode).toBe('entretien');
    expect(p.lead.ownerId).toBe('sarah');
  });

  it('un télépro limité à « Chaudière gaz » ne reçoit pas le lead pour autant', () => {
    const p = created(
      planIngestion(
        input({ campaign: entretien, mapped: mappedEntretien, candidates: [cand('x', { scope: { productCodes: ['Chaudière gaz'], zones: ['*'] } })] })
      )
    );
    expect(p.lead.ownerId).toBeNull();
    expect(p.lead.bufferReason).toBe('product_not_allowed');
  });

  it('détecté aussi quand seul le nom de campagne du payload le dit (campagne non résolue en base)', () => {
    const m = mapPayload({ phone: '0611223344', campaign: 'Campagne ENTRETIEN PAC', product: 'PAC Air/Eau' });
    const p = created(planIngestion(input({ campaign: null, mapped: m })));
    expect(p.lead.productCode).toBeNull();
    expect(p.lead.qualification).toMatchObject({ currentHeatingType: 'PAC Air/Eau' });
  });

  it("un type de chauffage envoyé explicitement n'est pas écrasé", () => {
    const m = mapPayload({ phone: '0611223344', product: 'Chaudière gaz', currentHeatingType: 'fioul' });
    const p = created(planIngestion(input({ campaign: entretien, mapped: m })));
    expect(p.lead.qualification).toMatchObject({ currentHeatingType: 'fioul' });
  });

  it('campagne non entretien : `product` reste le produit (comportement inchangé)', () => {
    const p = created(planIngestion(input()));
    expect(p.lead.productCode).toBe('pac_air_eau');
    expect(p.lead.qualification.currentHeatingType).toBeUndefined();
  });
});

describe('lead sans campagne (import, saisie manuelle)', () => {
  it('attribué sans critère d\'équipe de campagne', () => {
    const p = created(planIngestion(input({ campaign: null, mapped: mapPayload({ phone: '0612345678', zone: 'idf', product: 'ssc' }) })));
    expect(p.lead.ownerId).toBe('sarah');
    expect(p.lead.origin.campaignId).toBeNull();
  });

  it('une référence de campagne introuvable est consignée dans l\'historique', () => {
    const p = created(planIngestion(input({ campaign: null, unresolvedCampaignRef: 'Campagne fantôme' })));
    expect(p.events[0].meta).toMatchObject({ unresolvedCampaignRef: 'Campagne fantôme' });
  });
});

describe('rejet : aucun moyen de contacter la personne', () => {
  it('ni téléphone ni email valides → rejeté, avec les valeurs reçues pour comprendre', () => {
    const p = planIngestion(input({ mapped: mapPayload({ fullName: 'X', phone: '12', email: 'pas-un-mail' }) }));
    expect(p.kind).toBe('rejected');
    if (p.kind === 'rejected') {
      expect(p.code).toBe('no_contact');
      expect(p.reason).toContain('12');
      expect(p.reason).toContain('pas-un-mail');
    }
  });

  it('un seul des deux suffit', () => {
    expect(planIngestion(input({ mapped: mapPayload({ phone: '0612345678' }) })).kind).toBe('created');
    expect(planIngestion(input({ mapped: mapPayload({ email: 'a@b.fr' }) })).kind).toBe('created');
  });
});

describe('doublons (§4.3, §24.3)', () => {
  it('lead déjà ouvert : rien n\'est créé, l\'interaction est rattachée, le propriétaire est prévenu', () => {
    const p = planIngestion(input({ existing: [existingLead()] }));
    expect(p.kind).toBe('attached');
    if (p.kind !== 'attached') return;
    expect(p.targetLeadId).toBe('OLD');
    expect(p.outcome).toBe('attached_to_open_lead');
    expect(p.event).toMatchObject({ type: 'duplicate_interaction', actorId: 'system' });
    expect(p.event.meta).toMatchObject({ rawLeadId: 'RAW-1', campaignId: 'camp1' }); // le nouveau point de contact marketing est mémorisé
    expect(p.notifications[0]).toMatchObject({ recipientIds: ['sarah'], leadId: 'OLD' });
  });

  it('client déjà connu : le manager est prévenu en plus du propriétaire', () => {
    const p = planIngestion(input({ existing: [existingLead({ status: 'converted' })] }));
    expect(p.kind).toBe('attached');
    if (p.kind !== 'attached') return;
    expect(p.outcome).toBe('known_client');
    expect(p.notifications[0].recipientIds.sort()).toEqual(['mgr', 'sarah']);
  });

  it('lead rattaché sans propriétaire : pas de notification (aucun destinataire), mais l\'événement est conservé', () => {
    const p = planIngestion(input({ existing: [existingLead({ ownerId: null })] }));
    expect(p.kind).toBe('attached');
    if (p.kind === 'attached') {
      expect(p.notifications).toEqual([]);
      expect(p.event.type).toBe('duplicate_interaction');
    }
  });

  it('même identifiant externe : rejeu de la source, rien n\'est recréé', () => {
    const p = planIngestion(
      input({
        mapped: mapPayload({ phone: '0612345678', leadgen_id: 'L-1' }),
        existing: [existingLead({ externalId: 'L-1', sourceId: 'meta' })],
      })
    );
    expect(p).toMatchObject({ kind: 'replay', leadId: 'OLD' });
  });

  it('doublon probable : lead créé mais bloqué, jamais attribué automatiquement', () => {
    const p = created(
      planIngestion(
        input({ existing: [existingLead({ status: 'not_interested', ownerId: 'sarah' })] })
      )
    );
    expect(p.lead.ownerId).toBeNull();
    expect(p.lead.assignmentState).toBe('to_assign');
    expect(p.lead.bufferReason).toBe('duplicate_review');
    expect(p.lead.quality).toMatchObject({ duplicateOutcome: 'probable_duplicate', duplicateOf: 'OLD' });
    expect(p.decision).toBeNull();
    expect(p.notifications[0]).toMatchObject({ title: 'Doublon probable à traiter', recipientIds: ['mgr', 'mgr2'] });
  });
});

describe('propriétés générales', () => {
  it('déterministe : mêmes entrées → même plan', () => {
    expect(planIngestion(input())).toEqual(planIngestion(input()));
  });

  it('ne modifie pas ses entrées', () => {
    const i = input();
    const snapshot = JSON.stringify(i);
    planIngestion(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });

  it('chaque lead créé a un propriétaire OU un état explicite (RG01)', () => {
    for (const candidates of [[cand('a')], [], [cand('a', { newLeads: 10 })]]) {
      const p = created(planIngestion(input({ candidates })));
      expect(p.lead.ownerId !== null || ['buffer', 'to_assign'].includes(p.lead.assignmentState)).toBe(true);
      // et jamais les deux à la fois
      if (p.lead.ownerId) expect(p.lead.assignmentState).toBe('assigned');
    }
  });

  it('un lead actif a toujours une prochaine action quand il a un propriétaire (RG02)', () => {
    const p = created(planIngestion(input()));
    expect(p.lead.ownerId && p.lead.nextAction).toBeTruthy();
  });

  it('identifiants d\'événements, de notification et d\'action déterministes : rejouer la transaction écrase au lieu de dupliquer', () => {
    const a = created(planIngestion(input()));
    const b = created(planIngestion(input()));
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(a.notifications.map((n) => n.id)).toEqual(b.notifications.map((n) => n.id));
    expect(a.action?.id).toBe(b.action?.id);
    expect(a.distribution.id).toBe(b.distribution.id);
  });
});

describe('idempotencyKeysFor', () => {
  it('identifiant externe de la source, téléphone, email', () => {
    expect(idempotencyKeysFor({ phone: '+33612345678', email: 'a@b.fr', externalId: 'L-9' }, 'meta')).toEqual([
      'ext_meta_L-9',
      'phone_+33612345678',
      'email_a@b.fr',
    ]);
  });
  it('pas d\'identifiant externe sans source ; champs absents ignorés', () => {
    expect(idempotencyKeysFor({ phone: null, email: 'a@b.fr', externalId: 'L-9' }, null)).toEqual(['email_a@b.fr']);
    expect(idempotencyKeysFor({ phone: null, email: null, externalId: null }, 'meta')).toEqual([]);
  });
  it('un « / » ne peut jamais casser un identifiant de document', () => {
    expect(idempotencyKeysFor({ phone: null, email: null, externalId: 'a/b' }, 'meta')).toEqual(['ext_meta_a_b']);
  });
});

describe('distribution automatique désactivée (fig. 17)', () => {
  it('le lead va en file tampon avec un motif explicite, sans télépro, même si un télépro est éligible', () => {
    const p = created(planIngestion(input({ config: { ...DEFAULT_ASSIGNMENT_CONFIG, autoDistribution: false } })));
    expect(p.lead.ownerId).toBeNull();
    expect(p.lead.assignmentState).toBe('buffer');
    expect(p.lead.bufferReason).toBe('auto_distribution_off');
    expect(p.distribution.event).toBe('buffer');
  });
  it("l'historique du lead donne la vraie raison, pas « aucun télépro éligible »", () => {
    const p = created(planIngestion(input({ config: { ...DEFAULT_ASSIGNMENT_CONFIG, autoDistribution: false } })));
    const held = p.events.find((e) => e.type === 'alert');
    expect(held?.note).toContain('Distribution automatique désactivée');
    expect(held?.note).not.toContain('Aucun télépro éligible');
  });
  it('activée (défaut) : comportement inchangé', () => {
    expect(created(planIngestion(input())).lead.ownerId).not.toBeNull();
  });
});

describe('journal de distribution', () => {
  it('conserve le nom du lead pour l\'affichage sans relire le lead', () => {
    const p = created(planIngestion(input({ mapped: mapPayload({ fullName: 'Jean Dupont', phone: '0612345678' }) })));
    expect(p.distribution.leadName).toBe('Jean Dupont');
  });
  it('lead sans nom : null, jamais une chaîne vide', () => {
    const p = created(planIngestion(input({ mapped: mapPayload({ phone: '0612345678' }) })));
    expect(p.distribution.leadName).toBeNull();
  });
});
