# Réception des leads — fonction Netlify

La fonction `netlify/functions/ingest-lead.ts` reçoit les leads (Pabbly, Meta, formulaires, agences), les
normalise, détecte les doublons, les attribue à un télépro et journalise la décision. C'est le chemin
**principal**. Les fonctions Firebase (`functions/`) restent disponibles en **secours** : elles utilisent
la même logique (`functions/src/ingest.ts`, `functions/src/http.ts`).

## Pourquoi Netlify
- Aucun droit Google Cloud supplémentaire (Secret Manager, Cloud Run) : on réutilise ce que le CRM principal fait déjà.
- Le secret est une variable d'environnement Netlify : on peut reprendre **la valeur de l'ancien CRM**
  (`CRM_SHARED_SECRET`), donc l'entreprise externe n'a rien à changer dans son en-tête.

## Mise en service

### 1. Créer le site Netlify
- Nouveau site depuis le dépôt Git, **Base directory : `Lead`**.
- Les réglages (commande de build, dossier publié, fonctions, redirections) sont lus dans `Lead/netlify.toml`.
- Ce site héberge aussi l'application du CRM Leads.

### 2. Variables d'environnement (Site configuration → Environment variables)
| Variable | Valeur |
|---|---|
| `CL_INGEST_SECRET` | Le secret partagé avec la source de leads. Pour ne rien changer chez l'entreprise externe : la valeur de `CRM_SHARED_SECRET` de l'ancien CRM. Le nom `CRM_SHARED_SECRET` est aussi accepté. |
| `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` | La clé du compte de service du projet visé, encodée en base64 (voir ci-dessous). Le nom `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON brut) est aussi accepté. |

**Quel projet ?** La clé détermine le projet Firebase où les leads sont écrits : celle de `crm-pose-dev` pour tester,
celle de `crm-label-pose` pour la production. Ne jamais mélanger : un site de test avec une clé de production
écrirait de faux leads chez les vrais utilisateurs.

**Réutiliser la clé du CRM principal** : sur le site Netlify du CRM principal, la variable
`FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (ou `…_JSON`) contient déjà la clé de production. Elle peut être copiée
telle quelle.

**Encoder une clé (PowerShell)** :
```
[Convert]::ToBase64String([IO.File]::ReadAllBytes("chemin\vers\cle.json")) | Set-Clipboard
```
(le résultat est copié dans le presse-papiers ; le coller dans Netlify, ne le mettre dans aucun fichier du dépôt).

