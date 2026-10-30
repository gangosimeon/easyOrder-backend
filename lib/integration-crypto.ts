import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Logger } from '@/lib/logger';

/**
 * Chiffrement du secret de liaison remis par GestStock (intégration GestStock, lot 2, J1 ; plan v14 §26 v13-D5,
 * §27, v13-D8). Module `crypto` de Node seulement.
 *
 * **Algorithme** : AES-256-GCM, IV aléatoire de 12 octets à chaque chiffrement, étiquette de 16 octets. Données
 * associées (AAD) : version, identifiant de clé, identifiant de la liaison et identifiant de la boutique, sérialisés
 * sans ambiguïté (tableau JSON). Un texte chiffré déplacé vers une autre liaison ou une autre boutique, ou dont l'en-
 * tête est modifié, ne se déchiffre pas.
 *
 * **Format sérialisé** (version 1) : `v1.<keyId>.<iv>.<tag>.<ciphertext>` ; IV, étiquette et texte chiffré en base64url
 * sans remplissage (forme canonique exigée). Secret : 1 à {@link LINK_SECRET_MAX_LENGTH} caractères ; texte
 * sérialisé : {@link LINK_SECRET_SERIALIZED_MAX_LENGTH} caractères au plus, vérifié avant toute analyse.
 *
 * **Clés** (environnement du VPS seulement, jamais dans Git ni dans MongoDB) :
 * - `GESTSTOCK_INTEGRATION_ENABLED` : `true` pour activer ; désactivée par défaut ;
 * - `GESTSTOCK_LINK_ENCRYPTION_KEY` : clé courante, 32 octets en base64 (`openssl rand -base64 32`) ; seule à chiffrer ;
 * - `GESTSTOCK_LINK_ENCRYPTION_KEY_ID` : son identifiant (1 à 32 caractères `A-Z a-z 0-9 _ -`, par exemple `k2026-10`) ;
 * - `GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS` : anciennes clés, pour le déchiffrement seulement :
 *   `id1:base64,id2:base64` (facultatif).
 *
 * Aucune clé n'est égale à un autre secret de l'application (v13-D8 : aucun secret d'intégration ne réutilise un
 * secret existant). **Rotation** : nouvelle clé et nouvel identifiant en clé courante, l'ancienne passe dans
 * `GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS` ; les secrets sont rechiffrés ({@link reencryptLinkSecret}, à la lecture ou
 * par un script) ; l'ancienne clé n'est retirée qu'une fois plus aucun texte ne la cite ({@link linkSecretKeyId}).
 *
 * **Configuration** : validée à la première utilisation (comme `JWT_SECRET` dans `lib/auth.ts` et `MONGODB_URI`
 * dans `lib/db.ts`), relue à chaque appel ; {@link assertIntegrationConfig} permet un contrôle explicite. Refus :
 * {@link IntegrationConfigError}, dont le message nomme la variable, jamais sa valeur.
 *
 * **Erreurs de déchiffrement** : une seule erreur générique ({@link LinkSecretError}, « Secret de liaison
 * illisible. ») ; la cause (format, version, clé inconnue, authentification) n'est que dans le journal, avec les
 * identifiants de la liaison et de la boutique, jamais une clé, un secret ni un texte chiffré.
 */

export const LINK_SECRET_FORMAT_VERSION = 'v1';

/** Longueur maximale du secret en clair (contrat : `link_secret`, 256 caractères au plus). */
export const LINK_SECRET_MAX_LENGTH = 256;

/** Longueur maximale du texte sérialisé : en-tête et secret le plus long tiennent largement (environ 420). */
export const LINK_SECRET_SERIALIZED_MAX_LENGTH = 512;

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CONTEXT_MAX_LENGTH = 200;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const ENABLED = 'GESTSTOCK_INTEGRATION_ENABLED';
const KEY = 'GESTSTOCK_LINK_ENCRYPTION_KEY';
const KEY_ID_VARIABLE = 'GESTSTOCK_LINK_ENCRYPTION_KEY_ID';
const OLD_KEYS = 'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS';

/** Autres secrets de l'application : une clé d'intégration ne leur est jamais égale (v13-D8). */
const OTHER_SECRETS = [
  'JWT_SECRET',
  'CACHE_INVALIDATION_SECRET',
  'SWAGGER_ACCESS_KEY',
  'CLOUDINARY_API_SECRET',
  'VAPID_PRIVATE_KEY',
  'RESEND_API_KEY',
] as const;

/** Liaison et boutique auxquelles le secret appartient (données associées). */
export interface LinkSecretContext {
  linkId: string;
  shopId: string;
}

/** Configuration de l'intégration refusée : le message nomme la variable, jamais sa valeur. */
export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

/** Secret de liaison refusé ou illisible : message générique, sans aucune valeur. */
export class LinkSecretError extends Error {
  constructor(message = 'Secret de liaison illisible.') {
    super(message);
    this.name = 'LinkSecretError';
  }
}

interface KeyRing {
  currentId: string;
  keys: Map<string, Buffer>;
}

/** Interrupteur de l'intégration : `true` seulement si la variable vaut exactement `true`. */
export function isIntegrationEnabled(): boolean {
  return process.env[ENABLED]?.trim() === 'true';
}

/** Contrôle explicite de la configuration : rien si l'intégration est désactivée. */
export function assertIntegrationConfig(): void {
  if (isIntegrationEnabled()) keyRing();
}

