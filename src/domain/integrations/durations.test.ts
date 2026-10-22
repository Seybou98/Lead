import { describe, expect, it } from 'vitest';
import { connectorCards, entryFromConversion, entryFromRaw, parseStatusReturn, statusReturnWatch, watchItems, type StatusReturnTrace } from './hub';
import { fmtDuration } from '../../pages/integrations/useJournal';

const NOW = Date.UTC(2026, 9, 22, 10, 0);
const MIN = 60_000;
const raw = (over: Record<string, unknown> = {}) => entryFromRaw({ id: 'r1', receivedAtMs: NOW - 10 * MIN, channel: 'webhook', sourceId: null, payloadJson: '{}', leadId: 'L1', processingState: 'processed', processedAtMs: NOW - 10 * MIN + 840, ...over } as never, NOW);
const trace = (over: Partial<StatusReturnTrace> = {}): StatusReturnTrace => ({ atMs: NOW - MIN, read: 10, changed: 2, cancelled: 0, errorCount: 0, errors: [], durationMs: 1800, ...over });

describe('durée des opérations', () => {
  it('réception : délai entre la réception et la fin du traitement ; inconnu sans fin de traitement', () => {
    expect(raw().durationMs).toBe(840);
    expect(raw({ processedAtMs: null }).durationMs).toBeNull();
    expect(raw({ processedAtMs: NOW - 20 * MIN }).durationMs).toBeNull();
  });
  it('transmission : durée entre la création et la dernière mise à jour, jamais pour une transmission en cours', () => {
    const done = entryFromConversion({ leadId: 'L', state: 'confirmed', attempts: 1, createdAtMs: NOW - 5000, updatedAtMs: NOW - 2000 });
    expect(done.durationMs).toBe(3000);
    expect(entryFromConversion({ leadId: 'L', state: 'pending', attempts: 0, createdAtMs: NOW - 5000, updatedAtMs: NOW }).durationMs).toBeNull();
    expect(entryFromConversion({ leadId: 'L', state: 'failed', attempts: 2, createdAtMs: null, updatedAtMs: NOW }).durationMs).toBeNull();
  });
  it('délai moyen par connecteur, seulement sur les durées connues', () => {
    const cards = connectorCards([raw({ id: 'a', processedAtMs: NOW - 10 * MIN + 1000 }), raw({ id: 'b', processedAtMs: NOW - 10 * MIN + 3000 }), raw({ id: 'c', processedAtMs: null })], NOW, NOW);
    expect(cards.find((c) => c.def.id === 'webhook')?.avgDurationMs).toBe(2000);
    expect(cards.find((c) => c.def.id === 'import')?.avgDurationMs).toBeNull();
  });
  it('affichage : millisecondes, secondes, minutes, tiret', () => {
    expect(fmtDuration(840)).toBe('840 ms');
    expect(fmtDuration(2400)).toBe('2,4 s');
    expect(fmtDuration(180_000)).toBe('3 min');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
  });
});

describe('retour des statuts du CRM principal', () => {
  it('lecture tolérante de la trace', () => {
    expect(parseStatusReturn({ atMs: NOW, read: 5, changed: 1, errors: ['x', 3], errorCount: 1 })).toMatchObject({ read: 5, changed: 1, errorCount: 1, errors: ['x'], durationMs: null });
    expect(parseStatusReturn({ at: { toMillis: () => NOW } })?.atMs).toBe(NOW);
    expect(parseStatusReturn(null)).toBeNull();
    expect(parseStatusReturn({ read: 3 })).toBeNull();
  });
  it('sans erreur : rien à surveiller ; avec erreurs : avertissement, critique à 5 erreurs', () => {
    expect(statusReturnWatch(trace(), NOW, NOW - MIN)).toBeNull();
    expect(statusReturnWatch(trace({ errorCount: 2, errors: ['D3 illisible'] }), NOW, NOW - MIN)).toMatchObject({ level: 'warning', connector: 'crm_main' });
    expect(statusReturnWatch(trace({ errorCount: 5 }), NOW, NOW - MIN)?.level).toBe('critical');
    expect(statusReturnWatch(null, NOW, NOW)).toBeNull();
  });
  it('planificateur arrêté : c’est lui qui est signalé, pas une trace périmée du retour des statuts', () => {
    const w = watchItems([], NOW, NOW - 30 * MIN, trace({ errorCount: 3 }));
    expect(w.map((x) => x.id)).toEqual(['scheduler_stale']);
    expect(watchItems([], NOW, NOW - MIN, trace({ errorCount: 3 })).map((x) => x.id)).toEqual(['status_return']);
  });
});
