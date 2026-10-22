// Export CSV commun (campagnes, journal). La mise en forme est dans csvFormat.ts (aussi utilisée par le serveur) ;
// ce fichier ajoute le téléchargement dans le navigateur.

export { csvCell, toCsv } from './csvFormat';

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
