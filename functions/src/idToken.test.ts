import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { verifyFirebaseIdToken } from './idToken';

const PROJECT = 'crm-pose-dev';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

let privateKey: KeyLike;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  keys = createLocalJWKSet({ keys: [jwk] });
});

const sign = (claims: Record<string, unknown> = {}, over: { iss?: string; aud?: string; exp?: number; iat?: number; sub?: string | null; alg?: string; kid?: string } = {}) => {
  const jwt = new SignJWT({ auth_time: sec(NOW) - 60, ...claims })
    .setProtectedHeader({ alg: (over.alg ?? 'RS256') as 'RS256', kid: over.kid ?? 'k1' })
    .setIssuer(over.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(over.aud ?? PROJECT)
    .setIssuedAt(over.iat ?? sec(NOW) - 60)
    .setExpirationTime(over.exp ?? sec(NOW) + 3600);
  if (over.sub !== null) jwt.setSubject(over.sub ?? 'uid-123');
  return jwt.sign(privateKey);
};
const verify = (token: string, project = PROJECT) => verifyFirebaseIdToken(token, project, keys, NOW);

describe('verifyFirebaseIdToken', () => {
  it('jeton valide : rend l\'uid', async () => expect(await verify(await sign())).toEqual({ uid: 'uid-123' }));
  it('expiré : refusé', async () => {
    await expect(verify(await sign({}, { exp: sec(NOW) - 10, iat: sec(NOW) - 4000 }))).rejects.toThrow();
  });
  it('autre projet (émetteur ou audience) : refusé', async () => {
    await expect(verify(await sign({}, { iss: 'https://securetoken.google.com/autre' }))).rejects.toThrow();
    await expect(verify(await sign({}, { aud: 'autre' }))).rejects.toThrow();
    await expect(verify(await sign(), 'autre-projet')).rejects.toThrow();
  });
  it('sans sujet : refusé', async () => {
    await expect(verify(await sign({}, { sub: null }))).rejects.toThrow();
  });
  it('signé avec une autre clé : refusé', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(PROJECT).setSubject('pirate').setIssuedAt(sec(NOW)).setExpirationTime(sec(NOW) + 3600).sign(other.privateKey);
    await expect(verify(forged)).rejects.toThrow();
  });
  it('algorithme « none » ou symétrique : refusé', async () => {
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(PROJECT).setSubject('pirate').setExpirationTime(sec(NOW) + 3600).sign(new TextEncoder().encode('secret-secret-secret-secret-secret!'));
    await expect(verify(hs)).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'pirate', exp: sec(NOW) + 3600 })).toString('base64url')}.`;
    await expect(verify(none)).rejects.toThrow();
  });
  it('authentification datée du futur : refusé', async () => {
    await expect(verify(await sign({ auth_time: sec(NOW) + 3 * 3600 }))).rejects.toThrow(/authentification/);
  });
  it('jeton vide, mal formé, démesuré ou projet inconnu : refusé', async () => {
    for (const t of ['', 'abc', 'a.b.c', 'x'.repeat(5000)]) await expect(verify(t)).rejects.toThrow();
    await expect(verify(await sign(), '')).rejects.toThrow(/Projet/);
  });
});
