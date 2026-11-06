import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import { connectDB } from '@/lib/db';
import GeststockLink from '@/models/geststock-link.model';
import { PATCH } from '@/app/api/admin/shops/[id]/toggle-ban/route';

/**
 * Route PATCH /api/admin/shops/[id]/toggle-ban (lot 3, J12.1) :
 * révocation automatique de la liaison GestStock active quand une boutique est bannie.
 */

describe('Admin toggle-ban + révocation JCMB (lot 3, J12.1)', () => {
  beforeAll(async () => {
    await connectDB();
    await GeststockLink.init();
  });

  /** Crée un admin en DB et retourne son JWT. */
  async function createAdminToken(): Promise<string> {
    const admin = await mongoose.connection.collection('users').insertOne({
      name: 'Admin',
      phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
      countryCode: '226', password: 'hashed', role: 'admin',
      slug: 'admin-' + new mongoose.Types.ObjectId().toString(),
      tokenVersion: 0,
    });
    return jwt.sign(
      { userId: admin.insertedId.toString(), phone: '70000000', role: 'admin', slug: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET ?? 'secret-de-test-uniquement',
    );
  }

  /** Crée un utilisateur boutique en DB et retourne son ObjectId string. */
  async function createShop(): Promise<string> {
    const shop = await mongoose.connection.collection('users').insertOne({
      name: 'Boutique',
      phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
      countryCode: '226', password: 'hashed', role: 'user',
      slug: 'shop-ban-' + new mongoose.Types.ObjectId().toString(),
      tokenVersion: 0,
    });
    return shop.insertedId.toString();
  }

  it('ban boutique avec liaison ACTIVE → liaison REVOKED en DB', async () => {
    const adminToken = await createAdminToken();
    const shopId     = await createShop();
    const linkId     = randomUUID();

    await GeststockLink.create({
      shopId:               new mongoose.Types.ObjectId(shopId),
      activeShopId:         new mongoose.Types.ObjectId(shopId),
      linkId,
      status:               'ACTIVE',
      companyCode:          'TST',
      companyName:          null,
      currency:             'XOF',
      scopes:               ['catalog:read'],
      warehouses:           [],
      linkedAt:             new Date(),
      lastStateSyncAt:      null,
      revokedAt:            null,
      suspensionReason:     null,
      revocationReason:     null,
      pendingSecretCreatedAt: null,
      encryptedSecret:      'dummy-encrypted-secret-for-test',
    });

    const req = new Request('http://localhost/api/admin/shops/' + shopId + '/toggle-ban', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ banned: true }),
    });
    const resp = await PATCH(req, { params: Promise.resolve({ id: shopId }) });
    expect(resp.status).toBe(200);

    const link = await GeststockLink.findOne({ linkId }).lean();
    expect(link?.status).toBe('REVOKED');
  });

  it('ban boutique sans liaison → aucune erreur, réponse 200', async () => {
    const adminToken = await createAdminToken();
    const shopId     = await createShop();

    const req = new Request('http://localhost/api/admin/shops/' + shopId + '/toggle-ban', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ banned: true }),
    });
    const resp = await PATCH(req, { params: Promise.resolve({ id: shopId }) });
    expect(resp.status).toBe(200);
  });

  it('déban boutique → liaison active non révoquée', async () => {
    const adminToken = await createAdminToken();
    const shopId     = await createShop();
    const linkId     = randomUUID();

    await GeststockLink.create({
      shopId:               new mongoose.Types.ObjectId(shopId),
      activeShopId:         new mongoose.Types.ObjectId(shopId),
      linkId,
      status:               'ACTIVE',
      companyCode:          'TST2',
      companyName:          null,
      currency:             'XOF',
      scopes:               [],
      warehouses:           [],
      linkedAt:             new Date(),
      lastStateSyncAt:      null,
      revokedAt:            null,
      suspensionReason:     null,
      revocationReason:     null,
      pendingSecretCreatedAt: null,
      encryptedSecret:      'dummy-encrypted-secret-for-test',
    });

    const req = new Request('http://localhost/api/admin/shops/' + shopId + '/toggle-ban', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ banned: false }),
    });
    const resp = await PATCH(req, { params: Promise.resolve({ id: shopId }) });
    expect(resp.status).toBe(200);

    // La liaison doit rester ACTIVE (on dé-banne, pas on banne)
    const link = await GeststockLink.findOne({ linkId }).lean();
    expect(link?.status).toBe('ACTIVE');
  });
});
