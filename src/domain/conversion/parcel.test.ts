import { describe, expect, it, vi } from 'vitest';
import { buildAddressQuery, fetchParcelId, formatParcelCadastrale, ParcelError } from './parcel';

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

/** Faux service IGN : répond à /search puis /reverse. */
function service(search: unknown, reverse: unknown, over: { searchOk?: boolean; reverseOk?: boolean } = {}) {
  return vi.fn(async (url: string) => (url.includes('/search') ? json(search, over.searchOk ?? true) : json(reverse, over.reverseOk ?? true)));
}
const FOUND = { features: [{ geometry: { coordinates: [4.85, 45.76] } }] };
const PARCEL = { features: [{ properties: { id: '69003000AB0123' } }] };

describe('format de la parcelle (affichage du CRM principal)', () => {
  it('9 derniers caractères en trois blocs', () => expect(formatParcelCadastrale('69003000AB0123')).toBe('000 / AB / 0123'));
  it('ignore la ponctuation et la casse', () => expect(formatParcelCadastrale('690 03-000 ab 0123')).toBe('000 / AB / 0123'));
  it('valeur courte rendue nettoyée, vide si absente', () => {
    expect(formatParcelCadastrale('ab 12')).toBe('AB12');
    expect(formatParcelCadastrale('')).toBe('');
    expect(formatParcelCadastrale(null)).toBe('');
  });
});

describe("requête d'adresse", () => {
  it('rue, code postal, ville, espaces nettoyés', () => expect(buildAddressQuery({ street: ' 15  rue des Lilas ', postalCode: '69003', city: 'Lyon' })).toBe('15 rue des Lilas 69003 Lyon'));
  it('parties absentes ignorées', () => {
    expect(buildAddressQuery({ street: '', postalCode: '69003', city: null })).toBe('69003');
    expect(buildAddressQuery(null)).toBe('');
  });
});

describe('recherche de la parcelle (IGN)', () => {
  it('adresse → coordonnées → parcelle', async () => {
    const fetchFn = service(FOUND, PARCEL);
    const r = await fetchParcelId('15 rue des Lilas 69003 Lyon', { fetchFn });
    expect(r).toEqual({ parcelId: '69003000AB0123', coordinates: { lon: 4.85, lat: 45.76 } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [first, second] = fetchFn.mock.calls.map((c) => new URL(c[0]));
    expect(first.pathname).toBe('/geocodage/search');
    expect(first.searchParams.get('q')).toBe('15 rue des Lilas 69003 Lyon');
    expect(second.pathname).toBe('/geocodage/reverse');
    expect(second.searchParams.get('index')).toBe('parcel');
    expect(second.searchParams.get('lon')).toBe('4.85');
    expect(second.searchParams.get('lat')).toBe('45.76');
  });
  it('adresse vide : refus sans appel réseau', async () => {
    const fetchFn = service(FOUND, PARCEL);
    await expect(fetchParcelId('  ', { fetchFn })).rejects.toThrow('Adresse incomplète');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('adresse introuvable', async () => {
    await expect(fetchParcelId('x', { fetchFn: service({ features: [] }, PARCEL) })).rejects.toThrow('Adresse introuvable');
  });
  it('coordonnées illisibles', async () => {
    await expect(fetchParcelId('x', { fetchFn: service({ features: [{ geometry: { coordinates: ['a', 'b'] } }] }, PARCEL) })).rejects.toThrow('Coordonnées invalides');
  });
  it('aucune parcelle à ces coordonnées', async () => {
    await expect(fetchParcelId('x', { fetchFn: service(FOUND, { features: [] }) })).rejects.toThrow('Parcelle cadastrale non trouvée');
  });
  it('service en panne : message clair, erreur typée', async () => {
    await expect(fetchParcelId('x', { fetchFn: service(FOUND, PARCEL, { searchOk: false }) })).rejects.toBeInstanceOf(ParcelError);
    await expect(fetchParcelId('x', { fetchFn: service(FOUND, PARCEL, { reverseOk: false }) })).rejects.toThrow('Recherche de parcelle impossible');
  });
});
