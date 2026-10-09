import { useEffect, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { COL, SUB } from '../../domain/collections';
import type { LeadStatus } from '../../domain/enums';
import { priceOfProduct } from '../../domain/conversion/finance';
import { sanitizeDraft, type MontageDraft } from '../../domain/conversion/montage';
import { noValidation, type StoredValidation } from '../../domain/conversion/plan';
import { ms } from '../../lib/firestoreViews';

/** Ce que le montage lit du lead (un seul abonnement, mis à jour en direct). */
export interface SaleLead {
  status: LeadStatus;
  ownerId: string | null;
  managerIds: string[];
  fullName: string;
  phone: string | null;
  email: string | null;
  address: { line: string; postalCode: string; city: string };
  consent: boolean | null;
  productCode: string | null;
  qualification: Record<string, unknown>;
  docs: { mandatory: number; mandatoryConform: number; withReserve: number };
  /** Axes commercial et financier de la vente (§23.9) et son suivi ; états de départ tant qu'aucune étape n'est enregistrée. */
  commercialState: string;
  financialState: string;
  securedAtMs: number | null;
  /** Étape du dossier dans le CRM principal (retour des statuts). */
  mainStatus: { stage: string; label: string; changedAtMs: number | null } | null;
  saleTrack: { offerSentAtMs: number | null; signedAtMs: number | null; depositCents: number | null; financingOrganism: string | null; reminderCount: number; lastReminderAtMs: number | null };
}

export interface SaleView {
  number: string;
  totalTtcCents: number;
  mprCents: number;
  ceeCents: number;
  discountCents: number;
  remainderCents: number;
  createdAtMs: number | null;
  createdBy: string | null;
  validatedBy: string | null;
  campaignName: string | null;
  productLabel: string;
  clientName: string;
  addressLabel: string;
}

export interface ConversionView {
  state: string;
  clientId: string | null;
  dossierId: string | null;
  attempts: number;
  documentsTransferred: boolean;
  documentsCount: number;
  historyCount: number;
  /** Dernière tentative de transmission. */
  lastAttemptAtMs: number | null;
  linkedExisting: boolean;
  lastError: { code: string; message: string; duplicates: { id: string; clientNumber: string }[] } | null;
}

export interface Article {
  id: string;
  name: string;
  brand: string;
  reference: string;
  unitHtCents: number;
  vatRate: number;
}

export interface SaleData {
  loading: boolean;
  error: boolean;
  lead: SaleLead | null;
  draft: MontageDraft | null;
  validation: StoredValidation;
  sale: SaleView | null;
  conversion: ConversionView | null;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function useSaleData(leadId: string): SaleData {
  const [state, setState] = useState<SaleData>({ loading: true, error: false, lead: null, draft: null, validation: noValidation(), sale: null, conversion: null });

  useEffect(() => {
    setState({ loading: true, error: false, lead: null, draft: null, validation: noValidation(), sale: null, conversion: null });
    const patch = (p: Partial<SaleData>) => setState((s) => ({ ...s, ...p }));
    const fail = () => patch({ loading: false, error: true });

    const unsubs = [
      onSnapshot(
        doc(db, COL.leads, leadId),
        (s) => {
          const d = s.data();
          if (!d) return fail();
          const docs = d.documents ?? {};
          patch({
            loading: false,
            lead: {
              status: str(d.status) as LeadStatus,
              ownerId: typeof d.ownerId === 'string' ? d.ownerId : null,
              managerIds: arr(d.managerIds),
              fullName: str(d.fullName),
              phone: typeof d.phone === 'string' ? d.phone : null,
              email: typeof d.email === 'string' ? d.email : null,
              address: { line: str(d.address?.line), postalCode: str(d.address?.postalCode), city: str(d.address?.city) },
              consent: typeof d.consent === 'boolean' ? d.consent : null,
              productCode: typeof d.productCode === 'string' ? d.productCode : null,
              qualification: d.qualification && typeof d.qualification === 'object' ? (d.qualification as Record<string, unknown>) : {},
              docs: { mandatory: Number(docs.mandatory ?? 0), mandatoryConform: Number(docs.mandatoryConform ?? 0), withReserve: 0 },
              commercialState: str(d.commercialState) || 'none',
              financialState: str(d.financialState) || 'none',
              securedAtMs: ms(d.securedAt),
              mainStatus: d.mainStatus && typeof d.mainStatus.stage === 'string' ? { stage: d.mainStatus.stage, label: str(d.mainStatus.label), changedAtMs: ms(d.mainStatus.changedAt) } : null,
              saleTrack: {
                offerSentAtMs: ms(d.saleTrack?.offerSentAt),
                signedAtMs: ms(d.saleTrack?.signedAt),
                depositCents: typeof d.saleTrack?.depositCents === 'number' ? d.saleTrack.depositCents : null,
                financingOrganism: typeof d.saleTrack?.financingOrganism === 'string' ? d.saleTrack.financingOrganism : null,
                reminderCount: Number(d.saleTrack?.reminderCount ?? 0),
                lastReminderAtMs: ms(d.saleTrack?.lastReminderAt),
              },
            },
          });
        },
        fail
      ),
      onSnapshot(
        doc(db, COL.leads, leadId, SUB.montage, 'draft'),
        (s) => patch({ draft: s.exists() ? sanitizeDraft(s.data()) : null }),
        () => undefined // l'erreur de droits est déjà portée par la lecture du lead
      ),
      onSnapshot(
        doc(db, COL.leads, leadId, SUB.montage, 'validation'),
        (s) => {
          const d = s.data();
          if (!d) return patch({ validation: noValidation() });
          const state = ['pending', 'approved', 'refused', 'correction'].includes(d.state) ? d.state : 'none';
          patch({
            validation: {
              state,
              fingerprint: typeof d.fingerprint === 'string' ? d.fingerprint : null,
              requestedBy: typeof d.requestedBy === 'string' ? d.requestedBy : null,
              requestedAtMs: ms(d.requestedAt),
              message: str(d.message),
              exceptions: Array.isArray(d.exceptions) ? d.exceptions : [],
              decidedBy: typeof d.decidedBy === 'string' ? d.decidedBy : null,
              decidedAtMs: ms(d.decidedAt),
              comment: str(d.comment),
            },
          });
        },
        () => undefined
      ),
      onSnapshot(
        doc(db, COL.sales, leadId),
        (s) => {
          const d = s.data();
          if (!d) return patch({ sale: null });
          const line = Array.isArray(d.lines) && d.lines[0] ? d.lines.map((l: { label?: string }) => l.label).filter(Boolean).join(' + ') : '';
          patch({
            sale: {
              number: str(d.number),
              totalTtcCents: Number(d.totalTtcCents ?? 0),
              mprCents: Number(d.mprCents ?? 0),
              ceeCents: Number(d.ceeCents ?? 0),
              discountCents: Number(d.discountCents ?? 0),
              remainderCents: Number(d.remainderCents ?? 0),
              createdAtMs: ms(d.createdAt),
              createdBy: typeof d.createdBy === 'string' ? d.createdBy : null,
              validatedBy: typeof d.validatedBy === 'string' ? d.validatedBy : null,
              campaignName: typeof d.campaignName === 'string' ? d.campaignName : null,
              productLabel: line || str(d.productCode),
              clientName: str(d.client?.fullName),
              addressLabel: [str(d.client?.addressLine), [str(d.client?.postalCode), str(d.client?.city)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
            },
          });
        },
        () => undefined
      ),
      onSnapshot(
        doc(db, COL.conversions, leadId),
        (s) => {
          const d = s.data();
          patch({
            conversion: d
              ? {
                  state: str(d.state),
                  clientId: typeof d.clientId === 'string' ? d.clientId : null,
                  dossierId: typeof d.dossierId === 'string' ? d.dossierId : null,
                  attempts: Number(d.attempts ?? 0),
                  documentsTransferred: d.documentsTransferred === true,
                  documentsCount: Number(d.documentsCount ?? 0),
                  historyCount: Number(d.historyCount ?? 0),
                  lastAttemptAtMs: ms(d.lastAttemptAt),
                  linkedExisting: d.linkedExisting === true,
                  lastError: d.lastError
                    ? { code: str(d.lastError.code), message: str(d.lastError.message), duplicates: Array.isArray(d.lastError.extra?.duplicates) ? d.lastError.extra.duplicates.map((x: { id?: string; clientNumber?: string }) => ({ id: str(x.id), clientNumber: str(x.clientNumber) })) : [] }
                    : null,
                }
              : null,
          });
        },
        () => undefined
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [leadId]);

  return state;
}

/** Articles du catalogue principal d'une famille de produits. Le catalogue change rarement : une lecture par famille et par session. */
const articleCache = new Map<string, Article[]>();

export function useArticles(productCode: string | null): { loading: boolean; articles: Article[] } {
  const [state, setState] = useState<{ loading: boolean; articles: Article[] }>({ loading: !!productCode && !articleCache.has(productCode), articles: productCode ? (articleCache.get(productCode) ?? []) : [] });

  useEffect(() => {
    if (!productCode) return setState({ loading: false, articles: [] });
    const cached = articleCache.get(productCode);
    if (cached) return setState({ loading: false, articles: cached });
    let cancelled = false;
    setState({ loading: true, articles: [] });
    getDocs(query(collection(db, 'products'), where('category', '==', productCode)))
      .then((s) => {
        const list: Article[] = [];
        for (const d of s.docs) {
          const p = priceOfProduct(d.get('price'));
          if (!p) continue; // un article sans prix exploitable n'est pas proposé
          list.push({ id: d.id, name: str(d.get('name')), brand: str(d.get('brand')), reference: str(d.get('reference')), ...p });
        }
        list.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
        articleCache.set(productCode, list);
        if (!cancelled) setState({ loading: false, articles: list });
      })
      .catch(() => !cancelled && setState({ loading: false, articles: [] }));
    return () => {
      cancelled = true;
    };
  }, [productCode]);

  return state;
}
