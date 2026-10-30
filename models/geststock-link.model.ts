import mongoose, { Model, Schema, Types } from 'mongoose';

/**
 * Liaison avec une entreprise GestStock (intégration GestStock, lot 2, J2 ; plan v14 §27, v14-D2, v14-D3, contrat
 * `Link`). Créée après l'échange du code (liaison déjà ACTIVE côté GestStock) ; l'état est ensuite resynchronisé
 * depuis `GET /link` (J3, J4).
 *
 * - **Unicité** (v14-D2) : au plus une liaison non révoquée par boutique. `activeShopId` (= `shopId`) n'existe que
 *   tant que la liaison n'est pas révoquée ; il est retiré ($unset) à la révocation. Index unique partiel
 *   `{ activeShopId: 1 }` avec `partialFilterExpression: { activeShopId: { $exists: true } }` : `$exists: true` est
 *   accepté par les index partiels depuis MongoDB 3.2 (Atlas comme mongodb-memory-server), contrairement à `$in`
 *   ou `$ne` sur le statut, qui ne le sont pas dans toutes les versions.
 * - **Secret de liaison** : seulement chiffré par `lib/integration-crypto.ts` (AAD : liaison + boutique) ;
 *   `select: false`, et retiré de toute sérialisation (`toJSON`, `toObject`) même s'il a été sélectionné. Secret en
 *   attente de rotation (G14) : même traitement. Les deux sont effacés à la révocation.
 * - **Révocation définitive** : une liaison REVOKED ne revient à aucun autre statut. Les fonctions d'accès le
 *   garantissent par des mises à jour conditionnelles ; le modèle le garantit aussi pour toute mise à jour directe
 *   (filtre ajouté) et pour tout enregistrement d'un document (refus).
 * - **Motifs** : chaînes libres, telles que reçues (le contrat demande de tolérer une valeur inconnue).
 * - **Évolution** : le curseur du flux et l'état de l'instantané (lot 3) seront des champs facultatifs ajoutés,
 *   sans migration destructive (aucun champ existant n'est à renommer).
 */

export const GESTSTOCK_LINK_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type GeststockLinkStatus = (typeof GESTSTOCK_LINK_STATUSES)[number];

/** Dépôt vendable de la liaison, tel que renvoyé par `GET /link`. */
export interface IGeststockLinkWarehouse {
  warehouseId: string;
  name: string;
  active: boolean;
  priority?: number;
}

export interface IGeststockLink {
  shopId: Types.ObjectId;
  /** Présent seulement tant que la liaison n'est pas révoquée : support de l'index unique. */
  activeShopId?: Types.ObjectId;
  /** Identifiant de la liaison côté GestStock (UUID). */
  linkId: string;
  status: GeststockLinkStatus;
  companyCode: string;
  companyName: string | null;
  currency: string;
  scopes: string[];
  warehouses: IGeststockLinkWarehouse[];
  linkedAt: Date;
  lastStateSyncAt: Date | null;
  revokedAt: Date | null;
  suspensionReason: string | null;
  revocationReason: string | null;
  /** Secret de liaison chiffré (J1) ; jamais sélectionné ni sérialisé par défaut. */
  encryptedSecret?: string;
  /** Secret en attente de rotation (G14), chiffré de la même façon. */
  pendingEncryptedSecret?: string | null;
  pendingSecretCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SECRET_FIELDS = ['encryptedSecret', 'pendingEncryptedSecret'] as const;

const warehouseSchema = new Schema<IGeststockLinkWarehouse>(
  {
    warehouseId: { type: String, required: true },
    name:        { type: String, required: true },
    active:      { type: Boolean, required: true },
    priority:    { type: Number, min: 0 },
  },
  { _id: false }
);

/** Retire les secrets chiffrés de toute sérialisation, même sélectionnés explicitement. */
function withoutSecrets(_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> {
  for (const field of SECRET_FIELDS) delete ret[field];
  return ret;
}

const geststockLinkSchema = new Schema<IGeststockLink>(
  {
    shopId:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
    activeShopId: { type: Schema.Types.ObjectId },
    linkId:       { type: String, required: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
    status:       { type: String, enum: GESTSTOCK_LINK_STATUSES, required: true },
    companyCode:  { type: String, required: true },
    companyName:  { type: String, default: null },
    currency:     { type: String, required: true, match: /^[A-Z]{3}$/ },
    scopes:       { type: [String], default: [] },
    warehouses:   { type: [warehouseSchema], default: [] },
    linkedAt:        { type: Date, required: true },
    lastStateSyncAt: { type: Date, default: null },
    revokedAt:       { type: Date, default: null },
    suspensionReason: { type: String, default: null, maxlength: 64 },
    revocationReason: { type: String, default: null, maxlength: 64 },
    encryptedSecret: {
      type: String,
      select: false,
      required: function (this: IGeststockLink) {
        return this.status !== 'REVOKED';
      },
    },
    pendingEncryptedSecret: { type: String, select: false, default: null },
    pendingSecretCreatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: withoutSecrets },
    toObject: { transform: withoutSecrets },
  }
);

geststockLinkSchema.index({ linkId: 1 }, { unique: true });
geststockLinkSchema.index({ shopId: 1 });
// Au plus une liaison non révoquée par boutique (v14-D2).
geststockLinkSchema.index({ activeShopId: 1 }, { unique: true, partialFilterExpression: { activeShopId: { $exists: true } } });

// --- Révocation définitive --------------------------------------------------------------------------------

/** Statut demandé par une mise à jour, quelle que soit sa forme ({ $set: { status } } ou { status }). */
function targetStatus(update: unknown): unknown {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return undefined;
  const set = (update as { $set?: Record<string, unknown> }).$set;
  return set?.status ?? (update as Record<string, unknown>).status;
}

// Toute mise à jour qui change le statut vers autre chose que REVOKED ignore une liaison révoquée.
geststockLinkSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const status = targetStatus(this.getUpdate());
  if (status !== undefined && status !== 'REVOKED') {
    this.where({ status: { $ne: 'REVOKED' } });
  }
});

geststockLinkSchema.post('init', function () {
  this.$locals.loadedStatus = this.status;
});

geststockLinkSchema.pre('save', function () {
  if (!this.isNew && this.$locals.loadedStatus === 'REVOKED' && this.status !== 'REVOKED') {
    throw new Error('Liaison GestStock révoquée : aucun retour à un autre statut.');
  }
});

const GeststockLink: Model<IGeststockLink> =
  mongoose.models.GeststockLink ?? mongoose.model<IGeststockLink>('GeststockLink', geststockLinkSchema, 'geststocklinks');

export default GeststockLink;
