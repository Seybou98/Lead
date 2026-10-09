import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL, SUB } from '../../domain/collections';
import type { DocumentKoReason, DocumentStatus } from '../../domain/enums';
import { ms } from '../../lib/firestoreViews';

/** Une pièce de la checklist d'un lead, telle qu'affichée (cl_leads/{id}/documents/{code}). */
export interface PieceView {
  code: string;
  label: string | null;
  mandatory: boolean;
  status: DocumentStatus;
  koReason: DocumentKoReason | null;
  koReasonLabel: string | null;
  koComment: string | null;
  file: { storagePath: string; originalName: string; sizeBytes: number } | null;
  receivedAtMs: number | null;
  channel: string | null;
}

export interface LeadPieces {
  loading: boolean;
  error: boolean;
  pieces: PieceView[];
}

export function useLeadPieces(leadId: string): LeadPieces {
  const [pieces, setPieces] = useState<PieceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    return onSnapshot(
      collection(db, COL.leads, leadId, SUB.documents),
      (s) => {
        setPieces(
          s.docs.map((d) => {
            const f = d.get('file') as { storagePath?: string; originalName?: string; sizeBytes?: number } | null;
            return {
              code: String(d.get('typeCode') ?? d.id),
              label: (d.get('label') ?? null) as string | null,
              mandatory: d.get('mandatory') === true,
              status: (d.get('status') ?? 'expected') as DocumentStatus,
              koReason: (d.get('koReason') ?? null) as DocumentKoReason | null,
              koReasonLabel: (d.get('koReasonLabel') ?? null) as string | null,
              koComment: (d.get('koComment') ?? null) as string | null,
              file: f && f.storagePath ? { storagePath: f.storagePath, originalName: f.originalName ?? 'Fichier', sizeBytes: Number(f.sizeBytes ?? 0) } : null,
              receivedAtMs: ms(d.get('receivedAt')),
              channel: (d.get('channel') ?? null) as string | null,
            };
          })
        );
        setLoading(false);
      },
      () => {
        setError(true);
        setLoading(false);
      }
    );
  }, [leadId]);

  return { loading, error, pieces };
}
