import mongoose from 'mongoose';

import { decryptLinkSecret, encryptLinkSecret } from '@/lib/integration-crypto';
import { Logger } from '@/lib/logger';
import GeststockLink, { GeststockLinkStatus, IGeststockLink } from '@/models/geststock-link.model';

/**
 * Accès aux liaisons GestStock (intégration GestStock, lot 2, J2). Le secret de liaison est chiffré ici, à
 * l'enregistrement (J1, AAD : liaison + boutique) : aucun appelant ne manipule de texte chiffré, et aucun résultat
 * ne le contient (vue construite champ par champ). Changements d'état : mises à jour conditionnelles sur le statut
 * courant, une seule instruction MongoDB chacune (atomiques sur un document, sans transaction).
 */

/** Dépôt vendable de la liaison, tel que renvoyé par `GET /link`. */
export interface LinkWarehouse {
  warehouseId: string;
  name: string;
  active: boolean;
  priority?: number;
}

/** Liaison à enregistrer après l'échange du code (déjà ACTIVE côté GestStock). */
export interface NewGeststockLink {
  shopId: string;
  linkId: string;
  companyCode: string;
  companyName?: string | null;
  currency: string;
  scopes: string[];
  warehouses: LinkWarehouse[];
  linkedAt: Date;
  /** Secret de liaison remis une seule fois par GestStock : chiffré avant tout enregistrement. */
  secret: string;
}

/** État de la liaison lu chez GestStock (`GET /link`, ou un refus `LINK_REVOKED`). */
export interface RemoteLinkState {
  status: string;
  suspensionReason?: string | null;
  revocationReason?: string | null;
  currency?: string;
  scopes?: string[];
  warehouses?: LinkWarehouse[];
  revokedAt?: Date | null;
  syncedAt: Date;
}

/** Liaison telle que la voit l'application : jamais de secret, chiffré ou non. */
export interface GeststockLinkView {
  id: string;
  shopId: string;
  linkId: string;
  status: GeststockLinkStatus;
  companyCode: string;
  companyName: string | null;
  currency: string;
  scopes: string[];
  warehouses: LinkWarehouse[];
  linkedAt: Date;
  lastStateSyncAt: Date | null;
  revokedAt: Date | null;
  suspensionReason: string | null;
  revocationReason: string | null;
  pendingSecretCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** La boutique a déjà une liaison non révoquée (v14-D2), ou la liaison est déjà enregistrée. */
export class GeststockLinkConflictError extends Error {
  constructor(message = 'Cette boutique est déjà liée à une entreprise GestStock.') {
    super(message);
    this.name = 'GeststockLinkConflictError';
  }
}

/** Statut distant non pris en charge (`PENDING` ou valeur inconnue) : rien n'est modifié. */
export class GeststockLinkStateError extends Error {
  constructor() {
    super('Statut de liaison GestStock non pris en charge.');
    this.name = 'GeststockLinkStateError';
  }
}

const NOT_REVOKED = { $in: ['ACTIVE', 'SUSPENDED'] };

type StoredLink = IGeststockLink & { _id: mongoose.Types.ObjectId };

export class GeststockLinkRepository {
  private model = GeststockLink;

  /** Enregistre la liaison active et son secret chiffré ; refuse une deuxième liaison non révoquée. */
  async createActiveLink(input: NewGeststockLink): Promise<GeststockLinkView> {
    const shopId = objectId(input.shopId);
    const encryptedSecret = encryptLinkSecret(input.secret, { linkId: input.linkId, shopId: shopId.toString() });
    try {
      const created = await this.model.create({
        shopId,
        activeShopId: shopId,
        linkId: input.linkId,
        status: 'ACTIVE',
        companyCode: input.companyCode,
        companyName: input.companyName ?? null,
        currency: input.currency,
        scopes: input.scopes,
        warehouses: input.warehouses,
        linkedAt: input.linkedAt,
        lastStateSyncAt: input.linkedAt,
        encryptedSecret,
      });
      Logger.info(`Liaison GestStock ${input.linkId} enregistrée.`, { shopId: shopId.toString() });
      return view(created.toObject() as StoredLink);
    } catch (error) {
      if (isDuplicate(error, 'activeShopId')) throw new GeststockLinkConflictError();
      if (isDuplicate(error, 'linkId')) throw new GeststockLinkConflictError('Liaison GestStock déjà enregistrée.');
      throw error;
    }
  }

  /** Liaison non révoquée de la boutique, ou `null`. */
  async findCurrentByShop(shopId: string): Promise<GeststockLinkView | null> {
    if (!mongoose.isValidObjectId(shopId)) return null;
    const found = await this.model.findOne({ activeShopId: objectId(shopId) }).lean<StoredLink>();
    return found ? view(found) : null;
  }

  /** Liaison de la boutique (tout statut), ou `null` si elle appartient à une autre boutique. */
  async findByLinkId(shopId: string, linkId: string): Promise<GeststockLinkView | null> {
    if (!mongoose.isValidObjectId(shopId)) return null;
    const found = await this.model.findOne({ shopId: objectId(shopId), linkId }).lean<StoredLink>();
    return found ? view(found) : null;
  }

