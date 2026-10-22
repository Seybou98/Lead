import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL } from '../../domain/collections';
import { qualificationKey } from '../../domain/admin/plans';
import { normalizeForm, type QualificationForm } from '../../domain/qualification/form';
import { ms } from '../../lib/firestoreViews';

export interface QualificationDoc {
  loading: boolean;
  error: boolean;
  key: string;
  draft: QualificationForm | null;
  published: QualificationForm | null;
  /** Nombre de publications : 0 = jamais publié. */
  version: number;
  publishedAtMs: number | null;
  publishedBy: string | null;
  updatedAtMs: number | null;
}

const EMPTY = (key: string, loading = true): QualificationDoc => ({ loading, error: false, key, draft: null, published: null, version: 0, publishedAtMs: null, publishedBy: null, updatedAtMs: null });

const form = (v: unknown): QualificationForm | null => (v && typeof v === 'object' ? normalizeForm(v) : null);

/** Formulaire de qualification d'une famille de produit (brouillon et version publiée), en temps réel. Administrateur et personnel : lecture. */
export function useQualificationDoc(productCode: string | null): QualificationDoc {
  const key = qualificationKey(productCode);
  const [state, setState] = useState<QualificationDoc>(EMPTY(key));
  useEffect(() => {
    setState(EMPTY(key));
    return onSnapshot(
      doc(db, COL.settings, key),
      (s) =>
        setState({
          loading: false,
          error: false,
          key,
          draft: form(s.get('draft')),
          published: form(s.get('published')),
          version: typeof s.get('version') === 'number' ? (s.get('version') as number) : 0,
          publishedAtMs: ms(s.get('publishedAt')),
          publishedBy: typeof s.get('publishedBy') === 'string' ? (s.get('publishedBy') as string) : null,
          updatedAtMs: ms(s.get('updatedAt')),
        }),
      () => setState({ ...EMPTY(key, false), error: true })
    );
  }, [key]);
  return state;
}

export interface ResolvedQualification {
  loading: boolean;
  form: QualificationForm | null;
  version: number;
  /** D'où vient le formulaire : celui du produit, ou celui « par défaut ». */
  source: 'product' | 'default' | null;
}

/** Formulaire publié qui s'applique à un produit : le sien, sinon le formulaire par défaut, sinon aucun. */
export function usePublishedQualification(productCode: string | null): ResolvedQualification {
  const own = useQualificationDoc(productCode);
  const fallback = useQualificationDoc(null);
  if (own.loading || fallback.loading) return { loading: true, form: null, version: 0, source: null };
  if (productCode && own.published && own.published.fields.length > 0) return { loading: false, form: own.published, version: own.version, source: 'product' };
  if (fallback.published && fallback.published.fields.length > 0) return { loading: false, form: fallback.published, version: fallback.version, source: 'default' };
  return { loading: false, form: null, version: 0, source: null };
}