### 3. Adresse à donner à la source de leads
```
POST https://<votre-site>.netlify.app/api/leads?source=<identifiant de la source>
En-tête : X-CRM-SECRET: <le secret>
Corps   : JSON ou formulaire (x-www-form-urlencoded)
```
Le paramètre `source` est **facultatif** : sans lui, la campagne est retrouvée par son identifiant externe ou son nom
(comme dans l'ancien webhook). S'il est fourni, la source doit exister et être activée, sinon le lead est refusé
(400 ou 403). L'identifiant d'une source s'affiche dans l'écran **Campagnes**, dans le formulaire d'une campagne,
sous le choix de la source.
Les noms de champs de l'ancien webhook (`Prénom`, `Nom`, `mobile`, `leadgen_id`…) sont tous acceptés.

### 4. Tester
```
curl -i -X POST "https://<votre-site>.netlify.app/api/leads?source=<id>" ^
  -H "Content-Type: application/json" -H "X-CRM-SECRET: <le secret>" ^
  -d "{\"fullName\":\"Test Dupont\",\"phone\":\"0612345678\",\"email\":\"test@example.com\",\"zone\":\"ile_de_france\",\"product\":\"pac_air_eau\",\"campaign\":\"<nom de la campagne>\"}"
```
Rejouer la même commande : le lead doit être **rattaché** au premier, pas dupliqué.

| Code | Sens |
|---|---|
| 200 | Lead créé, rattaché à un lead ouvert, ou déjà reçu |
| 400 | Source inconnue, ou corps illisible |
| 401 | Secret absent ou invalide |
| 403 | Source désactivée |
| 405 | Mauvaise méthode (seul POST est accepté) |
| 422 | Ni téléphone ni email exploitable |
| 500 | Erreur interne, ou fonction mal configurée (secret ou clé Firebase manquant). Détail dans Netlify → Functions → journaux. |

La donnée brute reçue est écrite **avant** tout traitement (`cl_rawLeads`) : un lead n'est pas perdu si la suite échoue.

## Qualification de fin d'appel (Ma journée)
Deuxième fonction du site : `netlify/functions/qualify-call.ts`, adresse `/api/qualify-call`.
- **Pas de secret partagé** : l'application envoie le jeton Firebase du télépro connecté ; la fonction le vérifie,
  lit son rôle dans `users/{uid}` et n'accepte que le propriétaire du lead (ou un administrateur).
- **Même clé Firebase** que la réception des leads : aucune variable de plus.
- Le télépro n'a aucun droit d'écriture direct sur les leads (règles Firestore inchangées) : tout passe par cette
  fonction, qui écrit le lead, l'historique, la tentative, les actions et les compteurs en une transaction.
- **En local** : `npm run dev` suffit (http://localhost:5180). Un plugin de développement (`scripts/devFunctions.ts`)
  sert `/api/qualify-call` et `/api/leads` avec exactement les mêmes fonctions que Netlify, sans Netlify CLI
  (dont l'étape « Edge Functions » peut bloquer son port 8888 pendant plusieurs minutes). Les variables
  non `VITE_` (CRM_SHARED_SECRET, GOOGLE_APPLICATION_CREDENTIALS…) sont lues dans `.env`. La clé du compte de
  service de la base de DEV doit être dans `Lead/service-account.json` (fichier ignoré par git).
- Codes : 200 enregistré (ou déjà enregistré) · 401 non connecté · 403 sans droit · 404 lead introuvable ·
  409 lead clôturé / modifié entre-temps · 422 saisie incomplète · 500 erreur interne.
- Réglages (facultatifs) dans le document `cl_config/callRules` : `nrDelaysMinutes`, `recycleAfterDays`,
  `documentFollowUpDays`, `promisedMarginMinutes`, `schedule`. Sans lui : valeurs du cahier des charges
  (NR2 après 3 h, puis J+1, J+1, J+2 ; horaires lundi-vendredi 9 h-19 h, Europe/Paris).

## Statut Disponible / Pause (Ma journée)
Troisième fonction du site : `netlify/functions/set-status.ts`, adresse `/api/set-status` (jeton Firebase, même clé).
- Le télépro choisit : Disponible, En pause, Relance documentaire, Montage dossier. « En appel » est posé au clic sur
  « Appeler » et rétabli (statut d'avant l'appel) à l'enregistrement du résultat, dans la même transaction que la
  qualification. « Absent » / « Indisponible » ne se changent pas soi-même (absence, manager).
- Le moteur de distribution exclut déjà les profils en pause, absents, indisponibles ou à plafond atteint
  (`newLeads >= plafond`) : à 10 le télépro sort du pool, à 9 il revient.
- Chaque changement est historisé dans `cl_audit` (`operational_status_changed`).
- Codes : 200 · 401 · 404 profil absent · 409 statut verrouillé · 422 statut refusé · 500.

## Documents d'un lead
Quatrième fonction du site : `netlify/functions/lead-documents.ts`, adresse `/api/lead-documents` (jeton Firebase, même clé).
- Corps : `{ leadId, requestId, input: { kind, ... } }` avec `kind` parmi `receive` (pièce reçue, avec ou sans fichier),
  `check` (conforme / non conforme + motif), `reask`, `follow_up` (relance faite), `decide` (poursuivre, recycler,
  clôturer à J+14) et `start_building` (passage au montage).
- Droit : propriétaire du lead, manager du lead (`managerIds`) ou administrateur. L'identité vient du jeton.
- Une transaction recalcule l'état du dossier, le statut du lead, la prochaine action et les compteurs de charge,
  et écrit l'historique. Idempotente (`requestId`).
- Fichiers : le navigateur les envoie dans Storage sous `cl_documents/{leadId}/{pièce}/…`, puis déclare le chemin à
  la fonction, qui n'accepte que ce préfixe. **À faire avant la production** : ajouter dans `storage.rules` une règle
  limitant `cl_documents/**` aux rôles administrateur, manager et télépro (aujourd'hui la règle générale laisse tout
  compte CRM lire et écrire).
- Pièces demandées : checklist du produit du lead (`cl_checklists/{famille}`), sinon `cl_checklists/default`, sinon la liste d'origine du code. Édition : Paramètres → Documents et checklists (règle Firestore `cl_checklists` à appliquer, voir `firebase/RULES_A_APPLIQUER.md`).
- Réglages facultatifs, document `cl_config/documentRules` : `followUpDays` (croissant, ex. `[1,3,5,7,14]`),
  `decisionRepeatDays`. La marge « documents promis » et les horaires viennent de `cl_config/callRules`.
- Codes : 200 · 400 · 401 · 403 · 404 · 409 (lead clôturé, dossier indisponible) · 422 (saisie refusée) · 500.

## Réattribution d'un lead (cockpit manager)
Cinquième fonction du site : `netlify/functions/reassign-lead.ts`, adresse `/api/reassign-lead` (jeton Firebase, même clé).
- Corps : `{ leadId, targetUid, requestId, reason }`. Droit : manager du lead (`managerIds`) ou administrateur ;
  un manager ne confie un lead qu'à un télépro de son périmètre. Motif obligatoire.
- Une transaction change propriétaire, équipe et managers (union : le manager qui agit garde la vue), déplace
  la charge d'un profil à l'autre, crée l'action « prendre en charge » si le lead sortait de la file tampon,
  écrit l'historique (`reassigned`), prévient les deux télépros et trace l'opération dans `cl_audit`. Idempotente.
- Codes : 200 · 400 · 401 · 403 · 404 · 409 (lead clôturé) · 422 (motif, cible) · 500.

## Planificateur (traitements automatiques)
Deux fonctions : `netlify/functions/scheduler.ts` (PLANIFIÉE, toutes les 5 minutes, déclarée dans `netlify.toml`,
section `[functions."scheduler"]`) et `netlify/functions/scheduler-run.ts` (`/api/scheduler-run`, jeton Firebase d'un
administrateur, pour un passage manuel depuis Paramètres → « Exécuter maintenant »).
- **Ce qu'il fait** : escalades vers les managers (notifications `manager_alert`, une seule par événement), entrée
  en recyclage puis archivage des injoignables, attribution des leads de la file tampon quand un télépro compatible
  redevient disponible. Logique : `src/domain/scheduler/plan.ts` et `functions/src/scheduler.ts`.
- **Idempotent** : rejouer un passage ne double rien (identifiants déterministes, relecture dans chaque transaction).
- **Réglages facultatifs**, document `cl_config/schedulerRules` : `callbackEscalationMin` (30), `bufferWarnMin` (15),
  `bufferAnomalyHours` (24), `maxRecycleCycles` (3). Horaires : `cl_config/callRules`.
- **Trace** : `cl_config/schedulerStatus` (dernier passage et compteurs), affichée dans Paramètres. Plus de
  15 minutes sans passage : l'écran signale que le planificateur ne tourne plus.
- **En développement** il n'y a aucune planification : utiliser le bouton « Exécuter maintenant ». Le passage
  agit sur la vraie base (il attribue réellement les leads en file tampon).
- La planification n'existe qu'une fois le site déployé sur Netlify (les fonctions planifiées ne tournent que sur
  la branche de production du site).

## Absences et transferts de portefeuille
Sixième fonction du site : `netlify/functions/portfolio.ts`, adresse `/api/portfolio` (jeton Firebase, manager ou administrateur).
- `declare_absence` : enregistre l'absence (`cl_absences`), pose le statut « Absent » si elle est en cours, trace dans
  `cl_audit`. Un chevauchement avec une autre absence du même télépro est refusé. Le moteur d'attribution lit déjà les
  dates : la distribution s'arrête à l'heure de début et reprend à l'heure de fin.
- `end_absence` : fin anticipée (la fin devient « maintenant »).
- `transfer` : jusqu'à 25 éléments par envoi, chacun passant par la réattribution (droits, historique, compteurs,
  audit). Le lot est inscrit dans `cl_transfers` ; un lot temporaire reçoit une date de retour.
- Le planificateur applique la fin des absences (statut « Absent » levé ; distribution laissée suspendue si
  « rétablir automatiquement » était désactivé) et le retour des transferts temporaires vers le propriétaire d'origine.
- Règle Firestore à appliquer : `cl_transfers` (lecture manager et administrateur), voir `firebase/RULES_A_APPLIQUER.md`.

## Réglages d'administration (SLA, horaires, cycles NR)
Édités dans Paramètres → « SLA et horaires » et « Cycles NR, rappels et documents ». Stockés dans `cl_settings` :
`sla` (paliers, réattribution, horaires, jours fermés, comportement hors horaires), `rules` (matrice NR, recyclage,
rappels, relances documentaires), `sla_<campagne>` (règle de réattribution propre à une campagne). Lecture par tout le
personnel, écriture par l'administrateur seul (règle `cl_settings` à appliquer : `firebase/RULES_A_APPLIQUER.md`).
- **Qui les lit** : la qualification d'appel (matrice NR, horaires), les relances documentaires, le planificateur
  (alertes manager, recyclage, réattribution au SLA), la réception des leads (comportement hors horaires) et le navigateur
  (délai du SLA, SLA suspendu hors horaires).
- **Sans réglage enregistré** : les valeurs du cahier des charges. Les anciens documents `cl_config/callRules`,
  `documentRules` et `schedulerRules` ne servent plus qu'à défaut de tout réglage enregistré.
- **Réattribution automatique au SLA** : désactivée par défaut ; le planificateur confie le lead à un autre télépro (ou à
  l'équipe de secours) tant qu'il n'est pas pris en charge ; jamais un rappel client promis.

## Centre de paramétrage, produits et versions
`/parametres` regroupe les modules, les alertes de configuration et les modifications récentes (administrateur). Les
alertes sont calculées à partir du catalogue du CRM principal (`products`), des checklists, des équipes, des profils et des
campagnes. `/parametres/versions` relit le journal d'audit (`cl_audit`, 300 entrées les plus récentes) : chaque
enregistrement d'un réglage y laisse l'ancienne et la nouvelle valeur ; un retour arrière réenregistre l'ancienne
valeur (nouvelle version, validée comme toute saisie).

## Montage, vente et transmission au CRM principal (lot Conversion)

Fonction `lead-conversion` (`POST /api/lead-conversion`, jeton Firebase de l'utilisateur, aucun secret partagé).
Corps : `{ leadId, requestId, input }` avec `input.kind` parmi `save_draft`, `request_validation`, `decide`, `create_sale`,
`sale_action` (suivi de la vente : `input.action.kind` parmi `offer_sent`, `signed`, `deposit_expected`, `deposit_received`,
`payment_confirmed`, `financing_started`, `financing_accepted`, `financing_refused`, `cancel`, `retract`, `reminder`)
et `transmit` (reprise manuelle : manager du lead ou administrateur ; `decision: 'link' | 'create'` tranche un doublon).

- Décision métier : `src/domain/conversion/` (finance, verrous, plan). Écriture en une transaction : `functions/src/conversion.ts`.
- Données du CRM Leads : `cl_leads/{id}/montage/draft` et `/validation`, `cl_sales/{leadId}`, `cl_conversions/{leadId}`, compteur `cl_counters/sales_AAAA`.
- Une vente par lead : créer deux fois (double clic, reprise) rend la vente existante.
- **Transmission** (`functions/src/transmission.ts`) : crée dans le CRM principal le dossier `dossiers/cl_<leadId>`, sa fiche
  `subventions/cl_<leadId>`, son historique `historique_dossier` et copie les pièces conformes vers
  `dossiers/<id>/documents/`. La charge utile reprend celle du CRM principal (`src/domain/conversion/dossierPayload.ts` :
  à mettre à jour si le CRM principal change). Idempotente et reprenable (avancement dans `cl_conversions`).
- Reprise automatique : le planificateur relance les transmissions en échec (pause 1, 2, 4… minutes), puis alerte les
  administrateurs après 5 tentatives. Un doublon de dossier attend une décision humaine.
- Parcelle cadastrale : retrouvée automatiquement d'après l'adresse (service public de l'IGN) dans l'écran de montage, et complétée à la transmission si elle manque. Un service indisponible ne bloque rien.
- Ce qui est repris du CRM principal est copié dans `Lead/` : voir `docs/DEPENDANCES_CRM_PRINCIPAL.md`.
- Suivi de la vente (`functions/src/saleTrack.ts`, règles dans `src/domain/sales/track.ts`) : le CRM enregistre signature, règlement
  et financement saisis par l'équipe, contrôle l'enchaînement, trace chaque étape et pose la date de sécurisation (signée ET
  paiement confirmé ou financement accepté). Il ne signe, n'encaisse ni ne finance lui-même : prestataires de signature et
  organismes de financement non branchés.
- Variables facultatives : `FIREBASE_STORAGE_BUCKET` (défaut `<projet>.firebasestorage.app`) pour la copie des pièces ;
  `VITE_MAIN_CRM_URL` (dans l'application) pour le lien « Voir le dossier CRM ».
- Aucune règle Firestore supplémentaire : les règles actuelles couvrent ces chemins en lecture, l'écriture reste au serveur.

## Données de départ
Sans elles, un lead reçu va en **file tampon** (comportement voulu, pas une panne). Voir
[FONCTIONS.md](FONCTIONS.md) : comptes, équipe, configuration du télépro, campagne active, télépro connecté.

## Envoyer plusieurs leads de test
```powershell
cd Lead
node scripts/send-test-leads.mjs --url https://VOTRE-SITE.netlify.app --secret VOTRE_SECRET --count 10
node scripts/send-test-leads.mjs --url https://VOTRE-SITE.netlify.app --secret VOTRE_SECRET --count 10 --scenario mix
```
- `--scenario mix` ajoute des cas limites vérifiés (rejeu, doublon de téléphone, sans contact, mauvais secret,
  source inconnue, corps illisible) et affiche OK / ÉCHEC pour chacun.
- `--parallel` envoie tout en même temps ; `--campaign`, `--zone`, `--product`, `--source` adaptent les leads
  à votre campagne ; `--help` liste tout.
- Faux leads : « Test Lead 001… », emails `@example.com`, numéros 06 39 98 XX XX (plage fictive).
- Le secret peut aussi venir de la variable `CL_INGEST_SECRET` (évite de le laisser dans l'historique).

## Ce qui n'est pas testé automatiquement
Les 37 tests de `functions/src/http.test.ts` couvrent toute la couche HTTP (secret, méthode, corps, codes de
retour) et la lecture de la clé. La fonction a aussi été exécutée en local, bundlée comme le fait Netlify.
En revanche, **la transaction Firestore de l'ingestion n'a jamais tourné contre une vraie base** : le premier
lead de test sur `crm-pose-dev` sert de recette.

## Secours : fonctions Firebase
`firebase deploy --only functions:leads` déploie la même réception (`ingestLead`) et les fonctions d'administration.
Paquet prêt à l'emploi et commandes : `deploy-bundle/`. Les écrans d'administration les utilisent si l'application
est lancée avec `VITE_ADMIN_WRITE_MODE=functions`.
