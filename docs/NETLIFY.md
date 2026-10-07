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
