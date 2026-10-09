# Ce que le CRM Leads reprend du CRM principal

Le CRM Leads se déploie **seul** (site Netlify propre, dossier `Lead`). Il n'importe aucun fichier du CRM principal :
tout ce qui en est repris est **copié dans `Lead/`**. Vérifié en compilant, construisant et testant une copie de `Lead`
placée hors du projet, sans le CRM principal à côté.

## Code copié (à tenir à jour si le CRM principal change)

| Dans `Lead/` | Repris de (CRM principal) | Rôle |
|---|---|---|
| `src/domain/conversion/dossierPayload.ts` | `src/components/clients/components/new-client-modal.tsx` (`handleImportedDossierSubmit`), `src/lib/utils/dossier-status.ts`, `src/lib/dossier-auto-calculations.ts`, `src/lib/utils/search-index.ts` | Charge utile du dossier et de la subvention créés à la transmission : statut, zones, catégories MPR/CEE, numéro à 7 chiffres, index de recherche, opérations |
| `src/domain/conversion/parcel.ts` | `src/lib/hooks/useParcelCadastrale.ts`, `src/utils/parcel.ts` | Parcelle cadastrale automatique d'après l'adresse (service public de l'IGN, sans clé) |
| `src/domain/products/catalog.ts` | `products.category` | Familles de produits |

Pas repris : le barème MPR automatique (`mpr-aid-matrix`) — le montant d'aide vient du montage ; la création de client
(`clients`) — le CRM principal la fait quand le dossier est validé.

## Données partagées (même base Firebase, pas du code)

Lues : `products` (articles, prix, famille), `users` (rôle, nom), `dossiers` (détection de doublon).
Écrites à la transmission : `dossiers`, `subventions`, `historique_dossier`, `dossiers/<id>/documents` et les fichiers
`dossiers/<id>/documents/…` dans Storage. Tout le reste est dans les collections `cl_*` du CRM Leads.

Ces écritures supposent que le CRM Leads et le CRM principal pointent sur **la même base** (décision du projet). Si un
jour ils sont séparés, la transmission devra passer par une API du CRM principal.

## Scripts d'aide

Les scripts de `Lead/scripts/` lisent la clé de compte de service dans `Lead/service-account.json` (ignoré par git).


## Statuts relus du CRM principal (retour des statuts, §24.8)

Copiés dans `src/domain/mainSync/mainStatus.ts` ; à mettre à jour si le CRM principal change ses valeurs :
- `dossiers.status` : incomplet, complet, valide, brouillon, complement_demande, complement_traite, abandonner
  (source : `src/lib/utils/dossier-status.ts`) ;
- `clients.status` : aprogrammer, placer, confirmer, preparer, charger, encours, commencer, terminer, facturer_mpr,
  facturer_cee, facturer_cee_mpr, adecaler, annuler, infaisable (source : `src/components/projects/projects.tsx`,
  `src/lib/utils/promote-dossier-to-client.ts`) ;
- `subventions.dossier.statut` : controle_admin_valider, incomplet_a_completer.
Lecture seule : le CRM Leads n'écrit jamais dans ces documents.
