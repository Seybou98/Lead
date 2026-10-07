// Conversion des documents Firestore (cl_leads et ses événements) en modèles d'affichage.
import type { DocumentData } from 'firebase/firestore';
import type { AssignmentState, DocumentState, LeadStatus, PriorityClass, Temperature } from '../../domain/enums';
import type { LeadListItem } from '../../domain/leads/leadList';
import type { EventInput, LeadFileData } from '../../domain/leads/leadFile';
import { ms } from '../../lib/firestoreViews';

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toNextAction(d: DocumentData): LeadListItem['nextAction'] {
  const a = d.nextAction;
  const dueAtMs = ms(a?.dueAt);
  if (!a || dueAtMs === null) return null;
  return { type: str(a.type), dueAtMs, priority: str(a.priority, 'P4') as PriorityClass, reason: str(a.reason) };
}

/** null si le lead n'a pas de date de réception lisible (jamais d'âge inventé). */
export function toListItem(id: string, d: DocumentData): LeadListItem | null {
  const receivedAtMs = ms(d.origin?.receivedAt);
  if (receivedAtMs === null) return null;
  return {
    id,
    fullName: str(d.fullName),
    phone: typeof d.phone === 'string' ? d.phone : null,
    email: typeof d.email === 'string' ? d.email : null,
    city: str(d.address?.city),
    postalCode: str(d.address?.postalCode),
    campaignId: typeof d.origin?.campaignId === 'string' ? d.origin.campaignId : null,
    productCode: typeof d.productCode === 'string' ? d.productCode : null,
    status: str(d.status, 'new') as LeadStatus,
    temperature: (typeof d.temperature === 'string' ? d.temperature : null) as Temperature | null,
    assignmentState: str(d.assignmentState, 'buffer') as AssignmentState,
    bufferReason: typeof d.bufferReason === 'string' ? d.bufferReason : null,
    ownerId: typeof d.ownerId === 'string' ? d.ownerId : null,
    receivedAtMs,
    slaStartedAtMs: ms(d.sla?.startedAt),
    slaStoppedAtMs: ms(d.sla?.stoppedAt),
    nextAction: toNextAction(d),
    documentsState: str(d.documents?.state, 'none') as DocumentState,
    duplicate: !!d.quality?.duplicateOf,
    excluded: d.quality?.excluded === true,
  };
}

export function toFileData(id: string, d: DocumentData): LeadFileData {
  const docs = d.documents ?? {};
  const note = d.lastNote;
  const noteAt = ms(note?.at);
  return {
    id,
    status: str(d.status, 'new') as LeadStatus,
    productCode: typeof d.productCode === 'string' ? d.productCode : null,
    qualification: d.qualification && typeof d.qualification === 'object' ? (d.qualification as Record<string, unknown>) : {},
    ownerId: typeof d.ownerId === 'string' ? d.ownerId : null,
    bufferReason: typeof d.bufferReason === 'string' ? d.bufferReason : null,
    nextAction: toNextAction(d),
    documents: {
      state: str(docs.state, 'none') as DocumentState,
      expected: num(docs.expected),
      received: num(docs.received),
      conform: num(docs.conform),
      mandatory: num(docs.mandatory),
      mandatoryConform: num(docs.mandatoryConform),
    },
    lastNote: note && noteAt !== null && typeof note.text === 'string' ? { text: note.text, atMs: noteAt, authorId: str(note.authorId) } : null,
  };
}

export function toEventInput(id: string, d: DocumentData): EventInput | null {
  const atMs = ms(d.at);
  if (atMs === null) return null;
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  return {
    id,
    type: str(d.type),
    atMs,
    actorId: str(d.actorId),
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    note: typeof d.note === 'string' ? d.note : undefined,
    before: rec(d.before),
    after: rec(d.after),
    meta: rec(d.meta),
  };
}
