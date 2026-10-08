// Couche HTTP du workflow documentaire : identité (jeton Firebase), forme de la demande, codes de retour.
// Indépendante de l'hébergeur et testable seule (documentsHttp.test.ts). La décision métier est dans
// src/domain/documents/plan.ts ; l'écriture, dans documents.ts.

import type { Role } from '../../src/domain/enums';
import type { DocumentActionInput } from '../../src/domain/documents/plan';
import type { DocumentsArgs, DocumentsResult } from './documents';

export interface DocumentsHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface DocumentsHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  /** Rôle CRM Leads de l'utilisateur (users/{uid}) ; null = compte inactif ou sans accès. */
  resolveRole: (uid: string) => Promise<Role | null>;
  run: (args: Omit<DocumentsArgs, 'nowMs'>) => Promise<DocumentsResult>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export interface DocumentsHttpResponse {
  status: number;
  body: unknown;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const LEAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const KINDS = ['receive', 'check', 'reask', 'follow_up', 'decide', 'start_building'] as const;

const STATUS_BY_CODE: Record<Extract<DocumentsResult, { ok: false }>['code'], number> = {
  not_found: 404,
  forbidden: 403,
  lead_closed: 409,
  unavailable: 409,
  invalid: 422,
};

/**
 * 200 enregistré (ou déjà enregistré : rejeu) · 400 demande illisible · 401 non connecté · 403 sans droit ·
 * 404 lead introuvable · 405 mauvaise méthode · 409 lead clôturé ou dossier indisponible · 422 saisie refusée ·
 * 500 erreur interne.
 */
export async function handleDocumentsHttp(req: DocumentsHttpInput, deps: DocumentsHttpDeps): Promise<DocumentsHttpResponse> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('documents : jeton refusé');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody ?? '');
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  const { leadId, requestId, input } = b;
  const inputObj = input as Record<string, unknown> | null;
  if (
    typeof leadId !== 'string' || !LEAD_ID.test(leadId) ||
    typeof requestId !== 'string' || !REQUEST_ID.test(requestId) ||
    !inputObj || typeof inputObj !== 'object' || Array.isArray(inputObj) ||
    typeof inputObj.kind !== 'string' || !(KINDS as readonly string[]).includes(inputObj.kind)
  ) {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }

  try {
    const role = await deps.resolveRole(uid);
    if (!role) return { status: 403, body: { ok: false, error: 'forbidden', message: "Votre compte n'a pas accès au CRM Leads." } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` ou un `role` placé dans le corps est ignoré.
    const result = await deps.run({ uid, role, leadId, requestId, input: inputObj as unknown as DocumentActionInput });
    if (result.ok) return { status: 200, body: result };
    return { status: STATUS_BY_CODE[result.code], body: { ok: false, error: result.code, message: result.message } };
  } catch (err) {
    deps.log.error('documents : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
