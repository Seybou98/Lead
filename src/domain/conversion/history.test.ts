import { describe, expect, it } from 'vitest';
import { MAX_HISTORY, usefulHistory, type LeadEventLike } from './history';

const ev = (id: string, type: string, atMs: number, over: Partial<LeadEventLike> = {}): LeadEventLike => ({ id, type, atMs, actorId: 'u1', ...over });

describe('historique utile transmis au CRM principal', () => {
  it('raconte la relation commerciale, du plus ancien au plus récent', () => {
    const h = usefulHistory('L1', [
      ev('e3', 'conversion', 3000, { note: 'Vente V-2026-00042 créée' }),
      ev('e1', 'created', 1000),
      ev('e2', 'status_changed', 2000, { before: { status: 'new' }, after: { status: 'interested' } }),
    ]);
    expect(h.map((x) => x.text)).toEqual(['Lead reçu', 'Statut : Nouveau → Intéressé', 'Vente V-2026-00042 créée']);
  });
  it('identifiants déterministes par lead et par événement', () => {
    expect(usefulHistory('L1', [ev('e1', 'created', 1)])[0].id).toBe('cl_ev_L1_e1');
  });
  it('ignore ce qui relève du technique : alertes, brouillons, doublons, notifications', () => {
    const h = usefulHistory('L1', [ev('a', 'alert', 1, { note: 'x' }), ev('b', 'field_corrected', 2, { note: 'Brouillon enregistré' }), ev('c', 'duplicate_interaction', 3, { note: 'x' }), ev('d', 'notification', 4, { note: 'x' }), ev('e', 'created', 5)]);
    expect(h.map((x) => x.id)).toEqual(['cl_ev_L1_e']);
  });
  it('une note vide ou absente n’est pas une entrée', () => {
    expect(usefulHistory('L1', [ev('n', 'note', 1), ev('m', 'note', 2, { note: '  ' }), ev('o', 'document', 3), ev('p', 'note', 4, { note: 'Client très motivé' })]).map((x) => x.text)).toEqual(['Note : Client très motivé']);
  });
  it('réattribution : le motif est conservé', () => {
    expect(usefulHistory('L1', [ev('r', 'reassigned', 1, { reason: 'Propriétaire absent' })])[0].text).toBe('Lead réattribué : Propriétaire absent');
  });
  it('changement de statut avec motif, statut inconnu rendu tel quel', () => {
    expect(usefulHistory('L1', [ev('s', 'status_changed', 1, { before: { status: 'inconnu' }, after: { status: 'converted' }, reason: 'Pièces conformes' })])[0].text).toBe('Statut : inconnu → Converti (Pièces conformes)');
  });
  it(`plafonné aux ${MAX_HISTORY} entrées les plus récentes`, () => {
    const many = Array.from({ length: 80 }, (_, i) => ev(`e${i}`, 'created', i + 1));
    const h = usefulHistory('L1', many);
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0].atMs).toBe(31);
    expect(h[h.length - 1].atMs).toBe(80);
  });
  it('date illisible : ignoré, jamais une date inventée', () => {
    expect(usefulHistory('L1', [ev('x', 'created', Number.NaN)])).toEqual([]);
  });
  it('texte trop long tronqué', () => {
    expect(usefulHistory('L1', [ev('l', 'conversion', 1, { note: 'x'.repeat(900) })])[0].text).toHaveLength(500);
  });
});
