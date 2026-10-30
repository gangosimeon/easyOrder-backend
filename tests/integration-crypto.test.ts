import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IntegrationConfigError,
  LINK_SECRET_MAX_LENGTH,
  LINK_SECRET_SERIALIZED_MAX_LENGTH,
  LinkSecretError,
  assertIntegrationConfig,
  decryptLinkSecret,
  encryptLinkSecret,
  isIntegrationEnabled,
  linkSecretKeyId,
  reencryptLinkSecret,
} from '@/lib/integration-crypto';

/**
 * Chiffrement du secret de liaison GestStock (lot 2, J1 ; plan v14 §26 v13-D5, §27, v13-D8) : AES-256-GCM, AAD
 * liaison + boutique, format versionné, rotation des clés, configuration refusée explicitement, rien de sensible
 * dans les journaux ni dans les messages.
 */

const VARIABLES = [
  'GESTSTOCK_INTEGRATION_ENABLED',
  'GESTSTOCK_LINK_ENCRYPTION_KEY',
  'GESTSTOCK_LINK_ENCRYPTION_KEY_ID',
  'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS',
  'JWT_SECRET',
  'CACHE_INVALIDATION_SECRET',
  'SWAGGER_ACCESS_KEY',
] as const;

const CONTEXT = { linkId: '6f1c2a9e-0b7d-4c3a-9e21-5d8f7a6b4c10', shopId: '665f1b2c3d4e5f6a7b8c9d0e' };

/** Secret de liaison tel que GestStock le remet (256 bits, base64url sans remplissage). */
function linkSecret(): string {
  return randomBytes(32).toString('base64url');
}

function key(): string {
  return randomBytes(32).toString('base64');
}

