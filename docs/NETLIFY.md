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

## Données de départ
Sans elles, un lead reçu va en **file tampon** (comportement voulu, pas une panne). Voir
[FONCTIONS.md](FONCTIONS.md) : comptes, équipe, configuration du télépro, campagne active, télépro connecté.

## Ce qui n'est pas testé automatiquement
Les 37 tests de `functions/src/http.test.ts` couvrent toute la couche HTTP (secret, méthode, corps, codes de
retour) et la lecture de la clé. La fonction a aussi été exécutée en local, bundlée comme le fait Netlify.
En revanche, **la transaction Firestore de l'ingestion n'a jamais tourné contre une vraie base** : le premier
lead de test sur `crm-pose-dev` sert de recette.

## Secours : fonctions Firebase
`firebase deploy --only functions:leads` déploie la même réception (`ingestLead`) et les fonctions d'administration.
Paquet prêt à l'emploi et commandes : `deploy-bundle/`. Les écrans d'administration les utilisent si l'application
est lancée avec `VITE_ADMIN_WRITE_MODE=functions`.
