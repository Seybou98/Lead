# Cloud Functions du CRM Leads

Dossier : `Lead/functions` · groupe (*codebase*) : **`leads`** · région : `europe-west1` · runtime : Node 22.
Configuration : `Lead/firebase.json` (uniquement les fonctions) et `Lead/.firebaserc` (projet par défaut : **`crm-pose-dev`**).

> Le groupe `leads` est indépendant du groupe `default` du CRM principal : déployer l'un ne supprime jamais les fonctions de l'autre.
> Toutes les commandes se lancent **depuis le dossier `Lead/`**, jamais depuis la racine du projet.

> **Statut : SECOURS.** Le chemin principal est désormais : écritures d'administration directes depuis le navigateur,
> et réception des leads par la fonction **Netlify** (voir [NETLIFY.md](NETLIFY.md)). Les fonctions Firebase ci-dessous
> restent prêtes à déployer (paquet : `deploy-bundle/`). L'application les utilise si `VITE_ADMIN_WRITE_MODE=functions`.

## Fonctions

| Fonction | Rôle |
|---|---|
| `ingestLead` | Reçoit un lead (Pabbly, Meta, formulaire), le normalise, détecte les doublons, l'attribue, journalise la décision |
| `adminUpsertTeam` | Crée ou modifie une équipe ; recalcule les profils des anciens et nouveaux membres |
| `adminUpdateProfile` | Périmètre, plafond, dérogation temporaire, horaires, suspension d'un télépro |
| `adminUpsertSource` | Crée ou modifie une source de leads |
| `adminUpsertCampaign` | Crée ou modifie une campagne ; l'activation est bloquée si la configuration est incomplète |
| `adminSaveSpend` | Saisit ou corrige une dépense publicitaire (motif obligatoire à la correction, ancienne et nouvelle valeur conservées dans `cl_audit`) |
| `adminUpdateAssignmentConfig` | Règles d'attribution d'une campagne (critères, ordre de priorité, distribution automatique) |

Les six fonctions `admin*` sont appelées depuis l'application par un administrateur connecté (rôle revérifié côté serveur). Chaque modification laisse une ligne dans `cl_audit` avec l'état avant et après.

À venir : réattribution manuelle, import CSV et synchronisation des dépenses (Meta, Google), réévaluation de la file tampon (planifiée).

## Ce que fait `ingestLead`, dans l'ordre
1. Vérifie l'en-tête `X-CRM-SECRET` (comparaison en temps constant).
2. **Écrit la donnée brute** dans `cl_rawLeads` : rien n'est perdu, même si la suite échoue.
3. Normalise (téléphone en E.164, email, code postal) et refuse un lead sans téléphone ni email valide (réponse 422).
4. Dans **une transaction** : cherche les doublons, évalue les télépros, choisit, puis écrit le lead, son historique, l'action, le journal de distribution, la notification et les compteurs.
5. Consigne l'issue sur la donnée brute.

Réponses : `200` créé / rattaché / déjà reçu · `400` source inconnue · `401` secret invalide · `403` source désactivée · `405` mauvaise méthode · `422` aucun moyen de contact · `500` erreur interne.

## Droits nécessaires pour déployer (à demander au propriétaire du projet `crm-pose-dev`)

Dans la console Google Cloud → IAM, pour le compte qui déploie :

| Rôle | Pourquoi |
|---|---|
| **Cloud Functions Admin** | créer et mettre à jour les fonctions |
| **Service Account User** | faire tourner les fonctions avec le compte de service du projet |
| **Secret Manager Admin** | créer le secret `CL_INGEST_SECRET` (la première fois seulement) |
| **Cloud Build Editor** et **Artifact Registry Writer** | construire l'image de la fonction |

Plus simple : demander le rôle **Éditeur** (ou **Propriétaire**) du projet de développement, ou faire déployer par quelqu'un qui l'a déjà.

## Déployer sur `crm-pose-dev`

```
cd Lead
firebase functions:secrets:set CL_INGEST_SECRET --project crm-pose-dev    # saisir un secret long et aléatoire
firebase deploy --only functions --project crm-pose-dev --dry-run         # validation, rien n'est publié
firebase deploy --only functions --project crm-pose-dev
```

Ne jamais déployer sans `--project` explicite et ne jamais viser `crm-label-pose` (production) avant la recette.

## Données à créer avant le premier lead

Sans elles, le lead est reçu mais va en **file tampon** (c'est le comportement voulu : il n'est jamais perdu). Tout se fait depuis l'application, une fois les fonctions déployées :

1. **Un compte `telepro commercial` et un compte `manager`** dans le CRM principal (`users`), actifs.
2. **Utilisateurs** → « Créer une équipe » : manager, membres.
3. **Utilisateurs** → « Configurer » sur le télépro : produits et zones autorisés (`*` = tout), plafond, horaires de travail. Sans plage horaire, il est toujours « hors horaires ».
4. **Campagnes** → « Créer une campagne » (avec une nouvelle source si besoin) : identifiant externe, produit, zone, équipe éligible, puis statut « Active ».
5. Le télépro doit être **connecté à l'application** : le battement de présence l'indique au moteur.

Les valeurs de produit et de zone sont comparées sans tenir compte des accents, de la casse ni de la ponctuation (`PAC Air/Eau` = `pac_air_eau`).

## Tester

```
curl -X POST "https://europe-west1-crm-pose-dev.cloudfunctions.net/ingestLead?source=<idSource>" \
  -H "X-CRM-SECRET: <secret>" -H "Content-Type: application/json" \
  -d '{"fullName":"Jean Dupont","phone":"06 12 34 56 78","email":"jean@example.com","postalCode":"69003","zone":"idf","product":"pac_air_eau","campaign":"<nom de la campagne>"}'
```

Rejouer la même commande : la réponse devient `attached` (même téléphone, lead encore ouvert), sans second lead ni second compteur SLA.

## Ce qui est testé, et ce qui ne l'est pas
- **Testé automatiquement** (`npm test`) : normalisation, doublons, éligibilité, classement, plafond de 10, horaires, correspondance des champs, planification complète d'une ingestion (créé, file tampon, doublon probable, client connu, rejeu, rejet).
- **Compilé et chargé** en Node comme il le sera en ligne.
- **Non testé** : l'enchaînement lecture / écriture Firestore (`functions/src/ingest.ts`), faute d'émulateur (Java absent). Cette couche est volontairement fine ; le premier lead de test sur `crm-pose-dev` est sa vraie recette.
