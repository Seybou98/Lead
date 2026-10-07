# CRM Leads — Modèle de données (Phase 0)

Référence : cahier des charges V1.0, sections 3, 4, 5, 8, 10, 11, 15, 19 à 22, 24.
Le code TypeScript correspondant est dans `src/domain/` (`collections.ts`, `enums.ts`, `models.ts`).

## 1. Principes

1. **Base partagée, collections isolées.** Le CRM Leads utilise le projet Firebase `crm-label-pose` (le même que le CRM principal). Toutes ses collections sont préfixées `cl_` : le CRM principal possède déjà `leads`, `users`, `notifications`, `clients`.
2. **Même connexion que le CRM principal.** Firebase Auth, puis `users/{uid}` : le rôle (`users.role`) et le statut du compte (`users.status == 'active'`) viennent de là. Une table (`src/config/roles.ts`) traduit ces rôles en trois profils CRM Leads (`admin`, `manager`, `telepro`). Un rôle non listé (technicien, régie…) n'a aucun accès. `cl_profiles/{uid}` ne contient **que** les données propres au CRM Leads (équipe, périmètre, capacité, horaires) : jamais l'identité ni le rôle.
3. **Le lead est un document léger.** Les appels, documents et événements sont des sous-collections, plus des tableaux imbriqués comme dans l'ancien CRM (limite de 1 Mo par document, réécriture complète à chaque ajout).
4. **Deux niveaux d'écriture.** Les données **métier** (leads, actions, journal de distribution, compteurs de charge) sont écrites par le **serveur** (fonction Netlify de réception, Admin SDK) : le navigateur les lit seulement. La **configuration** (équipes, profils, campagnes, sources, dépenses, règles d'attribution) est écrite par un **administrateur depuis le navigateur**, sous contrôle des règles Firestore (rôle, champs protégés, audit en ajout seul). Les fonctions Firebase (`functions/`) restent en secours pour ramener ces écritures côté serveur.
5. **Rien n'est supprimé, tout est tracé.** Historique de lead en ajout seul, journal d'audit en ajout seul, motifs et versions de config archivés plutôt que supprimés.
6. **Dates en UTC** (Timestamp Firestore), affichées en Europe/Paris.

## 2. Arbre des collections

```
cl_profiles/{uid}                     Données opérationnelles : équipe, périmètre, capacité, statut, horaires, charge
cl_presence/{uid}                     Heartbeat de connexion (séparé : écrit très souvent)
cl_teams/{teamId}
cl_absences/{absenceId}

cl_rawLeads/{rawId}                   Payload d'origine, jamais modifié (§24.2)
cl_leads/{leadId}
   ├─ events/{eventId}                Historique immuable (statuts, notes, corrections, réattributions…)
   ├─ callAttempts/{attemptId}        Tentatives d'appel déclarées, NR1..NR5
   └─ documents/{docId}               Pièces attendues + fichier + statut
cl_actions/{actionId}                 File de travail (racine : requêtée par propriétaire + échéance)
cl_sales/{saleId}                     Vente (phases 4 et 6)
cl_conversions/{leadId}               Création client/dossier — l'id EST le leadId (idempotence)

cl_campaigns/{campaignId}
cl_sources/{sourceId}
cl_adSpend/{id}                       Dépenses (saisie, import CSV, API)

cl_distributionLog/{id}               « Pourquoi ce lead est allé à cette personne » (§19.5)
cl_audit/{id}                         Journal non modifiable des actions sensibles
cl_notifications/{id}                 Même forme que `notifications` (recipientIds)
cl_integrationLog/{id}                Journal technique des échanges externes
cl_idempotency/{key}                  Clés d'idempotence des entrées (ex. externalId d'une source)

cl_config/{module}                    Pointeur vers la version publiée
   └─ versions/{versionId}            Brouillon, publiée, archivée (payload JSON)
```

## 3. Champs essentiels du lead (`cl_leads`)

