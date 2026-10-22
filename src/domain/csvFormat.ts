// Mise en forme CSV, sans accès au navigateur : utilisée aussi côté serveur (rapports programmés). Séparateur « ; » et
// BOM UTF-8 : ouverture directe dans Excel en français.

/** Une cellule commençant par = + - @ est interprétée comme une formule par un tableur : on la neutralise. */
export function csvCell(v: string | number): string {
  let s = String(v);
  // Un nombre (même négatif) n'est jamais une formule : seul un texte est neutralisé.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return '﻿' + [head.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n');
}
