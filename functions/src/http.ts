// Couche HTTP de l'ingestion des leads, commune à la fonction Netlify (principale) et à la fonction
// Firebase (secours). Aucune dépendance à un hébergeur : testable seule (http.test.ts).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IngestResult } from './ingest';

/** Comparaison en temps constant, quelle que soit la longueur des deux valeurs. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** `data[email]=x` → { data: { email: 'x' } } (un niveau, comme les formulaires de Pabbly). */
function formToObject(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const m = /^([^[\]]+)\[([^[\]]+)\]$/.exec(key);
    if (m) {
      const parent = (out[m[1]] && typeof out[m[1]] === 'object' ? out[m[1]] : (out[m[1]] = {})) as Record<string, unknown>;
      parent[m[2]] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type ParsedBody = { ok: true; payload: unknown } | { ok: false };

/**
 * Lit le corps d'une requête : JSON ou formulaire (x-www-form-urlencoded), comme l'ancien webhook.
 * Un corps vide donne un objet vide (le lead sera refusé faute de contact, avec un message clair).
 * Un JSON mal formé est REFUSÉ au lieu d'être pris pour un lead vide : on ne perd pas silencieusement
 * une donnée que la source pourrait renvoyer corrigée.
 */
export function parseIngestBody(contentType: string | undefined, rawBody: string | undefined): ParsedBody {
  const raw = (rawBody ?? '').trim();
  if (raw === '') return { ok: true, payload: {} };
  const ct = (contentType ?? '').toLowerCase();

  const asJson = (): ParsedBody => {
    try {
      return { ok: true, payload: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  };

  if (ct.includes('application/json')) return asJson();
  if (ct.includes('application/x-www-form-urlencoded')) return { ok: true, payload: formToObject(raw) };
  // Type de contenu absent ou inattendu : JSON d'abord, sinon formulaire.
  const json = asJson();
  return json.ok ? json : { ok: true, payload: formToObject(raw) };
}

export interface IngestHttpInput {
  method: string;
  /** Valeur de l'en-tête X-CRM-SECRET. */
  secret: string | undefined;
  sourceId: string | null;
  contentType?: string;
  /** Corps brut (Netlify). */
  rawBody?: string;
  /** Corps déjà lu par l'hébergeur (Firebase/Express) ; prioritaire s'il est fourni. */
  parsedBody?: unknown;
}

export interface IngestHttpDeps {
  /** Secret attendu (variable d'environnement). Vide = fonction mal configurée. */
  expectedSecret: string;
  run: (args: { sourceId: string | null; payload: unknown }) => Promise<IngestResult>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export interface IngestHttpResponse {
  status: number;
  body: unknown;
}

/**
 * Réponses : 200 lead créé / rattaché / déjà reçu · 400 source inconnue ou corps illisible ·
 * 401 secret invalide · 403 source désactivée · 405 mauvaise méthode · 422 aucun moyen de contact ·
 * 500 erreur interne ou fonction mal configurée (la donnée brute est alors conservée si elle a pu
 * être écrite, et la source peut réessayer).
 */
export async function handleIngestHttp(req: IngestHttpInput, deps: IngestHttpDeps): Promise<IngestHttpResponse> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  // Sans secret configuré, on refuse TOUT : jamais d'accès ouvert par oubli de variable d'environnement.
  if (!deps.expectedSecret) {
    deps.log.error('ingestLead : secret non configuré (CL_INGEST_SECRET)');
    return { status: 500, body: { ok: false, error: 'not_configured' } };
  }
  const provided = req.secret ?? '';
  if (!provided || !safeEqual(provided, deps.expectedSecret)) {
    deps.log.warn('ingestLead : secret invalide');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let payload: unknown;
  if (req.parsedBody !== undefined) {
    payload = req.parsedBody;
  } else {
    const parsed = parseIngestBody(req.contentType, req.rawBody);
    if (!parsed.ok) return { status: 400, body: { ok: false, error: 'invalid_body' } };
    payload = parsed.payload;
  }

  try {
    const result = await deps.run({ sourceId: req.sourceId, payload });
    if (result.ok) return { status: 200, body: result };
    const status = result.code === 'unknown_source' ? 400 : result.code === 'source_disabled' ? 403 : 422;
    return { status, body: result };
  } catch (err) {
    deps.log.error('ingestLead : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}

/** Identifiant de source : paramètre `source` de l'URL, sinon en-tête `X-Source-Id`. */
export function resolveSourceId(query: unknown, header: string | undefined): string | null {
  // Un paramètre répété (?source=a&source=b) devient une valeur inconnue, donc refusée plus loin :
  // il ne doit jamais être ignoré, ce qui ferait passer le lead sans source.
  const v = typeof query === 'string' ? query : Array.isArray(query) ? query.join(',') : (header ?? '');
  const t = String(v).trim();
  return t === '' ? null : t;
}
