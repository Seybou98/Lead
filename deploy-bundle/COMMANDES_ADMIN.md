# Déploiement du CRM Leads — à exécuter dans Google Cloud Shell

Paquet fourni : `lead-functions.zip` (7 fonctions dans le groupe `leads`, plus les règles Firestore).
Il ne contient aucun secret et ne touche pas aux fonctions existantes (groupe `default`).

## 1. Préparer Cloud Shell (une fois)
1. Ouvrir <https://console.cloud.google.com>, puis cliquer sur **Activer Cloud Shell** (icône `>_` en haut à droite).
2. Menu **⋮ → Importer**, choisir `lead-functions.zip`.
3. Dans le terminal :
```
unzip -o lead-functions.zip -d lead-deploy && cd lead-deploy
(cd functions && npm install)
firebase login --no-localhost
```
(`firebase login` n'est nécessaire que si le CLI le demande ; se connecter avec le compte administrateur.)
Un avertissement sur la version de Node peut s'afficher : il est sans conséquence.

## 2. Développement — projet `crm-pose-dev`
Le secret `CL_INGEST_SECRET` existe déjà : passer directement au déploiement.
```
firebase deploy --only functions:leads --project crm-pose-dev
```
Les règles Firestore sont déjà publiées sur ce projet.

## 3. Production — projet `crm-label-pose`
Dans cet ordre (les règles AVANT les fonctions) :
```
# 3a. Règles de sécurité : protègent les collections cl_* (sans elles, tout compte connecté peut y lire et écrire)
firebase deploy --only firestore:rules --project crm-label-pose

# 3b. Secret partagé avec la source de leads : ajoute une nouvelle version (saisir une valeur forte)
#     Générer une valeur :  openssl rand -hex 32
firebase functions:secrets:set CL_INGEST_SECRET --project crm-label-pose

# 3c. Fonctions
firebase deploy --only functions:leads --project crm-label-pose
```
Si le CLI propose de **supprimer** des fonctions, répondre **non** (ce serait celles du CRM principal).

## 4. Vérifier
```
firebase functions:list --project crm-label-pose | grep -E "ingestLead|admin"
```
Doit lister : ingestLead, adminUpsertTeam, adminUpdateProfile, adminUpsertSource, adminUpsertCampaign, adminSaveSpend, adminUpdateAssignmentConfig.

## Notes
- Le déploiement avec un compte administrateur autorise lui-même les fonctions à lire le secret et les rend appelables : aucune commande `gcloud` supplémentaire n'est nécessaire.
- La valeur du secret de production doit être communiquée à la personne qui configure la source de leads (en-tête `X-CRM-SECRET`).
- Brancher la source de leads (Pabbly) n'est PAS inclus : tant que l'adresse n'est pas changée, les leads continuent d'arriver sur l'ancien CRM.
