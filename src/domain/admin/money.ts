/**
 * Saisie d'un montant en euros → centimes entiers. Accepte la virgule française, les espaces
 * (« 1 250,50 », espace insécable compris). Renvoie null pour une saisie vide, illisible ou négative :
 * jamais 0 par défaut, qui serait pris pour une dépense nulle.
 *
 * Le calcul se fait sur les CHIFFRES du texte, pas par `Number(x) * 100` : en virgule flottante,
 * 1,005 × 100 vaut 100,4999… et serait arrondi à 100 au lieu de 101.
 */
export function parseEuros(text: string): number | null {
  const cleaned = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  let cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (fraction.length > 2 && fraction[2] >= '5') cents += 1; // arrondi « demi vers le haut » sur le 3e chiffre
  return Number.isSafeInteger(cents) ? cents : null;
}
