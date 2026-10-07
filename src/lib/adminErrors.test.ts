import { describe, expect, it } from 'vitest';
import { errorMessage, resolveWriteMode } from './adminErrors';
import { AdminRuleError } from '../domain/admin/plans';

describe('errorMessage', () => {
  it('refus métier : le message tel quel', () => {
    expect(errorMessage(new AdminRuleError('failed-precondition', "sarah n'est pas un manager actif."))).toBe("sarah n'est pas un manager actif.");
    expect(errorMessage(new AdminRuleError('invalid-argument', 'Le nom est obligatoire.'))).toBe('Le nom est obligatoire.');
  });
  it('droits refusés par les règles Firestore ou par une fonction : phrase fixe', () => {
    expect(errorMessage({ code: 'permission-denied', message: 'Missing or insufficient permissions.' })).toBe("Vous n'avez pas le droit d'effectuer cette action.");
    expect(errorMessage({ code: 'functions/permission-denied', message: 'x' })).toBe("Vous n'avez pas le droit d'effectuer cette action.");
  });
  it('session expirée', () => {
    expect(errorMessage({ code: 'unauthenticated' })).toBe('Votre session a expiré. Reconnectez-vous.');
    expect(errorMessage({ code: 'functions/unauthenticated' })).toBe('Votre session a expiré. Reconnectez-vous.');
  });
  it('service indisponible', () => {
    expect(errorMessage({ code: 'unavailable', message: 'Failed to get document because the client is offline.' })).toMatch(/indisponible/);
    expect(errorMessage({ code: 'functions/not-found' })).toMatch(/indisponible/);
  });
  it('jamais de message technique : erreur interne, message Firebase brut, objet inconnu', () => {
    const generic = /Une erreur est survenue/;
    expect(errorMessage({ message: 'internal' })).toMatch(generic);
    expect(errorMessage({ message: 'Firebase: Error (auth/network-request-failed).' })).toMatch(generic);
    expect(errorMessage({ message: 'FirebaseError: 9 FAILED_PRECONDITION: The query requires an index.', code: 'failed-precondition' })).toMatch(generic);
    expect(errorMessage(null)).toMatch(generic);
    expect(errorMessage(undefined)).toMatch(generic);
    expect(errorMessage('texte')).toMatch(generic);
    expect(errorMessage({})).toMatch(generic);
  });
});

describe('resolveWriteMode', () => {
  it('direct par défaut ; « functions » uniquement si demandé explicitement', () => {
    expect(resolveWriteMode(undefined)).toBe('direct');
    expect(resolveWriteMode('')).toBe('direct');
    expect(resolveWriteMode('direct')).toBe('direct');
    expect(resolveWriteMode('functions')).toBe('functions');
    expect(resolveWriteMode('FUNCTIONS')).toBe('direct'); // pas de devinette : valeur inconnue = défaut sûr
    expect(resolveWriteMode(true)).toBe('direct');
  });
});
