import mongoose, { Model, Schema, Types } from 'mongoose';

/**
 * Demande d'autorisation GestStock en cours (intégration GestStock, lot 2, J2 ; v14-D1 étapes 1 et 4) : de
 * `POST /api/integrations/geststock/start` au retour `complete` de la même boutique.
 *
 * - `state` : seulement son empreinte SHA-256 (hexadécimal), unique ; jamais en clair.
 * - Vérificateur PKCE : chiffré par `lib/integration-crypto.ts` (AAD : demande + boutique), `select: false`, retiré
 *   de toute sérialisation.
 * - `expiresAt` (10 min) porte un index TTL qui ne fait que nettoyer : la consommation vérifie la date elle-même
 *   (le moniteur TTL ne passe que toutes les 60 s environ).
 * - Consommation à usage unique : une seule mise à jour conditionnelle (`usedAt: null`, non expirée, même
 *   boutique), atomique dans MongoDB sur un document.
 */

/** Durée de vie d'une demande, alignée sur celle du `request_uri` de GestStock (10 min). */
export const AUTHORIZATION_REQUEST_LIFETIME_MS = 10 * 60_000;

export interface IGeststockAuthorizationRequest {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  stateHash: string;
  encryptedCodeVerifier?: string;
  requestUri: string;
  redirectUri: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function withoutVerifier(_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> {
  delete ret.encryptedCodeVerifier;
  return ret;
}

const geststockAuthorizationRequestSchema = new Schema<IGeststockAuthorizationRequest>(
  {
    shopId:                { type: Schema.Types.ObjectId, ref: 'User', required: true },
    stateHash:             { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    encryptedCodeVerifier: { type: String, required: true, select: false },
    requestUri:            { type: String, required: true, maxlength: 512 },
    redirectUri:           { type: String, required: true, maxlength: 2048 },
    expiresAt:             { type: Date, required: true },
    usedAt:                { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: withoutVerifier },
    toObject: { transform: withoutVerifier },
  }
);

geststockAuthorizationRequestSchema.index({ stateHash: 1 }, { unique: true });
geststockAuthorizationRequestSchema.index({ shopId: 1 });
// Nettoyage des demandes expirées (la consommation ne s'y fie jamais).
geststockAuthorizationRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const GeststockAuthorizationRequest: Model<IGeststockAuthorizationRequest> =
  mongoose.models.GeststockAuthorizationRequest ??
  mongoose.model<IGeststockAuthorizationRequest>(
    'GeststockAuthorizationRequest',
    geststockAuthorizationRequestSchema,
    'geststockauthorizationrequests'
  );

export default GeststockAuthorizationRequest;
