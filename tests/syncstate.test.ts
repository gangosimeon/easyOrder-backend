import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import SyncState, { AppliedEvent } from '@/models/syncstate.model';

/**
 * Modèle syncstates et registre des événements appliqués (lot 3, J7) :
 * curseur par liaison, index unique {linkId, seq} pour l'idempotence.
 */
describe('SyncState et registre des événements appliqués (lot 3, J7)', () => {
  beforeAll(async () => {
    await connectDB();
    await SyncState.init();
    await AppliedEvent.init();
  });

  // --- SyncState : curseur par liaison -------------------------------------------

  describe('SyncState', () => {
    it('état initial : linkId unique, after=0, status IDLE', async () => {
      const linkId = 'link-' + new mongoose.Types.ObjectId().toString();
      const state = await SyncState.create({ linkId, after: 0, status: 'IDLE' });
      expect(state.linkId).toBe(linkId);
      expect(state.after).toBe(0);
      expect(state.status).toBe('IDLE');
    });

    it('deux SyncState avec le même linkId → erreur d\'unicité (E11000)', async () => {
      const linkId = 'link-dup-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, status: 'IDLE' });
      await expect(
        SyncState.create({ linkId, after: 0, status: 'IDLE' })
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('passage en SYNCING puis retour IDLE avec curseur avancé', async () => {
      const linkId = 'link-sync-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, status: 'IDLE' });

      await SyncState.updateOne({ linkId }, { $set: { status: 'SYNCING' } });
      let state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('SYNCING');

      await SyncState.updateOne({ linkId }, { $set: { status: 'IDLE', after: 50 } });
      state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
      expect(state?.after).toBe(50);
    });

    it('passage en CURSOR_AHEAD : liaison bloquée jusqu\'à réinitialisation', async () => {
      const linkId = 'link-ahead-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 100, status: 'SYNCING' });

      await SyncState.updateOne({ linkId }, { $set: { status: 'CURSOR_AHEAD' } });
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('CURSOR_AHEAD');
    });

    it('curseur avancé de 0 à lastSeq après une page d\'événements', async () => {
      const linkId = 'link-cursor-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, status: 'IDLE' });
      await SyncState.updateOne({ linkId }, { $set: { after: 42 } });
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.after).toBe(42);
    });

    it('passage en ERROR avec message', async () => {
      const linkId = 'link-err-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, status: 'IDLE' });
      await SyncState.updateOne({ linkId }, {
        $set: { status: 'ERROR', errorMessage: 'Service GestStock indisponible' },
      });
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('ERROR');
      expect(state?.errorMessage).toBe('Service GestStock indisponible');
    });
  });

  // --- AppliedEvent : registre d'idempotence ----------------------------------------

  describe('AppliedEvent (registre d\'idempotence)', () => {
    it('enregistrement d\'un événement appliqué', async () => {
      const linkId = 'link-ev-' + new mongoose.Types.ObjectId().toString();
      const ev = await AppliedEvent.create({ linkId, seq: 1 });
      expect(ev.linkId).toBe(linkId);
      expect(ev.seq).toBe(1);
      expect(ev.appliedAt).toBeInstanceOf(Date);
    });

    it('même {linkId, seq} → E11000 (empêche la double application)', async () => {
      const linkId = 'link-ev-dup-' + new mongoose.Types.ObjectId().toString();
      await AppliedEvent.create({ linkId, seq: 10 });
      await expect(
        AppliedEvent.create({ linkId, seq: 10 })
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('même seq, liaisons différentes → autorisé', async () => {
      const seq = 7;
      await AppliedEvent.create({ linkId: 'link-a-' + new mongoose.Types.ObjectId(), seq });
      await AppliedEvent.create({ linkId: 'link-b-' + new mongoose.Types.ObjectId(), seq });
      // aucune erreur
    });

    it('même liaison, seq différents → autorisé', async () => {
      const linkId = 'link-seqs-' + new mongoose.Types.ObjectId().toString();
      await AppliedEvent.create({ linkId, seq: 1 });
      await AppliedEvent.create({ linkId, seq: 2 });
      await AppliedEvent.create({ linkId, seq: 3 });
      // aucune erreur
    });

    it('index unique {linkId, seq} présent sur la collection appliedevents', async () => {
      const indexes = await mongoose.connection.collection('appliedevents').indexes();
      const idx = indexes.find((i) => i.key?.linkId === 1 && i.key?.seq === 1);
      expect(idx?.unique).toBe(true);
    });
  });
});
