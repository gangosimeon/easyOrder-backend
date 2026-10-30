import { createHash } from 'node:crypto';
import mongoose from 'mongoose';

import { decryptLinkSecret, encryptLinkSecret } from '@/lib/integration-crypto';
import GeststockAuthorizationRequest, {
  AUTHORIZATION_REQUEST_LIFETIME_MS,
  IGeststockAuthorizationRequest,
} from '@/models/geststock-authorization-request.model';

/**
 * Accès aux demandes d'autorisation GestStock en cours (intégration GestStock, lot 2, J2). Le `state` n'est
 * stocké que par son empreinte SHA-256 ; le vérificateur PKCE est chiffré (J1, AAD : demande + boutique). La
 * consommation est une seule mise à jour conditionnelle : usage unique, même en concurrence, et expiration vérifiée
 * sans attendre le TTL.
 */

export interface NewAuthorizationRequest {
  shopId: string;
  /** `state` en clair, envoyé à GestStock : seule son empreinte est conservée. */
  state: string;
  /** Vérificateur PKCE (RFC 7636) : chiffré avant tout enregistrement. */
  codeVerifier: string;
  requestUri: string;
  redirectUri: string;
  now?: Date;
}

export interface ConsumedAuthorizationRequest {
  id: string;
  requestUri: string;
  redirectUri: string;
  codeVerifier: string;
}

const STATE = /^[A-Za-z0-9_-]{32,512}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type StoredRequest = IGeststockAuthorizationRequest;

export class GeststockAuthorizationRequestRepository {
  private model = GeststockAuthorizationRequest;

  /** Enregistre la demande, valable 10 minutes. */
  async create(input: NewAuthorizationRequest): Promise<{ id: string; expiresAt: Date }> {
    if (!mongoose.isValidObjectId(input.shopId) || !STATE.test(input.state) || !CODE_VERIFIER.test(input.codeVerifier)) {
      throw new Error('Demande d’autorisation GestStock invalide.');
    }
    const id = new mongoose.Types.ObjectId();
    const shopId = new mongoose.Types.ObjectId(input.shopId);
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + AUTHORIZATION_REQUEST_LIFETIME_MS);
    await this.model.create({
      _id: id,
      shopId,
      stateHash: stateHash(input.state),
      encryptedCodeVerifier: encryptLinkSecret(input.codeVerifier, verifierContext(id, shopId)),
      requestUri: input.requestUri,
      redirectUri: input.redirectUri,
      expiresAt,
      usedAt: null,
    });
    return { id: id.toString(), expiresAt };
  }

  /**
   * Consomme la demande de la boutique : une seule fois, avant son expiration. `null` si le `state` est inconnu,
   * déjà utilisé, expiré (même avant le passage du TTL) ou d'une autre boutique.
   */
  async consume(input: { shopId: string; state: string; now?: Date }): Promise<ConsumedAuthorizationRequest | null> {
    if (!mongoose.isValidObjectId(input.shopId) || typeof input.state !== 'string' || !STATE.test(input.state)) return null;
    const shopId = new mongoose.Types.ObjectId(input.shopId);
    const now = input.now ?? new Date();
    const consumed = await this.model
      .findOneAndUpdate(
        { stateHash: stateHash(input.state), shopId, usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { new: true }
      )
      .select('+encryptedCodeVerifier')
      .lean<StoredRequest>();
    if (!consumed?.encryptedCodeVerifier) return null;
    return {
      id: consumed._id.toString(),
      requestUri: consumed.requestUri,
      redirectUri: consumed.redirectUri,
      codeVerifier: decryptLinkSecret(consumed.encryptedCodeVerifier, verifierContext(consumed._id, shopId)),
    };
  }
}

function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** AAD du vérificateur : la demande (préfixée, jamais confondue avec une liaison) et la boutique. */
function verifierContext(id: mongoose.Types.ObjectId, shopId: mongoose.Types.ObjectId) {
  return { linkId: `authorization-request:${id.toString()}`, shopId: shopId.toString() };
}
