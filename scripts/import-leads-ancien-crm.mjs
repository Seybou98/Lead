// Reprend quelques leads RÉELS de l'ancien CRM (collection « leads ») dans le nouveau CRM, pour les tester.
// L'ancien CRM n'est lu qu'en LECTURE : rien n'y est modifié. Chaque lead est envoyé au nouveau site par son adresse
// publique /api/leads (avec le secret), donc il suit exactement le même chemin qu'un lead de Pabbly.
//
//   node scripts/import-leads-ancien-crm.mjs --dry-run                    # liste seulement, n'envoie rien
//   node scripts/import-leads-ancien-crm.mjs --limit 10                   # les 10 plus récents
//   node scripts/import-leads-ancien-crm.mjs --limit 20 --campaign meta   # filtrer par nom de campagne (contient)
//   node scripts/import-leads-ancien-crm.mjs --since 2026-10-01 --limit 30
//   options : --base <url du nouveau site>  (défaut https://crm-leads1.netlify.app)
//
// Variables d'environnement :
//   SOURCE_SERVICE_ACCOUNT  clé du compte de service de la base de l'ANCIEN CRM (défaut : clé du projet dev : Lead/service-account.json, dont la
//                           collection « leads » est lue). Pour la production : une clé en lecture seule.
//   INGEST_SECRET           secret de réception du nouveau site (défaut : CRM_SHARED_SECRET de Lead/.env)
//
// Idempotent : l'identifiant du lead de l'ancien CRM sert d'externalId (« ancien_<id> »). Relancer ne crée pas de
// doublon. Les données sont celles de vrais clients : à utiliser sur la base de test uniquement.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes('--dry-run');
const LIMIT = Math.max(1, Math.min(200, Number(arg('--limit') ?? 10)));
const CAMPAIGN = (arg('--campaign') ?? '').toLowerCase();
const SINCE = arg('--since') ? new Date(arg('--since')) : null;
const BASE = (arg('--base') ?? 'https://crm-leads1.netlify.app').replace(/\/$/, '');
const KEY_FILE = process.env.SOURCE_SERVICE_ACCOUNT ?? resolve(root, 'service-account.json');
const envFile = readFileSync(resolve(root, '.env'), 'utf8');
const SECRET = process.env.INGEST_SECRET ?? /^CRM_SHARED_SECRET=(.*)$/m.exec(envFile)?.[1].trim();
if (!DRY && !SECRET) throw new Error('Secret de réception introuvable : définir INGEST_SECRET.');
if (SINCE && Number.isNaN(SINCE.getTime())) throw new Error('--since doit être une date (AAAA-MM-JJ).');

const svc = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
initializeApp({ credential: cert(svc) });
const db = getFirestore();
console.log(`Ancien CRM lu en lecture seule : projet ${svc.project_id}${DRY ? '  (simulation : rien n’est envoyé)' : `  → envoi vers ${BASE}`}\n`);

const toMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : null);
const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const mask = (s, keep = 3) => (s.length <= keep ? '***' : s.slice(0, keep) + '*'.repeat(Math.max(2, s.length - keep)));
const useful = (v) => { const t = text(v); return t !== '' && t !== 'non_renseigne' && t !== 'a_creer'; };

// Les leads les plus récents d'abord ; filtrés ensuite par campagne / date (pas d'index composite à créer).
let query = db.collection('leads').orderBy('createdAt', 'desc');
if (SINCE) query = query.where('createdAt', '>=', SINCE);
const snap = await query.limit(CAMPAIGN ? 500 : LIMIT).get();
let docs = snap.docs;
if (CAMPAIGN) docs = docs.filter((d) => text(d.get('campaign')).toLowerCase().includes(CAMPAIGN));
docs = docs.slice(0, LIMIT);

if (docs.length === 0) { console.log('Aucun lead trouvé avec ces critères.'); process.exit(0); }

// Résumé des campagnes rencontrées
const byCampaign = new Map();
for (const d of snap.docs) { const c = text(d.get('campaign')) || '(sans campagne)'; byCampaign.set(c, (byCampaign.get(c) ?? 0) + 1); }
console.log('Campagnes parmi les leads lus :');
for (const [c, n] of [...byCampaign.entries()].sort((a, b) => b[1] - a[1])) console.log(`  - ${c} : ${n}`);
console.log('');

const QUALIF = ['isHomeOwner', 'ownerType', 'currentHeatingType', 'heatingMode', 'hotWaterMode', 'houseSurface', 'constructionYear', 'electricalTension', 'numberOfPersons', 'rfr', 'anneeRevenu', 'numeroFiscal', 'montantFacturesEnergetiques'];

let created = 0, linked = 0, rejected = 0, failed = 0;
for (const d of docs) {
  const o = d.data();
  const payload = {
    externalId: `ancien_${d.id}`,
    fullName: text(o.fullName),
    email: text(o.email),
    phone: text(o.phone),
    postalCode: text(o.postalCode),
    address: text(o.workAddress),
    campaign: text(o.campaign),
    product: text(o.product),
  };
  for (const k of QUALIF) if (useful(o[k]) && !(typeof o[k] === 'number' && o[k] === 0)) payload[k] = o[k];
  const when = toMs(o.createdAt) ? new Date(toMs(o.createdAt)).toISOString().slice(0, 16).replace('T', ' ') : '?';
  const label = `${when}  ${mask(payload.fullName || '(sans nom)', 2).padEnd(14)} ${mask(payload.phone || payload.email, 4).padEnd(14)} ${payload.postalCode || '-'}  ${payload.campaign || '-'} / ${payload.product || '-'}`;

  if (DRY) { console.log(`  ${label}`); continue; }
  try {
    const res = await fetch(`${BASE}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM-SECRET': SECRET }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || body.ok === false) { rejected += 1; console.log(`REFUSÉ  ${label}\n        → ${res.status} ${JSON.stringify(body).slice(0, 160)}`); continue; }
    if (body.kind === 'created') created += 1; else linked += 1;
    console.log(`${body.kind === 'created' ? 'CRÉÉ  ' : String(body.kind).toUpperCase().padEnd(6)}  ${label}  → ${body.assignmentState ?? ''}${body.bufferReason ? ` (${body.bufferReason})` : ''}`);
  } catch (e) { failed += 1; console.log(`ERREUR  ${label}  → ${e.message}`); }
}

if (!DRY) {
  console.log(`\n${created} créé(s) · ${linked} rattaché(s)/déjà reçu(s) · ${rejected} refusé(s) · ${failed} erreur(s)`);
  console.log(`À voir dans ${BASE}/leads et ${BASE}/cockpit`);
  process.exit(rejected + failed ? 1 : 0);
}
console.log(`\n${docs.length} lead(s) correspondent. Relancer sans --dry-run pour les envoyer.`);