describe('Chiffrement du secret de liaison', () => {
  const saved: Record<string, string | undefined> = {};
  /** Valeurs qui ne doivent jamais apparaître : clés, secrets en clair, textes chiffrés. */
  const sensitive: string[] = [];
  const output: string[] = [];
  let currentKey: string;

  function remember<T extends string>(value: T): T {
    // Une chaîne vide est « contenue » dans tout journal : rien à surveiller.
    if (value.length > 0) sensitive.push(value);
    return value;
  }

  function useKeys(current: string, id: string, old?: string): void {
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = current;
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = id;
    if (old === undefined) delete process.env.GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS;
    else process.env.GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS = old;
  }

  function refused(action: () => unknown, variable: string): IntegrationConfigError {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationConfigError);
    expect((caught as Error).message).toContain(variable);
    return caught as IntegrationConfigError;
  }

  function unreadable(serialized: string, context = CONTEXT): void {
    let caught: unknown;
    try {
      decryptLinkSecret(serialized, context);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'refus attendu').toBeInstanceOf(LinkSecretError);
    // Une seule erreur générique : la cause précise n'est que dans le journal.
    expect((caught as Error).message).toBe('Secret de liaison illisible.');
  }

  beforeEach(() => {
    for (const name of VARIABLES) saved[name] = process.env[name];
    sensitive.length = 0;
    output.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }
    currentKey = remember(key());
    useKeys(currentKey, 'k2026-10');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    // Aucun journal ne contient de clé, de secret en clair ni de texte chiffré.
    const logs = output.join('\n');
    for (const value of sensitive) expect(logs).not.toContain(value);
  });

  // --- Chiffrement ------------------------------------------------------------------------------------

  it('aller-retour : le secret déchiffré est celui chiffré', () => {
    const secret = remember(linkSecret());
    const serialized = remember(encryptLinkSecret(secret, CONTEXT));
    expect(serialized).not.toContain(secret);
    expect(decryptLinkSecret(serialized, CONTEXT)).toBe(secret);
  });

  it('format : v1.<identifiant de clé>.<IV 12 octets>.<étiquette 16 octets>.<texte chiffré>, en base64url', () => {
    const secret = remember(linkSecret());
    const serialized = remember(encryptLinkSecret(secret, CONTEXT));
    const [version, keyId, iv, tag, ciphertext, ...rest] = serialized.split('.');
    expect(rest).toEqual([]);
    expect(version).toBe('v1');
    expect(keyId).toBe('k2026-10');
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(Buffer.from(ciphertext, 'base64url')).toHaveLength(Buffer.byteLength(secret));
    expect(serialized).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(linkSecretKeyId(serialized)).toBe('k2026-10');
  });

  it('deux chiffrements du même secret : IV et textes différents', () => {
    const secret = remember(linkSecret());
    const first = remember(encryptLinkSecret(secret, CONTEXT));
    const second = remember(encryptLinkSecret(secret, CONTEXT));
    expect(first).not.toBe(second);
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
    expect(first.split('.')[4]).not.toBe(second.split('.')[4]);
  });

  it('modification de chaque caractère du texte sérialisé : refus', () => {
    const secret = remember(linkSecret());
    const serialized = remember(encryptLinkSecret(secret, CONTEXT));
    for (let i = 0; i < serialized.length; i++) {
      const replacement = serialized[i] === 'A' ? 'B' : 'A';
      unreadable(remember(serialized.slice(0, i) + replacement + serialized.slice(i + 1)));
    }
  });

  it('texte tronqué, allongé, vide ou mal formé : refus', () => {
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    for (const altered of [serialized.slice(0, -1), `${serialized}A`, `${serialized}.A`, '', 'v1....', 'n-importe-quoi']) {
      unreadable(remember(altered));
    }
  });

  it('autre liaison ou autre boutique (AAD) : refus', () => {
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    unreadable(serialized, { ...CONTEXT, linkId: '00000000-0000-0000-0000-000000000000' });
    unreadable(serialized, { ...CONTEXT, shopId: '000000000000000000000000' });
    unreadable(serialized, { linkId: CONTEXT.shopId, shopId: CONTEXT.linkId });
  });

  it('identifiants de liaison et de boutique exigés', () => {
    const secret = remember(linkSecret());
    expect(() => encryptLinkSecret(secret, { linkId: '', shopId: CONTEXT.shopId })).toThrow(LinkSecretError);
    expect(() => encryptLinkSecret(secret, { linkId: CONTEXT.linkId, shopId: '' })).toThrow(LinkSecretError);
  });

  // --- Clés et rotation --------------------------------------------------------------------------------

  it('identifiant de clé inconnu : refus', () => {
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    useKeys(remember(key()), 'k2027-01');
    unreadable(serialized);
  });

  it('ancienne clé listée : déchiffrement accepté ; rechiffrement : clé courante', () => {
    const secret = remember(linkSecret());
    const before = remember(encryptLinkSecret(secret, CONTEXT));
    const next = remember(key());
    useKeys(next, 'k2027-01', `k2026-10:${currentKey}`);
    expect(decryptLinkSecret(before, CONTEXT)).toBe(secret);

    const after = remember(reencryptLinkSecret(before, CONTEXT));
    expect(linkSecretKeyId(after)).toBe('k2027-01');
    expect(decryptLinkSecret(after, CONTEXT)).toBe(secret);
    // L'ancienne clé retirée : seul le texte rechiffré reste lisible.
    useKeys(next, 'k2027-01');
    expect(decryptLinkSecret(after, CONTEXT)).toBe(secret);
    unreadable(before);
  });

  it('une ancienne clé ne chiffre jamais', () => {
    useKeys(remember(key()), 'k2027-01', `k2026-10:${currentKey}`);
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    expect(linkSecretKeyId(serialized)).toBe('k2027-01');
  });

  // --- Configuration -----------------------------------------------------------------------------------

  it('intégration désactivée (par défaut) : aucune validation, aucun refus de configuration', () => {
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = 'mal formée';
    expect(isIntegrationEnabled()).toBe(false);
    expect(() => assertIntegrationConfig()).not.toThrow();
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'false';
    expect(() => assertIntegrationConfig()).not.toThrow();
  });

  it('intégration désactivée : chiffrer ou déchiffrer est refusé explicitement', () => {
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;
    refused(() => encryptLinkSecret('x'.repeat(43), CONTEXT), 'GESTSTOCK_INTEGRATION_ENABLED');
    refused(() => decryptLinkSecret(serialized, CONTEXT), 'GESTSTOCK_INTEGRATION_ENABLED');
  });

  it('activée, clé absente : refus explicite nommant la variable', () => {
    delete process.env.GESTSTOCK_LINK_ENCRYPTION_KEY;
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_KEY');
    refused(() => encryptLinkSecret(linkSecret(), CONTEXT), 'GESTSTOCK_LINK_ENCRYPTION_KEY');
  });

  it.each([
    ['mal formée', 'pas du base64 !'],
    ['16 octets', randomBytes(16).toString('base64')],
    ['33 octets', randomBytes(33).toString('base64')],
    ['base64url au lieu de base64', randomBytes(32).toString('base64url')],
  ])('activée, clé %s : refus explicite, sans la valeur', (_label, value) => {
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = remember(value);
    const error = refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_KEY');
    expect(error.message).not.toContain(value);
  });

  it('activée, identifiant de clé absent ou mal formé : refus explicite', () => {
    delete process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID;
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_KEY_ID');
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = 'avec.point';
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_KEY_ID');
  });

  it.each(['JWT_SECRET', 'CACHE_INVALIDATION_SECRET', 'SWAGGER_ACCESS_KEY'])(
    'activée, clé égale à %s : refus (v13-D8), sans la valeur',
    (other) => {
      process.env[other] = currentKey;
      const error = refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_KEY');
      expect(error.message).toContain(other);
      expect(error.message).not.toContain(currentKey);
    }
  );

  it('ancienne clé égale à JWT_SECRET, mal formée ou au même identifiant que la clé courante : refus', () => {
    const old = remember(key());
    process.env.JWT_SECRET = old;
    useKeys(currentKey, 'k2026-10', `k2025-01:${old}`);
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS');
    process.env.JWT_SECRET = 'secret-de-test-uniquement';
    useKeys(currentKey, 'k2026-10', 'k2025-01:trop-court');
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS');
    useKeys(currentKey, 'k2026-10', `k2026-10:${remember(key())}`);
    refused(() => assertIntegrationConfig(), 'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS');
  });

  // --- Journaux, messages et longueurs -----------------------------------------------------------------

  it('refus de déchiffrement : cause précise dans le journal, sans aucune valeur sensible', () => {
    const serialized = remember(encryptLinkSecret(remember(linkSecret()), CONTEXT));
    unreadable(serialized, { ...CONTEXT, shopId: '000000000000000000000000' });
    useKeys(remember(key()), 'k2027-01');
    unreadable(serialized);
    unreadable(remember('v9.k.AAAA.AAAA.AAAA'));
    const logs = output.join('\n');
    expect(logs).toContain('authentification');
    expect(logs).toContain('clé inconnue');
    expect(logs).toContain('format');
    expect(logs).toContain(CONTEXT.linkId);
  });

  it('longueur maximale : secret trop long refusé ; texte sérialisé trop long refusé avant analyse', () => {
    const longest = remember('s'.repeat(LINK_SECRET_MAX_LENGTH));
    const serialized = remember(encryptLinkSecret(longest, CONTEXT));
    expect(serialized.length).toBeLessThanOrEqual(LINK_SECRET_SERIALIZED_MAX_LENGTH);
    expect(decryptLinkSecret(serialized, CONTEXT)).toBe(longest);

    let caught: unknown;
    try {
      encryptLinkSecret(remember('s'.repeat(LINK_SECRET_MAX_LENGTH + 1)), CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LinkSecretError);
    expect((caught as Error).message).not.toContain('sss');
    expect(() => encryptLinkSecret('', CONTEXT)).toThrow(LinkSecretError);
    unreadable(remember(`${serialized}${'A'.repeat(LINK_SECRET_SERIALIZED_MAX_LENGTH)}`));
  });
});