/** Chiffre le secret de liaison avec la clé courante. */
export function encryptLinkSecret(secret: string, context: LinkSecretContext): string {
  const ring = enabledKeyRing();
  checkContext(context);
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > LINK_SECRET_MAX_LENGTH) {
    throw new LinkSecretError(`Secret de liaison invalide : 1 à ${LINK_SECRET_MAX_LENGTH} caractères.`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, ring.keys.get(ring.currentId)!, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(ring.currentId, context));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    LINK_SECRET_FORMAT_VERSION,
    ring.currentId,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Déchiffre un secret de liaison (clé courante ou ancienne clé listée). */
export function decryptLinkSecret(serialized: string, context: LinkSecretContext): string {
  const ring = enabledKeyRing();
  checkContext(context);
  const parsed = parse(serialized);
  if (!parsed) return unreadable('format', context);
  const key = ring.keys.get(parsed.keyId);
  if (!key) return unreadable('clé inconnue', context);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(parsed.keyId, context));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Étiquette invalide, AAD différentes ou texte modifié : indiscernables en GCM.
    return unreadable('authentification', context);
  }
}

/** Rechiffre avec la clé courante un texte chiffré par une clé courante ou ancienne (rotation). */
export function reencryptLinkSecret(serialized: string, context: LinkSecretContext): string {
  return encryptLinkSecret(decryptLinkSecret(serialized, context), context);
}

/** Identifiant de la clé qui a chiffré ce texte, ou `null` s'il est mal formé (suivi de la rotation). */
export function linkSecretKeyId(serialized: string): string | null {
  return parse(serialized)?.keyId ?? null;
}

// --- Format --------------------------------------------------------------------------------------------

interface Parsed {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parse(serialized: unknown): Parsed | null {
  if (typeof serialized !== 'string' || serialized.length === 0 || serialized.length > LINK_SECRET_SERIALIZED_MAX_LENGTH) {
    return null;
  }
  const parts = serialized.split('.');
  if (parts.length !== 5 || parts[0] !== LINK_SECRET_FORMAT_VERSION || !KEY_ID.test(parts[1])) return null;
  const iv = canonicalBase64url(parts[2]);
  const tag = canonicalBase64url(parts[3]);
  const ciphertext = canonicalBase64url(parts[4]);
  if (!iv || !tag || !ciphertext || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  if (ciphertext.length === 0 || ciphertext.length > LINK_SECRET_MAX_LENGTH * 4) return null;
  return { keyId: parts[1], iv, tag, ciphertext };
}

/** base64url sans remplissage, sous sa seule forme canonique (sinon deux textes différents donneraient les mêmes octets). */
function canonicalBase64url(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function aad(keyId: string, context: LinkSecretContext): Buffer {
  return Buffer.from(JSON.stringify(['geststock-link-secret', LINK_SECRET_FORMAT_VERSION, keyId, context.linkId, context.shopId]));
}

function checkContext(context: LinkSecretContext): void {
  const valid = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= CONTEXT_MAX_LENGTH;
  if (!context || !valid(context.linkId) || !valid(context.shopId)) {
    throw new LinkSecretError('Identifiants de la liaison et de la boutique exigés.');
  }
}

/** Refus générique ; la cause, sans valeur sensible, seulement dans le journal. */
function unreadable(cause: string, context: LinkSecretContext): never {
  Logger.warn(`Secret de liaison illisible (${cause}) : liaison ${context.linkId}.`, { shopId: context.shopId });
  throw new LinkSecretError();
}

// --- Configuration -------------------------------------------------------------------------------------

function enabledKeyRing(): KeyRing {
  if (!isIntegrationEnabled()) {
    throw new IntegrationConfigError(`Intégration GestStock désactivée (${ENABLED}).`);
  }
  return keyRing();
}

function keyRing(): KeyRing {
  const currentId = process.env[KEY_ID_VARIABLE]?.trim();
  if (!currentId || !KEY_ID.test(currentId)) {
    throw new IntegrationConfigError(
      `${KEY_ID_VARIABLE} est absente ou mal formée : 1 à 32 caractères parmi A-Z, a-z, 0-9, _ et -.`
    );
  }
  const raw = process.env[KEY]?.trim();
  if (!raw) throw new IntegrationConfigError(`${KEY} est absente : clé de 32 octets en base64 exigée.`);
  const keys = new Map<string, Buffer>([[currentId, decodeKey(raw, KEY)]]);

  const old = process.env[OLD_KEYS]?.trim();
  if (old) {
    for (const entry of old.split(',')) {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (separator < 0 || !KEY_ID.test(id) || keys.has(id)) {
        throw new IntegrationConfigError(
          `${OLD_KEYS} est mal formée : « identifiant:clé » séparés par des virgules, identifiants distincts de ${KEY_ID_VARIABLE}.`
        );
      }
      keys.set(id, decodeKey(value, OLD_KEYS));
    }
  }
  return { currentId, keys };
}

/** Clé de 32 octets en base64 (forme canonique), différente de tout autre secret de l'application. */
function decodeKey(value: string, variable: string): Buffer {
  const bytes = BASE64.test(value) ? Buffer.from(value, 'base64') : null;
  if (!bytes || bytes.length !== KEY_BYTES || bytes.toString('base64') !== value) {
    throw new IntegrationConfigError(`${variable} est mal formée : clé de ${KEY_BYTES} octets en base64 exigée.`);
  }
  for (const other of OTHER_SECRETS) {
    const secret = process.env[other]?.trim();
    if (secret && (secret === value || Buffer.from(secret, 'utf8').equals(bytes))) {
      throw new IntegrationConfigError(`${variable} est égale à ${other} : une clé d'intégration propre est exigée (v13-D8).`);
    }
  }
  return bytes;
}
