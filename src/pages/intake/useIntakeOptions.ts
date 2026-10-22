import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { useProductCatalog } from '../products/useProductCatalog';

export interface IntakeOptions {
  loading: boolean;
  error: boolean;
  sources: { id: string; name: string; enabled: boolean }[];
  campaigns: { id: string; name: string; status: string }[];
  products: string[];
}

/** Sources, campagnes et familles de produits proposées à l'import et à la saisie manuelle (managers et administrateurs). */
export function useIntakeOptions(): IntakeOptions {
  const catalog = useProductCatalog();
  const [state, setState] = useState<Omit<IntakeOptions, 'products'>>({ loading: true, error: false, sources: [], campaigns: [] });
  useEffect(() => {
    let cancelled = false;
    Promise.all([getDocs(collection(db, COL.sources)), getDocs(collection(db, COL.campaigns))])
      .then(([s, c]) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: false,
          sources: s.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), enabled: d.get('enabled') !== false })).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
          campaigns: c.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), status: String(d.get('status') ?? 'draft') })).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        });
      })
      .catch(() => !cancelled && setState({ loading: false, error: true, sources: [], campaigns: [] }));
    return () => {
      cancelled = true;
    };
  }, []);
  return { ...state, loading: state.loading || catalog.loading, products: catalog.categories.map((c) => c.code) };
}
