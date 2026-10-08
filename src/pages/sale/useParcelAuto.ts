import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildAddressQuery, fetchParcelId, type AddressLike, type ParcelResult } from '../../domain/conversion/parcel';

interface State {
  parcelId: string | null;
  loading: boolean;
  error: string | null;
}

/** Une heure, comme le CRM principal : l'adresse d'un dossier ne change pas souvent et le service est public. */
const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { result: ParcelResult; expiresAt: number }>();
/** Pause après la dernière frappe : pas d'appel à chaque lettre de l'adresse. */
const DEBOUNCE_MS = 700;

/**
 * Parcelle cadastrale de l'adresse du projet, retrouvée automatiquement (service public de l'IGN, sans clé).
 * Même comportement que le CRM principal : recherche dès que l'adresse change, résultat gardé en mémoire, relance possible.
 */
export function useParcelAuto(address: AddressLike): State & { query: string; refresh: () => void } {
  const query = useMemo(() => buildAddressQuery(address), [address.street, address.postalCode, address.city]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<State>({ parcelId: null, loading: false, error: null });
  const [token, setToken] = useState(0);
  const refresh = useCallback(() => {
    cache.delete(query);
    setToken((t) => t + 1);
  }, [query]);

  useEffect(() => {
    // Il faut au moins une rue et une ville : sans cela le service répondrait sur une commune entière.
    if (!address.street?.trim() || !address.city?.trim()) return setState({ parcelId: null, loading: false, error: null });
    const hit = cache.get(query);
    if (hit && hit.expiresAt > Date.now()) return setState({ parcelId: hit.result.parcelId, loading: false, error: null });

    let cancelled = false;
    const controller = new AbortController();
    setState({ parcelId: null, loading: true, error: null });
    const timer = setTimeout(() => {
      fetchParcelId(query, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          cache.set(query, { result, expiresAt: Date.now() + TTL_MS });
          setState({ parcelId: result.parcelId, loading: false, error: null });
        })
        .catch((e: unknown) => {
          if (cancelled || (e as { name?: string })?.name === 'AbortError') return;
          setState({ parcelId: null, loading: false, error: e instanceof Error ? e.message : 'Recherche impossible' });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, token]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, query, refresh };
}
