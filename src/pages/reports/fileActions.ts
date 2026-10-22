import { downloadText } from '../../domain/csv';

/** Impression d'un document HTML (« Enregistrer au format PDF » du navigateur) sans ouvrir de fenêtre : un cadre invisible. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) {
    frame.remove();
    throw new Error('Impression indisponible dans ce navigateur.');
  }
  doc.open();
  doc.write(html);
  doc.close();
  const win = frame.contentWindow;
  window.setTimeout(() => {
    win.focus();
    win.print();
    window.setTimeout(() => frame.remove(), 60_000);
  }, 200);
}

/** Fichier reçu du serveur : un CSV se télécharge, une page imprimable s'imprime (ou s'enregistre en PDF). */
export function deliverFile(f: { filename: string; mime: string; content: string }): void {
  if (f.mime.startsWith('text/html')) printHtml(f.content);
  else downloadText(f.filename, f.content, f.mime);
}
