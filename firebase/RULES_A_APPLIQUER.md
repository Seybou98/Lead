> **MISE À JOUR — la source de vérité est `firebase/firestore.dev.rules`.** Ce document décrit les 3 modifications
> d'origine. Depuis, les écritures de **configuration** par un administrateur (équipes, profils hors compteurs,
> campagnes, sources, dépenses, audit en ajout seul) sont autorisées depuis le navigateur ; les données métier
> restent réservées au serveur. Pour déployer : `firebase deploy --only firestore:rules --project <projet> --config firebase/firebase.dev.json`.

# Règles Firestore du CRM Leads — modifications à appliquer

> **Ne pas déployer le `firestore.rules` du dépôt.** Il est plus ancien que les règles en production :
> il ne contient ni `match /demandes_dossier/…` ni le `create` public sur `notifications`
> (formulaires `public_home_form` / `mobile_app_non_client_form`). Le déployer casserait ces formulaires.
> Les modifications ci-dessous se font sur **la version que tu m'as collée** (celle de la console Firebase).
>
> À faire d'abord sur **`crm-pose-dev`**, à tester, puis seulement ensuite en production.

## Comment les appliquer (méthode simple)

Le fichier **`firestore.dev.rules`** (dans ce dossier) contient **tes règles complètes + les 3 modifications**,
repérées par des bandeaux `MODIFICATION 1 / 2 / 3`. Son écriture a été validée (compilation sans erreur sur `crm-pose-dev`).

**Par la console Firebase :**
1. Ouvre <https://console.firebase.google.com/project/crm-pose-dev/firestore/rules> (projet **crm-pose-dev**, pas `crm-label-pose`).
2. **Copie d'abord le contenu actuel** de l'éditeur dans un fichier de sauvegarde (en cas de retour arrière).
3. Sélectionne tout (`Ctrl+A`) dans l'éditeur, colle le contenu de `firestore.dev.rules`.
4. Clique **Publier**.

**Par la ligne de commande** (depuis le dossier `Lead/firebase`) :
```
firebase deploy --only firestore:rules --project crm-pose-dev --config firebase.dev.json
```
(`--dry-run` en plus pour valider sans publier.)

> Ne publie **pas** ce fichier sur `crm-label-pose` (production) tant que les tests ne sont pas faits.
> Les règles de `crm-pose-dev` publiées par-dessus remplacent les précédentes : vérifie à l'étape 2 qu'elles
> ressemblent bien à celles que tu m'as collées, sinon des écrans du CRM principal peuvent changer de comportement en dev.

---

Il y a **3 modifications**, toutes additives. Rien de l'existant n'est retiré.

---

## Modification 1 — fonctions d'aide

À coller juste après la fonction `ticketClientAuthorized(...)`, avant `match /public/{docId}` :

```
    // ── CRM Leads (collections cl_*) ─────────────────────────────────────────────────────────
    // Rôle et statut viennent de users/{uid}, comme pour le mandataire. La correspondance
    // rôle CRM principal → profil CRM Leads est AUSSI dans Lead/src/config/roles.ts :
    // toute modification doit être faite aux deux endroits.
    function clUserActive() {
      return signedIn() && currentUserData().get('status', '').lower() == 'active';
    }
    function clMainRole() { return currentUserData().get('role', '').lower(); }
    function isClAdmin() {
      return clUserActive() && clMainRole() in ['administrateur', 'admin', 'administratrice'];
    }
    function isClManager() { return clUserActive() && clMainRole() == 'manager'; }
    function isClTelepro() {
      return clUserActive() && clMainRole() in ['telepro commercial', 'telepro-commercial', 'télépro commercial', 'télépro-commercial', 'telepro', 'télépro'];
    }
    function isClStaff() { return isClAdmin() || isClManager() || isClTelepro(); }

    // Périmètre d'un document « appartenant » à un lead : admin = tout ; manager = si son uid est
    // dans `managerIds` (champ dénormalisé, donc prouvable pour une requête de liste) ;
    // télépro = si propriétaire.
    function clCanSee(data) {
      return isClAdmin()
        || (isClManager() && request.auth.uid in data.get('managerIds', []))
        || (isClTelepro() && data.get('ownerId', '') == request.auth.uid);
    }
```

