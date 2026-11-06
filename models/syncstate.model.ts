import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * État de synchronisation du flux GestStock par liaison (lot 3, J7).
 *
 * - **SyncState** : un document par liaison ; `linkId` (UUID GestStock) unique.
 *   `after` = dernier seq examiné, à passer comme `after` au prochain appel (P1).
 *   Statuts : IDLE (au repos), SYNCING (en cours), ERROR (erreur récupérable),
 *   CURSOR_AHEAD (curseur en avance, réinitialisation manuelle requise).
 *
 * - **AppliedEvent** : registre des événements déjà appliqués ; index unique
 *   `{ linkId, seq }` — empêche la double application en cas de rejeu (idempotence).
 *   L'application et l'avancement du curseur étant non atomiques (pas de transaction
 *   sur le VPS, v13-D3), ce registre garantit qu'une interruption entre les deux ne
 *   provoque pas de doublons.
 */

export const SYNCSTATE_STATUSES = ['IDLE', 'SYNCING', 'ERROR', 'CURSOR_AHEAD'] as const;
export type SyncStateStatus = (typeof SYNCSTATE_STATUSES)[number];

export interface ISyncState extends Document {
  /** Identifiant de la liaison côté GestStock (UUID). */
  linkId: string;
  /** Dernier seq examiné (curseur) ; 0 au départ. */
  after: number;
  status: SyncStateStatus;
  /** Message d'erreur (statut ERROR seulement). */
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAppliedEvent extends Document {
  linkId: string;
  /** Seq de l'événement appliqué. */
  seq: number;
  appliedAt: Date;
}

// --- Schémas ---------------------------------------------------------------------------------

const syncStateSchema = new Schema<ISyncState>(
  {
    linkId:       { type: String, required: true },
    after:        { type: Number, required: true, default: 0, min: 0 },
    status:       { type: String, enum: SYNCSTATE_STATUSES, required: true, default: 'IDLE' },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

syncStateSchema.index({ linkId: 1 }, { unique: true });

const appliedEventSchema = new Schema<IAppliedEvent>(
  {
    linkId:    { type: String, required: true },
    seq:       { type: Number, required: true, min: 0 },
    appliedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: true }
);

// Index unique {linkId, seq} : un événement ne peut être appliqué qu'une seule fois par liaison.
appliedEventSchema.index({ linkId: 1, seq: 1 }, { unique: true });

// --- Modèles ---------------------------------------------------------------------------------

const SyncState: Model<ISyncState> =
  mongoose.models.SyncState ?? mongoose.model<ISyncState>('SyncState', syncStateSchema, 'syncstates');

export const AppliedEvent: Model<IAppliedEvent> =
  mongoose.models.AppliedEvent ?? mongoose.model<IAppliedEvent>('AppliedEvent', appliedEventSchema, 'appliedevents');

export default SyncState;
