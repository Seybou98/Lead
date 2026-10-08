// Test de la file tampon et de la réattribution sur un site déployé, avec des leads jetables « zz_tampon_* ».
//
//   node scripts/test-file-tampon.mjs [--keep] [--base https://crm-leads1.netlify.app]
//
// Ce que fait le script :
//   1. vérifie que le site répond (401 attendu sans jeton, pas 502) ;
//   2. crée 4 leads dans la file tampon (sans propriétaire), de 3 min, 20 min et 25 h d'ancienneté ;
//   3. réattribue un lead à la main comme le ferait le manager (cockpit) ;
//   4. lance le planificateur : alertes manager « lead non attribué » et « anomalie » ;
//   5. donne temporairement un périmètre à un télépro (produit ZZ_TEST, zone ZZ-TAMPON) et relance le planificateur :
//      le moteur doit attribuer les leads encore en attente ;
//   6. remet les profils, la présence et les compteurs en l'état, puis supprime les leads (sauf avec --keep, pour les
//      voir dans le cockpit ; relancer SANS --keep supprime ensuite tout ce qui porte le préfixe zz_tampon_).
//
// Prérequis : la clé du compte de service de la base visée par le site (SERVICE_ACCOUNT, défaut : clé du projet dev) et
// la clé API Web dans Lead/.env (VITE_FIREBASE_API_KEY). Le site doit pointer sur la MÊME base que cette clé.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const KEEP = process.argv.includes('--keep');
const BASE = (arg('--base') ?? 'https://crm-leads1.netlify.app').replace(/\/$/, '');
const KEY_FILE = process.env.SERVICE_ACCOUNT ?? resolve(root, 'service-account.json');
const env = readFileSync(resolve(root, '.env'), 'utf8');
const apiKey = /^VITE_FIREBASE_API_KEY=(.*)$/m.exec(env)?.[1].trim();
if (!apiKey) throw new Error('VITE_FIREBASE_API_KEY introuvable dans Lead/.env');

initializeApp({ credential: cert(JSON.parse(readFileSync(KEY_FILE, 'utf8'))) });
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// Comptes de la base dev (surchargeables : ADMIN_UID, MANAGER_UID, TELEPRO_UID).
const U = {
  admin: process.env.ADMIN_UID ?? '5JfbGHDnDrzvg0fJvfot',
  manager: process.env.MANAGER_UID ?? 'xFxnaMxafzRVLMPKNuIQvb1O0J03',
  telepro: process.env.TELEPRO_UID ?? 'v9532p0VTmHbsSIuqj28',
};
const PREFIX = 'zz_tampon_';
const PRODUCT = 'ZZ_TEST';
const ZONE = 'ZZ-TAMPON';
const MIN = 60_000;
const NOW = Date.now();

const idToken = async (uid) => {
  const custom = await getAuth().createCustomToken(uid);
  const r = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  if (!r.idToken) throw new Error(`Connexion impossible pour ${uid} : ${JSON.stringify(r).slice(0, 200)}`);
  return r.idToken;
};
const tok = {};
for (const k of Object.keys(U)) tok[k] = await idToken(U[k]);

const call = async (path, who, body) => {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* corps vide */ }
  return { status: res.status, body: json };
};

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${name}${detail && !ok ? `  → ${detail}` : ''}`); };
const info = (m) => console.log(`     ${m}`);

// ── Nettoyage des restes d'un passage précédent (--keep) ──
async function purge() {
  const snap = await db.collection('cl_leads').get();
  const mine = snap.docs.filter((d) => d.id.startsWith(PREFIX));
  for (const d of mine) {
    for (const sub of ['events', 'documents']) for (const s of (await d.ref.collection(sub).get()).docs) await s.ref.delete();
    await d.ref.delete();
  }
  for (const col of ['cl_actions', 'cl_notifications', 'cl_audit']) {
    const s = await db.collection(col).get();
    for (const d of s.docs) if (d.id.startsWith(PREFIX) || String(d.get('leadId') ?? d.get('entityId') ?? '').startsWith(PREFIX)) await d.ref.delete();
  }
  return mine.length;
}
const purged = await purge();
if (purged) info(`${purged} lead(s) d'un passage précédent supprimé(s)`);

// ── 1. le site répond ──
const alive = await call('/api/reassign-lead', null, {});
check('le site répond (401 sans jeton, et non 502)', alive.status === 401, `statut ${alive.status}`);
if (alive.status !== 401) { console.log('\nLe site ne répond pas correctement : arrêt.'); process.exit(1); }

// ── Profil du télépro : sauvegarde pour tout remettre ensuite ──
const profRef = db.collection('cl_profiles').doc(U.telepro);
const presRef = db.collection('cl_presence').doc(U.telepro);
const profBefore = (await profRef.get()).data();
const presBefore = await presRef.get();
if (!profBefore) { console.log(`Pas de profil cl_profiles/${U.telepro} : renseigner TELEPRO_UID.`); process.exit(1); }
const managerIds = profBefore.managerIds?.length ? profBefore.managerIds : [U.manager];