## Modification 2 — règles des collections `cl_*`

À coller juste **avant** `match /{collection}/{document=**}` (donc après `match /demandes_dossier/…`).
Principe : **le navigateur lit, le serveur écrit.** Aucune écriture directe sur les collections métier
(les Cloud Functions utilisent l'Admin SDK, qui ignore ces règles). Tout `cl_*` non listé est refusé.

```
    // ── CRM Leads ────────────────────────────────────────────────────────────────────────────
    match /cl_profiles/{uid} {
      allow read: if isClAdmin()
        || (isClStaff() && request.auth.uid == uid)
        || (isClManager() && request.auth.uid in resource.data.get('managerIds', []));
      allow write: if false;
    }

    // Seule écriture client directe : son propre heartbeat de présence.
    match /cl_presence/{uid} {
      allow read: if isClAdmin() || isClManager() || (isClStaff() && request.auth.uid == uid);
      allow create, update: if isClStaff() && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['uid', 'connected', 'lastSeenAt'])
        && request.resource.data.uid == uid;
      allow delete: if false;
    }

    match /cl_teams/{id} {
      allow read: if isClStaff();
      allow write: if false;
    }

    match /cl_absences/{id} {
      allow read: if isClAdmin() || isClManager()
        || (isClTelepro() && resource.data.get('userId', '') == request.auth.uid);
      allow write: if false;
    }

    // Lots de transferts de portefeuille : écrits par le serveur, lisibles par les managers et administrateurs.
    match /cl_transfers/{id} {
      allow read: if isClAdmin() || isClManager();
      allow write: if false;
    }

    match /cl_leads/{leadId} {
      allow read: if clCanSee(resource.data);
      allow write: if false;

      // events (historique immuable), callAttempts, documents : même périmètre que le lead parent.
      match /{sub}/{subId} {
        allow read: if clCanSee(get(/databases/$(database)/documents/cl_leads/$(leadId)).data);
        allow write: if false;
      }
    }

    match /cl_actions/{id} {
      allow read: if clCanSee(resource.data);
      allow write: if false;
    }

    match /cl_sales/{id} {
      allow read: if clCanSee(resource.data);
      allow write: if false;
    }

    // L'id du document est le leadId.
    match /cl_conversions/{leadId} {
      allow read: if exists(/databases/$(database)/documents/cl_leads/$(leadId))
        && clCanSee(get(/databases/$(database)/documents/cl_leads/$(leadId)).data);
      allow write: if false;
    }

    // Campagnes, sources, dépenses : masquées au télépro (§22.11).
    match /cl_campaigns/{id} {
      allow read: if isClAdmin() || isClManager();
      allow write: if false;
    }
    match /cl_sources/{id} {
      allow read: if isClAdmin() || isClManager();
      allow write: if false;
    }
    match /cl_adSpend/{id} {
      allow read: if isClAdmin() || isClManager();
      allow write: if false;
    }

    match /cl_distributionLog/{id} {
      allow read: if isClAdmin()
        || (isClManager() && request.auth.uid in resource.data.get('managerIds', []));
      allow write: if false;
    }

    // Admin uniquement : audit, payloads bruts (données personnelles), journal d'intégration.
    match /cl_audit/{id} {
      allow read: if isClAdmin();
      allow write: if false;
    }
    match /cl_rawLeads/{id} {
      allow read: if isClAdmin();
      allow write: if false;
    }
    match /cl_integrationLog/{id} {
      allow read: if isClAdmin();
      allow write: if false;
    }
    match /cl_idempotency/{id} {
      allow read, write: if false;
    }

    match /cl_notifications/{id} {
      allow read: if clUserActive() && request.auth.uid in resource.data.get('recipientIds', []);
      allow update: if clUserActive() && request.auth.uid in resource.data.get('recipientIds', [])
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['readBy']);
      allow create, delete: if false;
    }

    // Brouillons de transfert de portefeuille : propres au manager ou à l'administrateur qui les crée, un par télépro
    // (identifiant « <auteur>_<télépro> »). `resource == null` : lire un brouillon absent n'est pas une erreur de droits.
    match /cl_transferDrafts/{id} {
      allow read, delete: if (isClAdmin() || isClManager()) && (resource == null || resource.data.get('createdBy', '') == request.auth.uid);
      allow create, update: if (isClAdmin() || isClManager())
        && request.resource.data.createdBy == request.auth.uid
        && id == request.auth.uid + '_' + request.resource.data.fromUid;
    }

    // Réglages d'administration (SLA et horaires, cycles NR, relances) : lus par tout le personnel (compteurs, aperçus),
    // écrits par l'administrateur seul. L'identifiant du document est son nom (sla, rules, sla_<campagne>).
    match /cl_settings/{id} {
      allow read: if isClStaff();
      allow create, update: if isClAdmin();
      allow delete: if isClAdmin();
    }

    // Checklists documentaires (Paramètres → Documents) : une par famille de produit, plus « default ».
    // Lecture par tout le personnel (le télépro les voit quand il demande des documents) ; écriture par
    // l'administrateur seul, avec l'identifiant du document = la clé de la famille. Suppression = retour à « default ».
    match /cl_checklists/{id} {
      allow read: if isClStaff();
      allow create, update: if isClAdmin() && request.resource.data.id == id;
      allow delete: if isClAdmin();
    }

    // Configuration versionnée : le personnel lit les versions publiées/archivées (nécessaire pour
    // afficher les motifs, checklists…), seul l'admin voit les brouillons. Publication = fonction serveur.
    match /cl_config/{module} {
      allow read: if isClStaff();
      allow write: if false;

      match /versions/{versionId} {
        allow read: if isClAdmin()
          || (isClStaff() && resource.data.get('state', '') in ['published', 'archived']);
        allow write: if false;
      }
    }
```

## Modification 3 — la règle fourre-tout (la plus importante)

Dans `match /{collection}/{document=**}`, ajouter **une ligne** :

```
    match /{collection}/{document=**} {
      allow read, write: if signedIn()
        && !collection.matches('cl_.*')          // ← AJOUT
        && !(isMandataire() && collection in
          ['clients', 'subventions', 'retraits', 'tickets', 'ticketsJuridiques', 'historique_dossier', 'apfs', 'postFacturationSuivis', 'recouvrements']);
    }
```

Sans cette ligne, les règles de la modification 2 ne protègent rien : dans Firestore, les règles s'additionnent,
et la règle fourre-tout accorderait lecture **et écriture** sur tous les `cl_*` à n'importe quel compte connecté.

---

## Contraintes sur les requêtes (à respecter dans le code)

Firestore rejette une requête de liste dont les filtres ne prouvent pas la règle. Donc :

| Profil | Requête obligatoire |
|---|---|
| Télépro | `where('ownerId', '==', uid)` |
| Manager | `where('managerIds', 'array-contains', uid)` |
| Admin | aucune contrainte |
| Versions de config (non admin) | `where('state', 'in', ['published', 'archived'])` |

## Ce qui n'est PAS encore testé

Ces règles n'ont pas été exécutées. Avant de les déployer sur `crm-pose-dev`, je propose des tests
automatiques avec l'émulateur Firestore (`@firebase/rules-unit-testing`) qui vérifient en particulier :
un télépro ne lit pas le lead d'un autre ; un manager ne lit pas une équipe hors périmètre ;
aucune écriture directe n'est possible ; un technicien (rôle sans accès) est refusé partout ;
les collections du CRM principal restent accessibles comme avant.

---

# Règles Storage — pièces des leads (`cl_documents/`)

Fichier prêt à coller : **`firebase/storage.dev.rules`** (bâti sur les règles Storage réellement publiées sur `crm-pose-dev`).

## Ce qui est publié aujourd'hui (constaté le 9 octobre sur `crm-pose-dev`)

```
match /{allPaths=**} { allow read, write: if request.auth != null; }
```

Tout compte connecté peut lire, écrire et supprimer **n'importe quel fichier**, sans contrôle de type ni de taille.
Ce n'est pas le fichier `storage.rules` du dépôt (plus strict : comptes CRM seulement, accès client du portail limité) :
comme pour Firestore, le dépôt et la console ne disent pas la même chose.

## Ce que fait `storage.dev.rules`

| | Avant | Après |
|---|---|---|
| Lire une pièce de lead | tout compte connecté | administrateur, manager du lead, télépro propriétaire |
| Envoyer une pièce | tout compte connecté, tout fichier | les mêmes trois profils, PDF / JPEG / PNG / WebP / HEIC, 1 octet à 15 Mo |
| Modifier / supprimer une pièce | tout compte connecté | personne (une pièce remplacée est un nouveau fichier) |
| Le reste du bucket | tout compte connecté | **inchangé** |

Le serveur (clé de compte de service) n'est pas soumis aux règles : la copie des pièces vers le dossier du CRM principal continue de fonctionner.

## Pourquoi la règle par défaut est modifiée

Dans Storage, l'accès est accordé dès qu'**un** bloc l'autorise. Ajouter seulement le bloc `cl_documents/` ne protégerait rien :
la règle `{allPaths=**}` continuerait à tout ouvrir. Elle est donc découpée par opération, avec la même condition qu'avant sauf
`cl_documents/` (`get`, `create`/`update` et `delete` l'excluent ; `list` reste inchangé).

## À savoir avant de publier

- **Vérifié par moi :** le fichier se compile (`firebase deploy --only storage --dry-run`, rien n'a été publié).
- **Non vérifié par moi :** son comportement. Je n'ai pas pu lancer l'API de test de règles (droit manquant sur le compte de
  service, pas de session `gcloud`) ni l'émulateur (Java absent). Faites les essais ci-dessous dans le simulateur de la console
  *avant* de publier.
- **Production (`crm-label-pose`) :** ne collez pas ce fichier tel quel. Ses règles Storage actuelles n'ont pas été lues et peuvent
  différer (le dépôt contient une version plus stricte). Reprenez les règles publiées en production, ajoutez le bloc
  `cl_documents/` et appliquez le même découpage à leur règle par défaut.
- **Lister un dossier** reste permis à tout compte connecté : les noms de fichiers de `cl_documents/` (qui peuvent contenir le nom
  du client) restent visibles, pas leur contenu.
- **Adresses de téléchargement** (`getDownloadURL`, jeton dans l'URL) : quiconque détient l'adresse peut ouvrir le fichier, hors
  règles. Les « liens temporaires » du §15.1 ne sont pas couverts.
- **Antivirus et journal des téléchargements** (§15.1, §15.2) : non couverts par des règles, à construire.

## Essais à faire dans le simulateur de la console (Storage → Règles → Simulateur)

Choisir un identifiant de lead existant (`L`), son propriétaire `T`, et un manager `M` de son équipe.

| # | Opération | Chemin | Compte | Attendu |
|---|---|---|---|---|
| 1 | Lecture | `cl_documents/L/identity/x.pdf` | `T` (télépro propriétaire) | autorisé |
| 2 | Lecture | idem | un autre télépro | **refusé** |
| 3 | Lecture | idem | `M` (manager du lead) | autorisé |
| 4 | Lecture | idem | un compte CRM d'un autre métier (technicien) | **refusé** |
| 5 | Création, PDF 100 Ko | idem | `T` | autorisé |
| 6 | Création, `application/x-msdownload` | idem | `T` | **refusé** |
| 7 | Création, PDF 16 Mo | idem | `T` | **refusé** |
| 8 | Suppression | idem | un administrateur | **refusé** |
| 9 | Lecture / création | `dossiers/abc/documents/a.pdf` | un technicien | autorisé (comportement d'avant, inchangé) |
| 10 | Lecture | `cl_documents/L/identity/x.pdf` | sans connexion | **refusé** |

Si le 9 est refusé, ou si le 2 est autorisé, **ne publiez pas** : cela voudrait dire que la découpe de la règle par défaut
n'a pas l'effet attendu (propriétés `resource.name` / `request.resource.name`).
