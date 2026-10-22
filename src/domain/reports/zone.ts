// Zone géographique d'un lead : département de son code postal (partagé par les rapports et le cockpit).

/** Département (2 chiffres, 3 en outre-mer) ; « Inconnue » si le code postal est absent ou illisible. */
export function zoneOf(postalCode: string): string {
  const cp = (postalCode ?? '').replace(/\s/g, '');
  if (!/^\d{5}$/.test(cp)) return 'Inconnue';
  return cp.startsWith('97') || cp.startsWith('98') ? cp.slice(0, 3) : cp.slice(0, 2);
}