| Bloc | Champs | Règle du cahier |
|---|---|---|
| Identité | `fullName`, `phone` (E.164), `email` (minuscules), `address{line,postalCode,city,zone}` | §4.1 normalisation |
| Origine | `origin{sourceId,platform,campaignId,adsetId,adId,formId,externalId,costCents,receivedAt,rawLeadId}` | §3.1, §19.2 — **jamais réécrite** |
| Projet | `productCode`, `qualification{}`, `configVersions{}` | §21.9 chaque lead garde sa version de config |
| Propriétaire | `assignmentState` (`assigned`/`to_assign`/`buffer`), `ownerId`, `teamId`, `bufferReason`, `reassignCount` | RG01 |
| Pipeline | `status`, `subStatus`, `temperature` | §7, §9 |
| Prochaine action | `nextAction{actionId,type,dueAt,priority,reason}` (copie dénormalisée de `cl_actions`) | RG02 |
| SLA | `sla{startedAt,stoppedAt,nextAlertAt,alertCount,breachedAt,pausedMinutes}` | §5, RG03, RG17 |
| Cycle NR | `nr{attempt 0..5,cycle,lastAt,nextAt}` | §8 |
| Documents | `documents{state,expected,received,conform,mandatory,mandatoryConform,…}` | §10 — recalculé par le serveur |
| Axes (§23.9) | `commercialState`, `financialState`, `saleId` | présents dès maintenant, utilisés plus tard |
| Conversion | `conversion{state,clientId,dossierId,convertedAt}` | §11.8 chaîne d'identifiants |
| Qualité | `quality{duplicateOf,duplicateOutcome,excluded,excludedReason}` | §22.5 exclusion tracée, pas de suppression |

**Le compteur SLA n'écrit rien chaque seconde.** Le navigateur calcule l'âge à partir de `sla.startedAt`. Le serveur ne réécrit `sla.nextAlertAt` qu'à chaque alerte (chaque minute jusqu'à 5 min, puis toutes les 10 min), et seul un passage hors de `new` renseigne `sla.stoppedAt`.

## 4. Requêtes critiques et index

| Écran / moteur | Requête | Index composite |
|---|---|---|
| File du télépro | `cl_actions` : `ownerId ==` , `state == open`, tri `priority`, `dueAt` | `ownerId, state, priority, dueAt` |
| Mes leads | `cl_leads` : `ownerId ==`, `status ==` | `ownerId, status, updatedAt` |
| Cockpit manager | `cl_leads` : `managerIds array-contains uid`, `status ==` | `managerIds, status, sla.startedAt` |
| File tampon | `cl_leads` : `assignmentState == buffer`, tri `sla.startedAt` | `assignmentState, sla.startedAt` |
| Moteur d'alertes SLA (toutes les minutes) | `cl_leads` : `status == new`, `sla.nextAlertAt <=` maintenant | `status, sla.nextAlertAt` |
| Moteur de rappels | `cl_actions` : `state == open`, `dueAt <=` maintenant | `state, dueAt` |
| Doublons | `cl_leads` : `phone ==` ou `email ==` | champs simples (automatiques) |
| Journal de distribution d'un lead | `cl_distributionLog` : `leadId ==`, tri `at` | `leadId, at` |

## 5. Sécurité

Le détail et le texte exact des règles sont dans [`firebase/RULES_A_APPLIQUER.md`](../firebase/RULES_A_APPLIQUER.md).

- **Trois modifications**, toutes additives, sur les règles de la console Firebase (pas sur le `firestore.rules` du dépôt, qui est plus ancien).
- **La règle fourre-tout `/{collection}/{document=**}` doit exclure `cl_*`**, sinon tout compte connecté lirait et écrirait tous les leads : dans Firestore, les règles s'additionnent.
- **Le navigateur lit les données métier ; le serveur les écrit.** Exceptions côté navigateur : le heartbeat de présence de l'utilisateur lui-même, et les écritures de **configuration** réservées à l'administrateur (équipes, profils hors compteurs, campagnes, sources, dépenses, audit en ajout seul). Voir `firebase/firestore.dev.rules`.
- **Périmètre manager par `managerIds`** (liste d'uid dénormalisée sur le lead, l'action, le profil et le journal de distribution), pas par jointure vers l'équipe : un `get()` croisé empêcherait Firestore de prouver une requête de liste.
- **La table des rôles existe deux fois** (TypeScript et règles). Un test unitaire couvre la version TypeScript ; les règles seront testées avec l'émulateur.

