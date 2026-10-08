import { describe, expect, it } from 'vitest';
import { buildActivity, recentActivity, type ActivityInput } from './activity';

const none: ActivityInput = { slaStoppedAtMs: null, nrLastAtMs: null, nrAttempt: 0, noteAtMs: null, noteText: null, docsRequestedAtMs: null, docsFollowUpAtMs: null, docsReceivedAtMs: null, docsCompletedAtMs: null };

describe('buildActivity', () => {
  it('aucune date : aucune action', () => expect(buildActivity(none)).toEqual([]));
  it('une action par date renseignée, la plus récente d\'abord', () => {
    const a = buildActivity({ ...none, slaStoppedAtMs: 100, nrLastAtMs: 300, nrAttempt: 2, docsRequestedAtMs: 200, docsReceivedAtMs: 500, docsCompletedAtMs: 600, docsFollowUpAtMs: 400 });
    expect(a.map((x) => [x.atMs, x.kind])).toEqual([[600, 'docs_complete'], [500, 'docs_received'], [400, 'docs_followup'], [300, 'nr'], [200, 'docs_requested'], [100, 'taken']]);
    expect(a.find((x) => x.kind === 'nr')!.label).toBe('Pas de réponse (NR2)');
  });
  it('note : texte tronqué ; sans texte ou sans date, ce n\'est pas une action', () => {
    expect(buildActivity({ ...none, noteAtMs: 5, noteText: 'x'.repeat(100) })[0].label).toHaveLength('Note : '.length + 60);
    expect(buildActivity({ ...none, noteAtMs: 5, noteText: 'Client motivé' })[0].label).toBe('Note : Client motivé');
    expect(buildActivity({ ...none, noteAtMs: 5, noteText: null })).toEqual([]);
    expect(buildActivity({ ...none, noteAtMs: null, noteText: 'x' })).toEqual([]);
  });
  it('dates invalides (0, négatives, NaN) ignorées', () => {
    expect(buildActivity({ ...none, slaStoppedAtMs: 0, nrLastAtMs: -5, docsRequestedAtMs: Number.NaN })).toEqual([]);
  });
  it('NR sans numéro : libellé neutre', () => expect(buildActivity({ ...none, nrLastAtMs: 9, nrAttempt: 0 })[0].label).toBe('Pas de réponse'));
});

describe('recentActivity', () => {
  const lead = (name: string, atMs: number[]) => ({ fullName: name, activity: atMs.map((t) => ({ atMs: t, kind: 'taken' as const, label: 'Lead pris en charge' })) });
  it('fusionne plusieurs leads, plus récent d\'abord, limité', () => {
    const r = recentActivity([lead('A', [100, 500]), lead('B', [300]), { fullName: 'C' }], 2);
    expect(r.map((x) => [x.lead.fullName, x.atMs])).toEqual([['A', 500], ['B', 300]]);
  });
  it('aucune activité : liste vide', () => expect(recentActivity([], 5)).toEqual([]));
});
