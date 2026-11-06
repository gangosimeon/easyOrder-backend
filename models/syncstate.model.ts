import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * État de synchronisation du flux GestStock par liaison (lot 3, J7b).
 *
 * - **after** : dernier `lastSeq` examiné avec succès (curseur).
 * - **acknowledgedSeq** : dernier seq dont l'accusé de réception a été envoyé à GestStock.
 * - **leaseOwner / leaseUntil** : bail d'exclusion ; un seul consommateur à la fois par liaison.
 * - **blockedReason / blockedEventSeq** : cause et position du blocage (statut BLOCKED).
 * - **nextAttemptAt** : backoff sur erreur transitoire (429, 503, réseau).
 * - **imageNextAttemptAt** : backoff sur erreur 429 lors du téléchargement d'images (lot 3, J9).
 *
 * Statuts :
 *   IDLE             — au repos, prêt pour le prochain cycle.
 *   SYNCING          — cycle en cours.
 *   BLOCKED          — arrêté sur un événement non traitable ; see `blockedReason`.
 *   CURSOR_AHEAD     — curseur en avance sur le flux ; réinitialisation manuelle requise.
 *   SNAPSHOT_REQUIRED — curseur expiré ; reprise depuis l'instantané (J8).
 *   PAUSED           — liaison suspendue chez GestStock ; en attente de reprise.
 */

export const SYNCSTATE_STATUSES = ['IDLE', 'SYNCING', 'BLOCKED', 'CURSOR_AHEAD', 'SNAPSHOT_REQUIRED', 'PAUSED'] as const;
export type SyncStateStatus = (typeof SYNCSTATE_STATUSES)[number];

export type BlockedReason = 'MISSING_CATEGORY' | 'UNKNOWN_EVENT' | 'CURRENCY_MISMATCH';

export interface ISyncState extends Document {
  linkId: string;
  after: number;
  acknowledgedSeq: number;
  status: SyncStateStatus;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  blockedReason?: BlockedReason | null;
  blockedEventSeq?: number | null;
  /** D7 (lot 3, J8b) : instantané automatique déjà déclenché pour ce BLOCKED/MISSING_CATEGORY. Effacé dès l'atteinte de IDLE. */
  blockedAutoSnapshotDone?: boolean | null;
  nextAttemptAt?: Date | null;
  /** Backoff spécifique aux téléchargements d'images (lot 3, J9) ; distinct de `nextAttemptAt`. */
  imageNextAttemptAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const syncStateSchema = new Schema<ISyncState>(
  {
    linkId:          { type: String, required: true },
    after:           { type: Number, required: true, default: 0, min: 0 },
    acknowledgedSeq: { type: Number, required: true, default: 0, min: 0 },
    status:          { type: String, enum: SYNCSTATE_STATUSES, required: true, default: 'IDLE' },
    leaseOwner:      { type: String, default: null },
    leaseUntil:      { type: Date, default: null },
    blockedReason:   { type: String, enum: ['MISSING_CATEGORY', 'UNKNOWN_EVENT', 'CURRENCY_MISMATCH'], default: null },
    blockedEventSeq: { type: Number, default: null, min: 0 },
    blockedAutoSnapshotDone: { type: Boolean, default: null },
    nextAttemptAt:      { type: Date, default: null },
    imageNextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

syncStateSchema.index({ linkId: 1 }, { unique: true });

const SyncState: Model<ISyncState> =
  mongoose.models.SyncState ?? mongoose.model<ISyncState>('SyncState', syncStateSchema, 'syncstates');

export default SyncState;
