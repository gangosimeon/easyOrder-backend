// Empêche les valeurs "image"/"logo" fournies par l'utilisateur de pointer
// vers des hôtes internes/privés (SSRF) — utilisé à l'écriture (validators)
// et en défense en profondeur juste avant tout fetch serveur de ces URLs
// (ex. génération d'image Open Graph). Compatible edge runtime (pas de `dns`).

const PRIVATE_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^\[?fc[0-9a-f][0-9a-f]:/i,
  /^\[?fd[0-9a-f][0-9a-f]:/i,
  /^\[?fe80:/i,
];

/**
 * `value` peut être un emoji/court libellé (pas une requête réseau), un
 * `data:` URI (rendu client uniquement, jamais fetché côté serveur), ou une
 * vraie URL http(s). Seul ce dernier cas est validé : HTTPS obligatoire,
 * hôte non privé/loopback/link-local.
 */
export function isSafeExternalImageUrl(value: string): boolean {
  if (!value) return true;
  if (!/^https?:\/\//i.test(value)) return true;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  return !PRIVATE_HOSTNAME_PATTERNS.some(re => re.test(parsed.hostname));
}
