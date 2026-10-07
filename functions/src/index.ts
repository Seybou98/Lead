// Fonctions Firebase du CRM Leads — chemin de SECOURS.
//
// Le chemin principal est : écritures d'administration directes depuis le navigateur, et ingestion des
// leads par la fonction Netlify (netlify/functions/ingest-lead.ts). Ces fonctions restent prêtes à être
// déployées (voir deploy-bundle/) si on veut un jour des écritures non falsifiables ou un déploiement
// 100 % Google Cloud. Elles appliquent exactement les mêmes règles que le chemin principal.

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { ingestLead as runIngestion } from './ingest';
import { handleIngestHttp, resolveSourceId } from './http';
import { saveSpend, updateCampaignAssignmentConfig, updateProfile, upsertCampaign, upsertSource, upsertTeam } from './admin';

if (!getApps().length) initializeApp();
const db = getFirestore();
// Les champs `undefined` (ex. une raison absente) sont ignorés au lieu de faire échouer l'écriture.
db.settings({ ignoreUndefinedProperties: true });

/** Secret partagé avec Pabbly / Meta. À définir : firebase functions:secrets:set CL_INGEST_SECRET */
const INGEST_SECRET = defineSecret('CL_INGEST_SECRET');

const REGION = 'europe-west1';

/**
 * Point d'entrée des leads (Pabbly, Meta, formulaires, agences).
 *   POST https://<région>-<projet>.cloudfunctions.net/ingestLead?source=<idSource>
 *   En-tête : X-CRM-SECRET: <secret>
 *   Corps   : JSON ou formulaire (x-www-form-urlencoded)
 * Codes de retour : voir functions/src/http.ts.
 */
export const ingestLead = onRequest(
  { region: REGION, secrets: [INGEST_SECRET], timeoutSeconds: 60, memory: '256MiB', maxInstances: 10, cors: false },
  async (req, res) => {
    const out = await handleIngestHttp(
      {
        method: req.method,
        secret: req.get('x-crm-secret'),
        sourceId: resolveSourceId(req.query.source, req.get('x-source-id')),
        parsedBody: req.body,
      },
      {
        expectedSecret: INGEST_SECRET.value(),
        run: ({ sourceId, payload }) => runIngestion(db, { channel: 'webhook', sourceId, payload, nowMs: Date.now() }),
        log: { warn: (m, meta) => logger.warn(m, { ip: req.ip, meta }), error: (m, meta) => logger.error(m, meta) },
      }
    );
    res.status(out.status).json(out.body);
  }
);

// ── Administration ───────────────────────────────────────────────────────────
// Appelables depuis l'application par un administrateur connecté (contrôle du rôle côté serveur).
// Utilisées seulement si l'application est réglée en VITE_ADMIN_WRITE_MODE=functions.
const ADMIN_OPTS = { region: REGION, timeoutSeconds: 60, memory: '256MiB' as const, maxInstances: 5 };

export const adminUpsertTeam = onCall(ADMIN_OPTS, (req) => upsertTeam(db, req));
export const adminUpdateProfile = onCall(ADMIN_OPTS, (req) => updateProfile(db, req));
export const adminUpsertSource = onCall(ADMIN_OPTS, (req) => upsertSource(db, req));
export const adminUpsertCampaign = onCall(ADMIN_OPTS, (req) => upsertCampaign(db, req));
export const adminSaveSpend = onCall(ADMIN_OPTS, (req) => saveSpend(db, req));
export const adminUpdateAssignmentConfig = onCall(ADMIN_OPTS, (req) => updateCampaignAssignmentConfig(db, req));