  /**
   * Secret de liaison en clair, sur demande explicite (appel à GestStock) ; `null` pour une liaison révoquée ou
   * d'une autre boutique. Texte chiffré déplacé ou altéré : `LinkSecretError` (J1).
   */
  async revealSecret(shopId: string, linkId: string): Promise<string | null> {
    if (!mongoose.isValidObjectId(shopId)) return null;
    const shop = objectId(shopId);
    const found = await this.model
      .findOne({ shopId: shop, linkId, status: NOT_REVOKED })
      .select('+encryptedSecret')
      .lean<StoredLink>();
    if (!found?.encryptedSecret) return null;
    return decryptLinkSecret(found.encryptedSecret, { linkId, shopId: shop.toString() });
  }

  /**
   * Applique l'état lu chez GestStock. ACTIVE ou SUSPENDED : seulement si la liaison n'est pas révoquée ;
   * REVOKED : révocation (définitive). Motifs conservés tels que reçus, même inconnus. `null` si aucune liaison
   * n'a été modifiée (révoquée, inconnue, autre boutique).
   */
  async applyRemoteState(shopId: string, linkId: string, state: RemoteLinkState): Promise<GeststockLinkView | null> {
    if (state.status === 'REVOKED') {
      return this.revokeAt(shopId, linkId, state.revocationReason ?? null, state.revokedAt ?? state.syncedAt, state.syncedAt);
    }
    if (state.status !== 'ACTIVE' && state.status !== 'SUSPENDED') throw new GeststockLinkStateError();
    if (!mongoose.isValidObjectId(shopId)) return null;
    const set: Record<string, unknown> = {
      status: state.status,
      suspensionReason: state.status === 'SUSPENDED' ? (state.suspensionReason ?? null) : null,
      lastStateSyncAt: state.syncedAt,
    };
    if (state.currency !== undefined) set.currency = state.currency;
    if (state.scopes !== undefined) set.scopes = state.scopes;
    if (state.warehouses !== undefined) set.warehouses = state.warehouses;
    const updated = await this.model
      .findOneAndUpdate({ shopId: objectId(shopId), linkId, status: NOT_REVOKED }, { $set: set }, { new: true, runValidators: true })
      .lean<StoredLink>();
    return updated ? view(updated) : null;
  }

  /**
   * Révocation (ACTIVE ou SUSPENDED → REVOKED), définitive : secrets chiffrés effacés, boutique libérée pour une
   * nouvelle liaison. `null` si la liaison est déjà révoquée, inconnue ou d'une autre boutique.
   */
  async revoke(shopId: string, linkId: string, reason: string | null, revokedAt: Date): Promise<GeststockLinkView | null> {
    return this.revokeAt(shopId, linkId, reason, revokedAt, null);
  }

  private async revokeAt(
    shopId: string,
    linkId: string,
    reason: string | null,
    revokedAt: Date,
    syncedAt: Date | null
  ): Promise<GeststockLinkView | null> {
    if (!mongoose.isValidObjectId(shopId)) return null;
    const set: Record<string, unknown> = {
      status: 'REVOKED',
      revocationReason: reason,
      revokedAt,
      suspensionReason: null,
      pendingSecretCreatedAt: null,
    };
    if (syncedAt) set.lastStateSyncAt = syncedAt;
    const updated = await this.model
      .findOneAndUpdate(
        { shopId: objectId(shopId), linkId, status: NOT_REVOKED },
        { $set: set, $unset: { activeShopId: 1, encryptedSecret: 1, pendingEncryptedSecret: 1 } },
        { new: true }
      )
      .lean<StoredLink>();
    if (updated) Logger.info(`Liaison GestStock ${linkId} révoquée.`, { shopId });
    return updated ? view(updated) : null;
  }
}

function objectId(value: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(value);
}

function isDuplicate(error: unknown, field: string): boolean {
  const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
  return duplicate?.code === 11000 && !!duplicate.keyPattern && field in duplicate.keyPattern;
}

/** Vue construite champ par champ : aucun champ secret ne peut s'y glisser. */
function view(stored: StoredLink): GeststockLinkView {
  return {
    id: stored._id.toString(),
    shopId: stored.shopId.toString(),
    linkId: stored.linkId,
    status: stored.status,
    companyCode: stored.companyCode,
    companyName: stored.companyName ?? null,
    currency: stored.currency,
    scopes: [...(stored.scopes ?? [])],
    warehouses: (stored.warehouses ?? []).map((w) => ({
      warehouseId: w.warehouseId,
      name: w.name,
      active: w.active,
      ...(w.priority !== undefined && w.priority !== null ? { priority: w.priority } : {}),
    })),
    linkedAt: stored.linkedAt,
    lastStateSyncAt: stored.lastStateSyncAt ?? null,
    revokedAt: stored.revokedAt ?? null,
    suspensionReason: stored.suspensionReason ?? null,
    revocationReason: stored.revocationReason ?? null,
    pendingSecretCreatedAt: stored.pendingSecretCreatedAt ?? null,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
