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
