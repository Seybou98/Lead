// Historique des exports récents (fig. 34), conservé dans CE navigateur seulement : aucun fichier n'est stocké côté
// serveur en V1. Les exports de données personnelles sont, eux, tracés dans le journal d'audit (administrateur).

import type { ExportFormat, ExportKind } from '../../domain/reports/exports';

export interface ExportLogEntry {
  id: string;
  atMs: number;
  kind: ExportKind;
  title: string;
  format: ExportFormat;
  period: string;
  mode: string;
  /** Lignes du fichier, dont le détail des leads. */
  rows: number;
  detailCount: number;
  identifying: boolean;
}

const KEY = (uid: string) => `cl_export_history_${uid}`;
const MAX = 10;

export function readExportHistory(uid: string): ExportLogEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY(uid));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as ExportLogEntry[]).filter((e) => e && typeof e.id === 'string' && typeof e.atMs === 'number').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function addExportHistory(uid: string, entry: ExportLogEntry): ExportLogEntry[] {
  const next = [entry, ...readExportHistory(uid)].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY(uid), JSON.stringify(next));
  } catch {
    /* stockage indisponible : l'historique n'est pas conservé, l'export a bien eu lieu */
  }
  return next;
}
