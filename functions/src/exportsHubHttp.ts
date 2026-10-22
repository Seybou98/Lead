// Couche HTTP des exports programmés : identité (jeton Firebase), forme de la demande, codes de retour. Historique et
// téléchargement : administrateur et managers (chacun ne voit que ses fichiers) ; exécution manuelle et renvoi : administrateur.
// Indépendante de l'hébergeur et testable seule (exportsHubHttp.test.ts).

import type { Role } from '../../src/domain/enums';
import type { ExportRun } from '../../src/domain/reports/schedule';
import type { DownloadOutcome, RunOutcome } from './exportRunner';

export interface ExportsHttpInput {
  method: string;
  authorization: string | undefined;
  rawBody: string | undefined;
}

export interface ExportsHttpDeps {
  verifyToken: (token: string) => Promise<string>;
  resolveRole: (uid: string) => Promise<Role | null>;
  runs: (role: Role, uid: string) => Promise<ExportRun[]>;
  runNow: (scheduleId: string, uid: string) => Promise<RunOutcome | { ok: false; code: 'not_found'; message: string }>;
  resend: (runId: string) => Promise<{ ok: true; run: ExportRun } | { ok: false; code: 'not_found' | 'invalid'; message: string }>;
  download: (args: { runId: string; scope: string; uid: string; role: Role }) => Promise<DownloadOutcome>;
  log: { warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const strip = (r: ExportRun): ExportRun => ({ ...r, files: r.files.map((f) => ({ ...f, path: '' })) });

/** 200 · 400 demande illisible · 401 non connecté · 403 droits insuffisants · 404 introuvable · 405 · 409 déjà exécuté · 410 supprimé · 422 refus · 500. */
export async function handleExportsHttp(req: ExportsHttpInput, deps: ExportsHttpDeps): Promise<{ status: number; body: unknown }> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const m = /^Bearer\s+(\S+)$/i.exec((req.authorization ?? '').trim());
  if (!m) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  let uid: string;
  try {
    uid = await deps.verifyToken(m[1]);
  } catch {
    deps.log.warn('exports : jeton refusé');
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
  const { action } = b;
  if (action !== 'runs' && action !== 'run' && action !== 'resend' && action !== 'download') return { status: 400, body: { ok: false, error: 'invalid_body' } };
  const id = action === 'run' ? b.scheduleId : b.runId;
  if (action !== 'runs' && (typeof id !== 'string' || !ID.test(id))) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  // Fichier demandé : « all » (complet) ou l'identifiant du manager dont c'est le périmètre.
  if (action === 'download' && b.file !== undefined && (typeof b.file !== 'string' || !ID.test(b.file))) return { status: 400, body: { ok: false, error: 'invalid_body' } };
  const scope = typeof b.file === 'string' ? b.file : 'all';

  try {
    const role = await deps.resolveRole(uid);
    if (role !== 'admin' && role !== 'manager') return { status: 403, body: { ok: false, error: 'forbidden', message: 'Réservé aux administrateurs et aux managers.' } };
    // L'identité vient UNIQUEMENT du jeton : un `uid` placé dans le corps est ignoré.
    if (action === 'runs') return { status: 200, body: { ok: true, runs: (await deps.runs(role, uid)).map(strip) } };
    if (action === 'download') {
      const out = await deps.download({ runId: id as string, scope, uid, role });
      if (out.ok) return { status: 200, body: out };
      return { status: out.code === 'expired' ? 410 : out.code === 'storage' ? 500 : 404, body: { ok: false, error: out.code, message: out.message } };
    }
    if (role !== 'admin') return { status: 403, body: { ok: false, error: 'forbidden', message: 'Réservé à l’administrateur.' } };
    if (action === 'run') {
      const out = await deps.runNow(id as string, uid);
      if (out.ok) return { status: 200, body: { ok: true, run: strip(out.run) } };
      return { status: out.code === 'not_found' ? 404 : out.code === 'exists' ? 409 : 422, body: { ok: false, error: out.code, message: out.message } };
    }
    const out = await deps.resend(id as string);
    if (out.ok) return { status: 200, body: { ok: true, run: strip(out.run) } };
    return { status: out.code === 'not_found' ? 404 : 422, body: { ok: false, error: out.code, message: out.message } };
  } catch (err) {
    deps.log.error('exports : erreur interne', err);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}