| Collection | Télépro | Manager | Admin |
|---|---|---|---|
| `cl_leads` (+ events, callAttempts, documents), `cl_actions`, `cl_sales` | `ownerId == uid` | `uid ∈ managerIds` | tout |
| `cl_profiles` | le sien | son équipe (`managerIds`) | tous |
| `cl_campaigns`, `cl_sources`, `cl_adSpend` | non | lecture | lecture |
| `cl_distributionLog` | non | son périmètre | tout |
| `cl_audit`, `cl_rawLeads`, `cl_integrationLog` | non | non | lecture |
| `cl_config` | versions publiées | versions publiées | tout |
| Écriture | **aucune** | **aucune** | configuration uniquement (équipes, profils, campagnes, sources, dépenses) ; données métier : serveur |

## 6. Idempotence et concurrence

- **Entrée d'un lead** : `cl_idempotency/{sourceId}_{externalId}` — une relance de Pabbly/Meta ne crée pas un second lead.
- **Actions** : `dedupeKey` déterministe (`{leadId}:nr_attempt:3`) — le moteur peut rejouer un événement sans doubler l'action.
- **Conversion** : le document `cl_conversions/{leadId}` a pour id le leadId. Une seconde demande tombe sur le même document, retourne le résultat existant, et la même clé d'idempotence est envoyée au CRM principal (RG14).
- **Écritures concurrentes** : `lead.version` est incrémenté dans chaque transaction ; une transaction qui lit une version périmée est rejouée.

## 7. Configuration versionnée (§21)

`cl_config/{module}` pointe vers `publishedVersionId`. Les modules : `schedule`, `sla`, `assignment`, `nr`, `priorities`, `reminders`, `products`, `documents`, `reasons`, `conversion`, `communications`.

- Un **brouillon** n'est lu par aucun moteur.
- Un lead mémorise la version appliquée dans `configVersions` : changer la config n'altère pas les leads en cours.
- Un **retour arrière** crée une nouvelle version identique à l'ancienne (`revertOf`) ; rien n'est détruit.
- Une valeur de motif déjà utilisée est archivée, jamais supprimée.

## 8. Ce que j'ai volontairement laissé de côté

- **Formules** (priorité, prochaine tentative NR, éligibilité, verrou de conversion) : ce sont des fonctions pures testées unitairement, écrites en Phase 1 et 2, pas des champs.
- **Vente, signature, Floa, financement** (§23) : seuls les états et `cl_sales` sont réservés ; le détail des champs viendra avec la phase 4/6.
- **Statistiques agrégées** (KPI, entonnoir) : calculées plus tard à partir de `events`. Aucun compteur n'est stocké tant qu'on n'a pas mesuré le besoin.

## 9. Décisions prises

| Sujet | Décision |
|---|---|
| Base | Même base que le CRM principal ; développement sur **`crm-pose-dev`** (`Lead/.env` y est branché) |
| Connexion et rôles | Ceux du CRM principal (`users`) — pas de système parallèle |
| Données | On repart de zéro ; migration de l'ancien CRM plus tard |
| Maquettes | PDF dans `Lead/maquette`, captures `Lead/figure*.png` |
| Tests | Tests unitaires du moteur de priorité, des échéances et des verrous de conversion |

## 10. Reste à confirmer

1. **Correspondance des rôles** (`src/config/roles.ts`) : `administrateur` → admin, `manager` → manager, `commercial` ou `telepro` → télépro. Les rôles existants (technicien, régie, rh…) n'ont pas accès. À valider.
2. **Appliquer les 3 modifications de règles sur `crm-pose-dev`** (texte prêt), puis les tester avant la production.
3. **Fonctions serveur** dans un *codebase* séparé (`Lead/functions`, déployé avec `--only functions:leads`) pour ne jamais toucher aux fonctions du CRM principal.
