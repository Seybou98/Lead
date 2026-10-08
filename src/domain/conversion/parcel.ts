// Parcelle cadastrale retrouvée automatiquement à partir de l'adresse du projet (§11.4 « parcelle cadastrale »).
//
// Reprise de la logique du CRM principal (src/lib/hooks/useParcelCadastrale.ts et src/utils/parcel.ts), copiée ici
// pour que le CRM Leads se déploie seul : géocodage de l'adresse puis recherche de la parcelle aux coordonnées, avec
// le service public de l'IGN (Géoplateforme, sans clé). Utilisable côté navigateur (montage) et côté serveur
// (transmission), d'où l'injection de `fetch`.

export interface AddressLike {
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface ParcelResult {
  /** Identifiant IGN de la parcelle (commune + section + numéro), tel que le CRM principal le stocke. */
  parcelId: string;
  coordinates: { lon: number; lat: number };
}

const BASE = 'https://data.geopf.fr/geocodage';

/** « 69003000AB0123 » → « 000 / AB / 0123 » (affichage du CRM principal : 9 derniers caractères). */
export function formatParcelCadastrale(value?: string | null): string {
  if (!value) return '';
  const cleaned = String(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (cleaned.length < 9) return cleaned || '';
  const lastNine = cleaned.slice(-9);
  return [lastNine.slice(0, 3), lastNine.slice(3, 5), lastNine.slice(5)].join(' / ');
}

const part = (v?: string | null) => (v ?? '').toString().trim();

/** Requête d'adresse « rue code-postal ville » ; vide si rien n'est renseigné. */
export function buildAddressQuery(a?: AddressLike | null): string {
  if (!a) return '';
  return [part(a.street), part(a.postalCode), part(a.city)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Erreur lisible : l'appelant l'affiche telle quelle (« Adresse introuvable », « Parcelle cadastrale non trouvée »…). */
export class ParcelError extends Error {}

/**
 * Parcelle de l'adresse. Lève ParcelError si l'adresse ou la parcelle est introuvable, ou si le service ne répond pas.
 * `fetchFn` : `fetch` du navigateur ou de Node ; injectable pour les tests.
 */
export async function fetchParcelId(query: string, opts: { signal?: AbortSignal; fetchFn?: FetchLike } = {}): Promise<ParcelResult> {
  const doFetch: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  if (!query.trim()) throw new ParcelError('Adresse incomplète');

  const search = new URL(`${BASE}/search`);
  search.searchParams.set('q', query);
  search.searchParams.set('limit', '1');
  const searchRes = await doFetch(search.toString(), { signal: opts.signal });
  if (!searchRes.ok) throw new ParcelError('Recherche adresse impossible');
  const searchJson = (await searchRes.json()) as { features?: { geometry?: { coordinates?: unknown } }[] };
  const coordinates = searchJson?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) throw new ParcelError('Adresse introuvable');
  const lon = num(coordinates[0]);
  const lat = num(coordinates[1]);
  if (lon === null || lat === null) throw new ParcelError('Coordonnées invalides');

  const reverse = new URL(`${BASE}/reverse`);
  reverse.searchParams.set('lon', String(lon));
  reverse.searchParams.set('lat', String(lat));
  reverse.searchParams.set('index', 'parcel');
  reverse.searchParams.set('limit', '1');
  const reverseRes = await doFetch(reverse.toString(), { signal: opts.signal });
  if (!reverseRes.ok) throw new ParcelError('Recherche de parcelle impossible');
  const reverseJson = (await reverseRes.json()) as { features?: { properties?: { id?: unknown } }[] };
  const parcelId = reverseJson?.features?.[0]?.properties?.id;
  if (!parcelId) throw new ParcelError('Parcelle cadastrale non trouvée');
  return { parcelId: String(parcelId), coordinates: { lon, lat } };
}
