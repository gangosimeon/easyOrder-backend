import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

/**
 * En-têtes CORS de l'API (next.config.mjs, seul endroit où le CORS est défini ; le middleware n'ajoute que des
 * en-têtes de sécurité). J5 : `Retry-After` lisible par l'écran Angular (autre origine) sur les 429.
 */
describe('Configuration Next : CORS de l’API', () => {
  async function apiHeaders(): Promise<Record<string, string>> {
    const rules = await nextConfig.headers!();
    const api = rules.find((rule) => rule.source === '/api/:path*');
    expect(api).toBeDefined();
    return Object.fromEntries(api!.headers.map((h) => [h.key, h.value]));
  }

  it('expose Retry-After aux réponses de l’API, et rien d’autre', async () => {
    const headers = await apiHeaders();
    expect(headers['Access-Control-Expose-Headers']).toBe('Retry-After');
  });

  it('origines, méthodes, en-têtes et identifiants autorisés inchangés', async () => {
    const headers = await apiHeaders();
    expect(Object.keys(headers).sort()).toEqual([
      'Access-Control-Allow-Credentials',
      'Access-Control-Allow-Headers',
      'Access-Control-Allow-Methods',
      'Access-Control-Allow-Origin',
      'Access-Control-Expose-Headers',
    ]);
    expect(headers['Access-Control-Allow-Origin']).toBe(process.env.FRONTEND_URL || 'http://localhost:4200');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type,Authorization');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('les autres règles ne reçoivent pas l’en-tête', async () => {
    const rules = await nextConfig.headers!();
    for (const rule of rules.filter((r) => r.source !== '/api/:path*')) {
      expect(rule.headers.map((h) => h.key)).not.toContain('Access-Control-Expose-Headers');
    }
  });
});