// ── 2. leads dans la file tampon ──
const mk = (suffix, ageMin, name) => {
  const id = PREFIX + suffix + NOW;
  return {
    id,
    data: {
      id, fullName: name, phone: '+33699990002', email: null,
      address: { line: '', postalCode: '97400', city: 'Saint-Denis', zone: ZONE },
      origin: { receivedAt: Timestamp.fromMillis(NOW - ageMin * MIN), campaignId: null, sourceId: null },
      productCode: PRODUCT, assignmentState: 'buffer', bufferReason: 'no_capacity', ownerId: null, teamId: null, managerIds,
      reassignCount: 0, status: 'new', temperature: null, nextAction: null,
      sla: { startedAt: Timestamp.fromMillis(NOW - ageMin * MIN), stoppedAt: null, nextAlertAt: null, alertCount: 0, breachedAt: null, pausedMinutes: 0 },
      nr: { attempt: 0, cycle: 1, lastAt: null, nextAt: null },
      documents: { state: 'none', expected: 0, received: 0, conform: 0, mandatory: 0, mandatoryConform: 0, lastRequestAt: null, nextFollowUpAt: null, promisedAt: null },
      quality: { excluded: false }, version: 1, createdAt: Timestamp.fromMillis(NOW - ageMin * MIN), updatedAt: Timestamp.now(),
    },
  };
};
const leads = { manual: mk('a_', 3, 'TAMPON Manuel'), warn: mk('b_', 20, 'TAMPON Vingt minutes'), old: mk('c_', 25 * 60, 'TAMPON Un jour'), engine: mk('d_', 3, 'TAMPON Moteur') };
for (const l of Object.values(leads)) await db.collection('cl_leads').doc(l.id).set(l.data);
check('4 leads créés dans la file tampon', true);
const get = async (l) => (await db.collection('cl_leads').doc(l.id).get()).data();

// ── 3. attribution manuelle par le manager ──
const reason = 'Test file tampon : attribution manuelle';
const re = await call('/api/reassign-lead', 'manager', { leadId: leads.manual.id, targetUid: U.telepro, requestId: `${PREFIX}r${NOW}`, reason });
check('le manager attribue un lead de la file tampon → 200', re.status === 200, `${re.status} ${JSON.stringify(re.body)}`);
if (re.status === 404) info('Lead introuvable côté serveur : le site pointe probablement sur une AUTRE base que la clé utilisée.');
const m = await get(leads.manual);
check('le lead a un propriétaire et n’est plus en file tampon', m.ownerId === U.telepro && m.assignmentState !== 'buffer', `${m.ownerId} / ${m.assignmentState}`);
const evs = await db.collection('cl_leads').doc(leads.manual.id).collection('events').get();
check('événement d’attribution enregistré avec le motif', evs.docs.some((d) => d.get('actorId') === U.manager && d.get('reason') === reason));
const noReason = await call('/api/reassign-lead', 'manager', { leadId: leads.warn.id, targetUid: U.telepro, requestId: `${PREFIX}s${NOW}`, reason: '' });
check('sans motif → 422', noReason.status === 422, String(noReason.status));
const asTelepro = await call('/api/reassign-lead', 'telepro', { leadId: leads.warn.id, targetUid: U.telepro, requestId: `${PREFIX}t${NOW}`, reason: 'non autorisé' });
check('un télépro ne peut pas attribuer → 403', asTelepro.status === 403, String(asTelepro.status));

// ── 4. planificateur : alertes manager sur la file tampon ──
const run1 = await call('/api/scheduler-run', 'admin');
check('planificateur lancé par l’administrateur → 200', run1.status === 200, JSON.stringify(run1.body));
info(`rapport : ${JSON.stringify(run1.body?.report ?? run1.body)}`);
const notif = async (leadId, suffix) => (await db.collection('cl_notifications').get()).docs.filter((d) => d.id.startsWith(`${leadId}_esc_${suffix}`));
const warn = await notif(leads.warn.id, 'buffer_warn');
check('lead non attribué depuis 20 min → alerte aux managers', warn.length > 0);
const anomaly = await notif(leads.old.id, 'buffer_anomaly');
check('lead non attribué depuis 25 h → alerte « anomalie »', anomaly.length > 0);
const young = await notif(leads.engine.id, 'buffer_warn');
check('lead de 3 min : pas d’alerte', young.length === 0);

// ── 5. le moteur attribue tout seul quand une capacité apparaît ──
await profRef.set({ scope: { productCodes: [PRODUCT], zones: [ZONE] }, operationalStatus: 'available', distributionSuspended: false }, { merge: true });
await presRef.set({ connected: true, lastSeenAt: Timestamp.now() }, { merge: true });
const run2 = await call('/api/scheduler-run', 'admin');
check('second passage du planificateur → 200', run2.status === 200, JSON.stringify(run2.body));
info(`rapport : ${JSON.stringify(run2.body?.report ?? run2.body)}`);
const after = await Promise.all([get(leads.warn), get(leads.old), get(leads.engine)]);
const taken = after.filter((d) => d.ownerId === U.telepro).length;
if (taken === 3) check('le moteur attribue les 3 leads en attente au télépro', true);
else if ((run2.body?.report?.stillWaiting ?? 0) > 0 || taken === 0) {
  check('le moteur attribue les leads en attente', false, `${taken}/3 attribués : télépro hors horaires, capacité atteinte, ou distribution automatique désactivée (voir le rapport ci-dessus)`);
} else check('le moteur attribue les leads en attente', false, `${taken}/3 attribués`);

// ── 6. remise en l'état ──
await profRef.set({ scope: profBefore.scope ?? { productCodes: [], zones: [] }, operationalStatus: profBefore.operationalStatus ?? 'available', distributionSuspended: profBefore.distributionSuspended ?? false, load: profBefore.load ?? {}, lastAssignedAt: profBefore.lastAssignedAt ?? null }, { merge: true });
if (presBefore.exists) await presRef.set(presBefore.data()); else await presRef.delete();
if (KEEP) {
  info(`--keep : leads conservés (préfixe ${PREFIX}). Profil et présence remis en l'état. Voir ${BASE}/cockpit`);
} else {
  await purge();
  info('leads de test supprimés, profil et présence remis en l’état');
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} conformes`);
process.exit(ok === results.length ? 0 : 1);
