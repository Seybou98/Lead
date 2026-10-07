#!/usr/bin/env node
// Envoie de FAUX leads à la réception des leads (fonction Netlify ou Firebase) pour tester le CRM Leads.
//
//   node scripts/send-test-leads.mjs --url https://VOTRE-SITE.netlify.app --secret VOTRE_SECRET --count 10
//
// Les leads sont reconnaissables (« Test Lead 001 », emails @example.com, numéros de la plage
// 06 39 98 XX XX réservée à la fiction) : aucun vrai client n'est contacté.
// Aide : node scripts/send-test-leads.mjs --help

const HELP = `
Usage : node scripts/send-test-leads.mjs --url <site> --secret <secret> [options]

Obligatoires
  --url <adresse>       Site Netlify (https://xxx.netlify.app) ou adresse complète de la fonction
  --secret <secret>     Secret X-CRM-SECRET (ou variable d'environnement CL_INGEST_SECRET)

Options
  --count <n>           Nombre de leads (défaut 5, max 500)
  --scenario <nom>      normal : n leads distincts (défaut)
                        mix    : n leads + rejeu, doublon, lead sans contact, mauvais secret,
                                 source inconnue — chaque cas est vérifié (OK / ÉCHEC)
  --campaign <nom>      Nom de la campagne (défaut : "test campagne")
  --zone <zone>         Zone des leads (défaut : ile-de-france)
  --product <produit>   Produit des leads (défaut : PAC AIR AIR)
  --source <id>         Identifiant de source (?source=…), facultatif
  --delay <ms>          Pause entre deux envois (défaut 300)
  --parallel            Envoie tous les leads EN MÊME TEMPS (teste l'arrivée simultanée et le plafond)
  --yes                 Obligatoire au-delà de 50 leads
  --help                Cette aide
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Argument inattendu : ${a}`);
    const key = a.slice(2);
    if (['parallel', 'yes', 'help'].includes(key)) out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`Valeur manquante pour --${key}`);
      out[key] = v;
    }
  }
  return out;
}

const pad = (n, w) => String(n).padStart(w, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIRST = ['Jean', 'Marie', 'Paul', 'Sophie', 'Lucas', 'Emma', 'Hugo', 'Chloé', 'Nathan', 'Léa', 'Louis', 'Inès'];
const LAST = ['Dupont', 'Martin', 'Bernard', 'Petit', 'Moreau', 'Girard', 'Roux', 'Fournier', 'Lambert', 'Mercier'];
const ZIPS = ['75011', '75015', '92100', '93100', '94200', '78000', '91000', '95000'];

function endpoint(url) {
  const u = new URL(url);
  // Adresse de site seule : on ajoute la route publique de réception.
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/leads';
  return u;
}

async function send(base, { secret, source, body, rawBody }) {
  const u = new URL(base);
  if (source) u.searchParams.set('source', source);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret === null ? {} : { 'X-CRM-SECRET': secret }) },
      body: rawBody ?? JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* corps non JSON : affiché tel quel */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.name === 'AbortError' ? 'délai dépassé (20 s)' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

