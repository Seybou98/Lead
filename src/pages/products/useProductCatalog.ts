import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { categoriesOf, type ProductCategory } from '../../domain/products/catalog';

export interface ProductCatalog {
  loading: boolean;
  error: boolean;
  categories: ProductCategory[];
}

/** Le catalogue change rarement : une lecture par session, partagée par tous les écrans. */
let cache: ProductCategory[] | null = null;
let inflight: Promise<ProductCategory[]> | null = null;

function load(): Promise<ProductCategory[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= getDocs(collection(db, 'products'))
    .then((s) => {
      cache = categoriesOf(s.docs.map((d) => ({ category: d.get('category'), name: d.get('name') })));
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Familles de produits du catalogue du CRM principal (collection `products`, champ `category`). */
export function useProductCatalog(): ProductCatalog {
  const [state, setState] = useState<ProductCatalog>({ loading: cache === null, error: false, categories: cache ?? [] });
  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    load()
      .then((categories) => !cancelled && setState({ loading: false, error: false, categories }))
      .catch(() => !cancelled && setState({ loading: false, error: true, categories: [] }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
