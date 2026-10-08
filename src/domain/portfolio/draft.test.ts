import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSFER_DRAFT, draftId, parseTransferDraft } from './draft';
import { FAMILIES } from './portfolio';

describe('parseTransferDraft', () => {
  it('rien ou illisible : brouillon par défaut du télépro', () => {
    for (const raw of [undefined, null, 5, 'x', []]) expect(parseTransferDraft(raw, 'u1')).toEqual(DEFAULT_TRANSFER_DRAFT('u1'));
    expect(DEFAULT_TRANSFER_DRAFT('u1').families).toEqual([...FAMILIES]);
  });
  it('un choix complet est restitué à l\'identique', () => {
    const d = { fromUid: 'u1', step: 4, cause: 'Absence longue', reasonOther: '', families: ['callbacks', 'newLeads'], destKind: 'users' as const, destUsers: ['a', 'b'], destTeam: '' };
    expect(parseTransferDraft(d, 'u1')).toEqual({ ...d, families: ['newLeads', 'callbacks'] }); // ordre canonique des familles
  });
  it('valeurs invalides ignorées une par une', () => {
    const p = parseTransferDraft({ step: 9, cause: 'Pirate', families: ['constructor', 'documents'], destKind: 'tous', destUsers: ['ok', '../x', 5, 'ok'], destTeam: '../t' }, 'u1');
    expect(p).toMatchObject({ step: 1, cause: "Changement d'équipe", families: ['documents'], destKind: 'engine', destUsers: ['ok'], destTeam: '' });
  });
  it('le télépro de départ vient toujours du contexte, jamais du contenu enregistré', () => {
    expect(parseTransferDraft({ fromUid: 'autre' }, 'u1').fromUid).toBe('u1');
  });
  it('motif libre tronqué', () => expect(parseTransferDraft({ reasonOther: 'x'.repeat(500) }, 'u1').reasonOther).toHaveLength(200));
  it('identifiant : un brouillon par manager et par télépro', () => {
    expect(draftId('m1', 'u1')).toBe('m1_u1');
    expect(draftId('m1', 'u1')).not.toBe(draftId('m2', 'u1'));
  });
});
