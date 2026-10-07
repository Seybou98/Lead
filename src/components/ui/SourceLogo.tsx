import { Building2, Globe, PenLine, Upload } from 'lucide-react';

/** Logo Meta (symbole « infini ») simplifié, à la taille du texte. */
function MetaLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 18" className={className} aria-hidden="true" fill="none" stroke="#0866FF" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14.5c-3 0-5-2.7-5-5.5S6 3.5 9 3.5c2.4 0 4.2 1.7 6.4 5.1l5.2 5.8c1.1 1.3 2.2 1.6 3.4 1.6 3 0 5-2.7 5-5.5S27 3.5 24 3.5c-2.4 0-4.2 1.7-6.4 5.1l-5.2 5.8c-1.1 1.3-2.2 1.6-3.4 1.6z" />
    </svg>
  );
}

/** Logo Google « G » en quatre couleurs, simplifié. */
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M23 12.27c0-.8-.07-1.56-.2-2.3H12v4.35h6.17a5.27 5.27 0 0 1-2.29 3.46v2.87h3.7C21.74 18.65 23 15.7 23 12.27z" />
      <path fill="#34A853" d="M12 23.5c3.1 0 5.7-1.03 7.6-2.8l-3.7-2.87c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.76H1.73v2.96A11.5 11.5 0 0 0 12 23.5z" />
      <path fill="#FBBC05" d="M5.55 14.17a6.9 6.9 0 0 1 0-4.34V6.87H1.73a11.5 11.5 0 0 0 0 10.26l3.82-2.96z" />
      <path fill="#EA4335" d="M12 5.07c1.69 0 3.2.58 4.4 1.72l3.3-3.3A11.05 11.05 0 0 0 12 .5 11.5 11.5 0 0 0 1.73 6.87l3.82 2.96C6.46 7.1 9 5.07 12 5.07z" />
    </svg>
  );
}

/** Logo d'une source : Meta et Google ont le leur ; les autres types une icône neutre. Jamais seul : toujours suivi du nom. */
export function SourceLogo({ kind, className = 'h-4 w-5' }: { kind: string; className?: string }) {
  switch (kind) {
    case 'meta':
      return <MetaLogo className={className} />;
    case 'google':
      return <GoogleLogo className={className} />;
    case 'site':
      return <Globe className={`${className} text-slate-500`} aria-hidden="true" />;
    case 'agency':
      return <Building2 className={`${className} text-slate-500`} aria-hidden="true" />;
    case 'import':
      return <Upload className={`${className} text-slate-500`} aria-hidden="true" />;
    default:
      return <PenLine className={`${className} text-slate-500`} aria-hidden="true" />;
  }
}
