// Normalisation des données entrantes (§4.1, §24.2 étape 3).
// Fonctions pures, sans dépendance Firebase : utilisées par les Cloud Functions ET par le navigateur.

/**
 * Téléphone → format E.164. Vise la France (clé de déduplication), accepte les autres indicatifs
 * écrits avec « + » ou « 00 ». Retourne null si le numéro n'est pas plausible : un numéro invalide
 * n'est jamais « deviné ».
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // 00… → +…
  if (!hasPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
    s = '+' + digits;
  }
  const international = hasPlus || s.startsWith('+');

  if (international) {
    // « +33 (0)6 12 34 56 78 » : le 0 de trunk ne fait pas partie du numéro
    if (digits.startsWith('330')) digits = '33' + digits.slice(3);
    if (digits.startsWith('33')) return isFrenchNational(digits.slice(2)) ? '+' + digits : null;
    // Un indicatif pays ne commence jamais par 0 ; E.164 : 8 à 15 chiffres.
    return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : null;
  }

  // Écriture nationale : 06 12 34 56 78
  if (digits.length === 10 && digits.startsWith('0')) {
    return isFrenchNational(digits.slice(1)) ? '+33' + digits.slice(1) : null;
  }
  // 33612345678 sans « + »
  if (digits.length === 11 && digits.startsWith('33')) {
    return isFrenchNational(digits.slice(2)) ? '+' + digits : null;
  }
  // 612345678 (zéro initial perdu, fréquent avec les exports tableur)
  if (digits.length === 9) {
    return isFrenchNational(digits) ? '+33' + digits : null;
  }
  return null;
}

/** 9 chiffres, premier chiffre de 1 à 9 (fixes 1-5, mobiles 6-7, numéros spéciaux 8-9). */
function isFrenchNational(nine: string): boolean {
  return /^[1-9]\d{8}$/.test(nine);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Email en minuscules, ou null si le format est invalide. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

export function normalizePostalCode(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/\s/g, '');
  return /^\d{5}$/.test(s) ? s : null;
}

/** Comparaison insensible à la casse, aux accents et aux espaces multiples. */
export function normalizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Campagne d'entretien : même règle que l'ancien CRM (nom contenant « entretien »).
 * Sur ces campagnes, le champ `product` envoyé par la source désigne l'ÉQUIPEMENT existant du
 * client (ex. « Chaudière gaz »), pas un produit à vendre.
 */
export function isMaintenanceCampaign(campaignName: unknown): boolean {
  return normalizeText(campaignName).includes('entretien');
}

/** « Jean Dupont » → prénom « Jean », nom « Dupont ». Les noms composés restent côté nom. */
export function splitFullName(fullName: unknown): { firstName: string; lastName: string } {
  const parts = (typeof fullName === 'string' ? fullName : '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function joinFullName(firstName: unknown, lastName: unknown): string {
  return [firstName, lastName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ');
}
