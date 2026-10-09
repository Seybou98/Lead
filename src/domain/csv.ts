// Export CSV commun (campagnes, journal). Séparateur « ; » et BOM UTF-8 : ouverture directe dans
// Excel en français.

/** Une cellule commençant par = + - @ est interprétée comme une formule par un tableur : on la neutralise. */
export function csvCell(v: string | number): string {
  let s = String(v);
  // Un nombre (même négatif) n'est jamais une formule : seul un texte est neutralisé.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return '\uFEFF' + [head.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n');
}

/** Déclenche le téléchargement d'un fichier texte dans le navigateur. */
export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