const describe = (r) => {
  if (r.status === 0) return `ERREUR RÉSEAU : ${r.text}`;
  const j = r.json;
  if (!j) return `réponse inattendue : ${r.text.slice(0, 80)}`;
  if (j.ok && j.kind === 'created') return `créé · ${j.assignmentState === 'assigned' ? `attribué à ${j.ownerId}` : `file tampon (${j.bufferReason})`}`;
  if (j.ok) return `${j.kind === 'attached' ? 'rattaché à un lead existant' : 'déjà reçu (rejeu)'}${j.outcome ? ` · ${j.outcome}` : ''}`;
  return `refusé · ${j.error ?? j.code ?? '?'}${j.reason ? ` — ${j.reason.slice(0, 60)}` : ''}`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);

  const secret = args.secret ?? process.env.CL_INGEST_SECRET;
  if (!args.url || !secret) {
    console.error('Il faut --url et --secret (ou la variable CL_INGEST_SECRET). Aide : --help');
    process.exit(2);
  }
  const count = Number(args.count ?? 5);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--count : un entier entre 1 et 500.');
  if (count > 50 && !args.yes) throw new Error(`${count} leads : ajoutez --yes pour confirmer.`);
  const scenario = args.scenario ?? 'normal';
  if (!['normal', 'mix'].includes(scenario)) throw new Error('--scenario : normal ou mix.');

  const base = endpoint(args.url);
  const campaign = args.campaign ?? 'test campagne';
  const zone = args.zone ?? 'ile-de-france';
  const product = args.product ?? 'PAC AIR AIR';
  const delay = Number(args.delay ?? 300);

  // Identifiant de cette série : rend numéros, emails et identifiants externes uniques d'une série à l'autre.
  const run = Math.floor(Date.now() / 1000);
  const phoneBase = run % 10_000;
  const mk = (i) => ({
    fullName: `Test Lead ${pad(i, 3)} ${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
    // Plage 06 39 98 XX XX : réservée à la fiction, aucun vrai abonné.
    phone: `063998${pad((phoneBase + i) % 10_000, 4)}`,
    email: `test.${run}.${i}@example.com`,
    address: `${i + 1} rue des Tests`,
    postalCode: ZIPS[i % ZIPS.length],
    zone,
    product,
    campaign,
    externalId: `TEST-${run}-${i}`,
    isHomeOwner: i % 4 === 0 ? 'non' : 'oui',
    currentHeatingType: ['fioul', 'gaz', 'électrique'][i % 3],
    houseSurface: 80 + ((i * 7) % 90),
  });

  console.log(`\nCible        : ${base.origin}${base.pathname}${args.source ? `  (source ${args.source})` : ''}`);
  console.log(`Série        : ${run} · ${count} lead(s) · scénario « ${scenario} »${args.parallel ? ' · EN PARALLÈLE' : ''}`);
  console.log(`Campagne     : ${campaign} · zone ${zone} · produit ${product}\n`);

  const results = [];
  const leads = Array.from({ length: count }, (_, i) => mk(i + 1));

  const sendLead = async (lead, i) => {
    const r = await send(base, { secret, source: args.source, body: lead });
    results.push({ i, r });
    console.log(`${pad(i, 3)}  ${String(r.status).padEnd(3)}  ${lead.fullName.split(' ').slice(0, 3).join(' ').padEnd(16)}  ${describe(r)}`);
  };

  if (args.parallel) await Promise.all(leads.map((l, k) => sendLead(l, k + 1)));
  else
    for (let k = 0; k < leads.length; k++) {
      await sendLead(leads[k], k + 1);
      if (delay > 0 && k < leads.length - 1) await sleep(delay);
    }

  // ── Bilan des envois ──
  const ok = results.filter((x) => x.r.status === 200 && x.r.json?.ok);
  const created = ok.filter((x) => x.r.json.kind === 'created');
  const byOwner = new Map();
  let buffered = 0;
  for (const x of created) {
    if (x.r.json.assignmentState === 'assigned') byOwner.set(x.r.json.ownerId, (byOwner.get(x.r.json.ownerId) ?? 0) + 1);
    else buffered++;
  }
  console.log('\n── Bilan ──');
  console.log(`Acceptés : ${ok.length}/${count} (créés ${created.length}, rattachés ${ok.filter((x) => x.r.json.kind === 'attached').length}, rejeux ${ok.filter((x) => x.r.json.kind === 'replay').length})`);
  for (const [owner, n] of byOwner) console.log(`  attribués à ${owner} : ${n}`);
  if (buffered) console.log(`  en file tampon : ${buffered}  (aucun télépro éligible : voir l'écran Journal pour le motif)`);
  const failed = results.filter((x) => !(x.r.status === 200 && x.r.json?.ok));
  if (failed.length) console.log(`Refusés ou en erreur : ${failed.length} (voir les lignes ci-dessus)`);

  let allGood = failed.length === 0;

  // ── Scénario « mix » : cas limites vérifiés un par un ──
  if (scenario === 'mix') {
    console.log('\n── Cas limites (chaque ligne est vérifiée) ──');
    const first = leads[0];
    const checks = [
      {
        label: 'Rejeu du lead 1 (même identifiant externe)',
        run: () => send(base, { secret, source: args.source, body: first }),
        // La reconnaissance par identifiant externe n'existe qu'avec une source (?source=…) ; sans source,
        // le lead est reconnu par son téléphone et rattaché. Dans les deux cas : aucun doublon créé.
        expect: (r) => r.status === 200 && (r.json?.kind === 'replay' || (!args.source && r.json?.kind === 'attached')),
        want: args.source ? '200, « déjà reçu » (aucun lead en double)' : '200, rattaché ou déjà reçu (aucun lead en double)',
      },
      {
        label: 'Même téléphone, autre identifiant externe',
        run: () => send(base, { secret, source: args.source, body: { ...first, externalId: `TEST-${run}-dup`, email: `dup.${run}@example.com` } }),
        expect: (r) => r.status === 200 && r.json?.kind === 'attached',
        want: '200, rattaché au lead existant',
      },
      {
        label: 'Lead sans téléphone ni email',
        run: () => send(base, { secret, source: args.source, body: { fullName: 'Test Sans Contact', zone, product, campaign } }),
        expect: (r) => r.status === 422,
        want: '422, refusé : aucun moyen de contact',
      },
      {
        label: 'Mauvais secret',
        run: () => send(base, { secret: 'mauvais-secret-de-test', source: args.source, body: mk(count + 1) }),
        expect: (r) => r.status === 401,
        want: '401, refusé',
      },
      {
        label: 'Absence de secret',
        run: () => send(base, { secret: null, source: args.source, body: mk(count + 2) }),
        expect: (r) => r.status === 401,
        want: '401, refusé',
      },
      {
        label: 'Source inconnue',
        run: () => send(base, { secret, source: `inconnue-${run}`, body: mk(count + 3) }),
        expect: (r) => r.status === 400,
        want: '400, source inconnue',
      },
      {
        label: 'Corps illisible',
        run: () => send(base, { secret, source: args.source, rawBody: '{"phone":' }),
        expect: (r) => r.status === 400,
        want: '400, corps illisible',
      },
    ];
    for (const c of checks) {
      const r = await c.run();
      const good = c.expect(r);
      allGood &&= good;
      console.log(`${good ? 'OK    ' : 'ÉCHEC '} ${c.label.padEnd(46)} → ${r.status} ${describe(r)}${good ? '' : `   (attendu : ${c.want})`}`);
      if (delay > 0) await sleep(delay);
    }
  }

  console.log(allGood ? '\nTout est conforme.\n' : '\nAu moins un résultat est inattendu : voir ci-dessus.\n');
  process.exit(allGood ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nErreur : ${e.message}\n`);
  process.exit(2);
});
