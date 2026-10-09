import { describe, expect, it } from 'vitest';
import { describeChange, isTerminalStage, MAIN_STAGE_RANK, resolveMainStage, type MainInput } from './mainStatus';

const input = (over: Partial<MainInput> = {}): MainInput => ({ dossierStatus: 'incomplet', hasClient: false, clientStatus: null, subventionStatus: 'incomplet_a_completer', ...over });
const stage = (over: Partial<MainInput>) => resolveMainStage(input(over)).stage;

describe('étape d’un dossier du CRM principal', () => {
  it('dossier créé par la transmission : incomplet', () => expect(stage({})).toBe('dossier_incomplete'));
  it('statut vide ou brouillon : incomplet, jamais inventé plus avancé', () => {
    expect(stage({ dossierStatus: '', subventionStatus: null })).toBe('dossier_incomplete');
    expect(stage({ dossierStatus: 'brouillon' })).toBe('dossier_incomplete');
  });
  it('complément demandé, puis traité = complet', () => {
    expect(stage({ dossierStatus: 'complement_demande' })).toBe('complement_requested');
    expect(stage({ dossierStatus: 'complement_traite' })).toBe('dossier_complete');
  });
  it('complet', () => expect(stage({ dossierStatus: 'complet' })).toBe('dossier_complete'));
  it('validé : par le statut du dossier OU le contrôle administratif de la subvention', () => {
    expect(stage({ dossierStatus: 'valide' })).toBe('dossier_validated');
    expect(stage({ dossierStatus: 'incomplet', subventionStatus: 'controle_admin_valider' })).toBe('dossier_validated');
    expect(stage({ dossierStatus: 'complet', subventionStatus: 'Contrôle admin valider' })).toBe('dossier_validated');
  });
  it('client créé : à programmer (statut vide, aprogrammer ou ancien « active »)', () => {
    for (const c of ['', null, 'aprogrammer', 'active', 'upcoming']) expect(stage({ dossierStatus: 'valide', hasClient: true, clientStatus: c })).toBe('client_created');
  });
  it('chantier : planifié, en cours, terminé', () => {
    for (const c of ['placer', 'confirmer', 'preparer', 'charger', 'adecaler']) expect(stage({ hasClient: true, clientStatus: c })).toBe('scheduled');
    for (const c of ['encours', 'commencer']) expect(stage({ hasClient: true, clientStatus: c })).toBe('in_progress');
    expect(stage({ hasClient: true, clientStatus: 'terminer' })).toBe('installed');
  });
  it('facturé : MPR, CEE ou les deux', () => {
    for (const c of ['facturer_mpr', 'facturer_cee', 'facturer_cee_mpr']) expect(stage({ hasClient: true, clientStatus: c })).toBe('invoiced');
  });
  it('annulé : annuler, infaisable, dossier abandonné — prioritaire sur tout', () => {
    expect(stage({ hasClient: true, clientStatus: 'annuler' })).toBe('cancelled');
    expect(stage({ hasClient: true, clientStatus: 'infaisable' })).toBe('cancelled');
    expect(stage({ dossierStatus: 'abandonner' })).toBe('cancelled');
    expect(stage({ dossierStatus: 'abandonner', hasClient: true, clientStatus: 'terminer' })).toBe('cancelled');
  });
  it('un statut de chantier est ignoré tant que le dossier n’est pas devenu client', () => {
    expect(stage({ hasClient: false, clientStatus: 'terminer', dossierStatus: 'complet' })).toBe('dossier_complete');
  });
  it('valeur inconnue : « unknown », jamais une étape devinée', () => {
    expect(stage({ hasClient: true, clientStatus: 'sav' })).toBe('unknown');
    expect(stage({ hasClient: true, clientStatus: { x: 1 } })).toBe('unknown');
    expect(stage({ dossierStatus: 'zzz', subventionStatus: null })).toBe('unknown');
  });
  it('accents, casse et espaces ignorés', () => {
    expect(stage({ dossierStatus: ' Validé ' })).toBe('dossier_validated');
    expect(stage({ hasClient: true, clientStatus: ' APROGRAMMER ' })).toBe('client_created');
  });
  it('conserve les valeurs lues et le libellé', () => {
    const r = resolveMainStage(input({ dossierStatus: 'Complet', subventionStatus: 'deposer' }));
    expect(r).toMatchObject({ stage: 'dossier_complete', label: 'Dossier complet', raw: { dossier: 'complet', client: '', subvention: 'deposer' } });
  });
});

describe('étapes finales et rang', () => {
  it('facturé et annulé sont finaux', () => {
    expect(isTerminalStage('invoiced')).toBe(true);
    expect(isTerminalStage('cancelled')).toBe(true);
    expect(isTerminalStage('installed')).toBe(false);
  });
  it('les rangs croissent le long du parcours', () => {
    const order = ['dossier_incomplete', 'complement_requested', 'dossier_complete', 'dossier_validated', 'client_created', 'scheduled', 'in_progress', 'installed', 'invoiced'] as const;
    order.slice(1).forEach((s, i) => expect(MAIN_STAGE_RANK[s]).toBeGreaterThan(MAIN_STAGE_RANK[order[i]]));
  });
});

describe('ce qu’un changement déclenche (§24.8)', () => {
  it('dossier validé : conversion confirmée, notification, jalon', () => {
    const c = describeChange('dossier_complete', 'dossier_validated', 'Jean Dupont');
    expect(c).toMatchObject({ milestone: 'validated', cancelsSale: false, note: 'CRM principal : Dossier complet → Dossier validé' });
    expect(c.notify?.title).toBe('Dossier validé');
  });
  it('annulation : retrait des ventes nettes, signal critique', () => {
    const c = describeChange('client_created', 'cancelled', 'Jean Dupont');
    expect(c.cancelsSale).toBe(true);
    expect(c.notify).toMatchObject({ title: 'Dossier annulé dans le CRM principal', sound: 'critical' });
  });
  it('installé et facturé : jalons sans notification', () => {
    expect(describeChange('in_progress', 'installed', 'x')).toMatchObject({ milestone: 'installed', notify: null });
    expect(describeChange('installed', 'invoiced', 'x')).toMatchObject({ milestone: 'invoiced', notify: null });
  });
  it('première lecture « incomplet » : personne n’est prévenu ; un recul ou un complément demandé : si', () => {
    expect(describeChange(null, 'dossier_incomplete', 'x').notify).toBeNull();
    expect(describeChange('dossier_validated', 'dossier_incomplete', 'x').notify?.title).toBe('Dossier à nouveau incomplet');
    expect(describeChange('dossier_complete', 'complement_requested', 'x').notify?.title).toBe('Complément demandé par le CRM principal');
  });
  it('première lecture : la phrase ne cite pas d’étape précédente', () => {
    expect(describeChange(null, 'client_created', 'x').note).toBe('CRM principal : Client à programmer');
  });
  it('étapes de chantier intermédiaires : historique seulement', () => {
    expect(describeChange('client_created', 'scheduled', 'x')).toMatchObject({ notify: null, milestone: null, cancelsSale: false });
  });
});
