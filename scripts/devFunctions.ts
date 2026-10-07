// Fonctions du site (netlify/functions) servies par le serveur de développement Vite, SANS Netlify CLI.
//
// Pourquoi : `netlify dev` attend parfois très longtemps (téléchargement de l'environnement « Edge Functions »,
// inutile ici) et son serveur 8888 ne répond pas pendant ce temps. Avec ce plugin, `npm run dev` suffit : les
// appels `/api/qualify-call` et `/api/leads` exécutent exactement les mêmes fonctions que sur Netlify.
//
// Uniquement en développement (`vite serve`) : rien de ce fichier n'est embarqué dans le site construit.

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';

/** Même table que les redirections de netlify.toml. */
const ROUTES: Record<string, string> = {
  '/api/qualify-call': 'qualify-call',
  '/api/leads': 'ingest-lead',
  '/api/set-status': 'set-status',
};

interface LambdaEvent {
  httpMethod: string;
  headers: Record<string, string>;
  queryStringParameters: Record<string, string> | null;
  body: string | null;
  isBase64Encoded: boolean;
}
type Handler = (event: LambdaEvent) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ko) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        ko(new Error('Corps trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });
}

export function devFunctionsPlugin(): Plugin {
  const root = process.cwd();
  // Dans le projet (et non dans le dossier temporaire) : les paquets externes comme firebase-admin ne se résolvent
  // que depuis un dossier situé sous node_modules du projet.
  const outDir = join(root, 'node_modules', '.cache', 'cl-functions');
  mkdirSync(outDir, { recursive: true });
  let n = 0;

  /** Recompile la fonction à chaque appel (≈ 100 ms) : le code modifié est pris en compte sans redémarrer. */
  async function load(name: string): Promise<Handler> {
    const outfile = join(outDir, `${name}-${++n}.mjs`);
    await build({
      entryPoints: [resolve(root, 'netlify/functions', `${name}.ts`)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
      // Comme `external_node_modules` de netlify.toml : chargés depuis node_modules, pas embarqués.
      packages: 'external',
    });
    const mod = (await import(pathToFileURL(outfile).href)) as { handler: Handler };
    return mod.handler;
  }

  return {
    name: 'cl-dev-functions',
    apply: 'serve',
    configResolved(config) {
      // Vite ne charge dans process.env que les variables VITE_* ; les fonctions lisent aussi CRM_SHARED_SECRET,
      // GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT_JSON_BASE64… du fichier .env.
      const env = loadEnv(config.mode, config.envDir || root, '');
      for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
    },
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const fn = ROUTES[url.pathname];
        if (!fn) return next();

        const send = (status: number, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
          res.writeHead(status, headers);
          res.end(body);
        };
        try {
          const handler = await load(fn);
          const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
          const out = await handler({
            httpMethod: req.method ?? 'GET',
            headers,
            queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : null,
            body: raw === '' ? null : raw,
            isBase64Encoded: false,
          });
          send(out.statusCode, out.body, out.headers);
        } catch (err) {
          server.config.logger.error(`[fonctions] ${fn} : ${(err as Error).message}`);
          send(500, JSON.stringify({ ok: false, error: 'internal' }));
        }
      });
    },
    closeBundle() {
      rmSync(outDir, { recursive: true, force: true });
    },
    buildEnd() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
