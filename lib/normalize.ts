/**
 * Normalise un nom pour les comparaisons d'unicité insensibles à la casse
 * (ex : noms de catégorie au sein d'une même boutique). Ne supprime pas les
 * accents — "Beauté" et "Beaute" restent volontairement distincts, sauf
 * règle métier explicite contraire.
 */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
