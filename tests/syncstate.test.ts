import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import SyncState from '@/models/syncstate.model';

/**
 * Modèle syncstates (lot 3, J7b) : curseur, bail d'exclusion, statuts, champs de blocage.
 */
describe('SyncState (lot 3, J7b)', () => {
  beforeAll(async () => {
    await connectDB();
    await SyncState.init();
  });

  it('état initial : linkId unique, after=0, acknowledgedSeq=0, status IDLE', async () => {
    const linkId = 'link-' + new mongoose.Types.ObjectId().toString();
    const state = await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    expect(state.linkId).toBe(linkId);
    expect(state.after).toBe(0);
    expect(state.acknowledgedSeq).toBe(0);
    expect(state.status).toBe('IDLE');
    expect(state.leaseOwner).toBeNull();
    expect(state.leaseUntil).toBeNull();
  });

  it('deux SyncState avec le même linkId → E11000', async () => {
    const linkId = 'link-dup-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await expect(
      SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('passage IDLE → SYNCING → IDLE avec curseur avancé', async () => {
    const linkId = 'link-sync-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });

    await SyncState.updateOne({ linkId }, { $set: { status: 'SYNCING' } });
    expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('SYNCING');

    await SyncState.updateOne({ linkId }, { $set: { status: 'IDLE', after: 50, acknowledgedSeq: 50 } });
    const state = await SyncState.findOne({ linkId }).lean();
    expect(state?.status).toBe('IDLE');
    expect(state?.after).toBe(50);
    expect(state?.acknowledgedSeq).toBe(50);
  });

  it('passage en CURSOR_AHEAD', async () => {
    const linkId = 'link-ahead-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 100, acknowledgedSeq: 50, status: 'SYNCING' });
    await SyncState.updateOne({ linkId }, { $set: { status: 'CURSOR_AHEAD' } });
    expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('CURSOR_AHEAD');
  });

  it('passage en SNAPSHOT_REQUIRED', async () => {
    const linkId = 'link-snap-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, { $set: { status: 'SNAPSHOT_REQUIRED' } });
    expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('SNAPSHOT_REQUIRED');
  });

  it('passage en PAUSED', async () => {
    const linkId = 'link-paused-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, { $set: { status: 'PAUSED' } });
    expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('PAUSED');
  });

  it('passage en BLOCKED/MISSING_CATEGORY avec blockedEventSeq', async () => {
    const linkId = 'link-blocked-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, {
      $set: { status: 'BLOCKED', blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 42 },
    });
    const state = await SyncState.findOne({ linkId }).lean();
    expect(state?.status).toBe('BLOCKED');
    expect(state?.blockedReason).toBe('MISSING_CATEGORY');
    expect(state?.blockedEventSeq).toBe(42);
  });

  it('passage en BLOCKED/UNKNOWN_EVENT', async () => {
    const linkId = 'link-unk-' + new mongoose.Types.ObjectId().toString();
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, {
      $set: { status: 'BLOCKED', blockedReason: 'UNKNOWN_EVENT', blockedEventSeq: 7 },
    });
    const state = await SyncState.findOne({ linkId }).lean();
    expect(state?.blockedReason).toBe('UNKNOWN_EVENT');
  });

  it('bail : leaseOwner et leaseUntil posés et effacés', async () => {
    const linkId = 'link-lease-' + new mongoose.Types.ObjectId().toString();
    const leaseUntil = new Date(Date.now() + 30_000);
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, { $set: { leaseOwner: 'instance-1', leaseUntil } });
    let state = await SyncState.findOne({ linkId }).lean();
    expect(state?.leaseOwner).toBe('instance-1');
    expect(state?.leaseUntil).toEqual(leaseUntil);

    await SyncState.updateOne({ linkId }, { $set: { leaseOwner: null, leaseUntil: null } });
    state = await SyncState.findOne({ linkId }).lean();
    expect(state?.leaseOwner).toBeNull();
    expect(state?.leaseUntil).toBeNull();
  });

  it('nextAttemptAt posé et effacé', async () => {
    const linkId = 'link-retry-' + new mongoose.Types.ObjectId().toString();
    const nextAttemptAt = new Date(Date.now() + 5 * 60_000);
    await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE' });
    await SyncState.updateOne({ linkId }, { $set: { nextAttemptAt } });
    let state = await SyncState.findOne({ linkId }).lean();
    expect(state?.nextAttemptAt?.getTime()).toBeCloseTo(nextAttemptAt.getTime(), -2);

    await SyncState.updateOne({ linkId }, { $set: { nextAttemptAt: null } });
    state = await SyncState.findOne({ linkId }).lean();
    expect(state?.nextAttemptAt).toBeNull();
  });

  it('index unique {linkId} présent sur la collection syncstates', async () => {
    const indexes = await mongoose.connection.collection('syncstates').indexes();
    const idx = indexes.find((i) => i.key?.linkId === 1);
    expect(idx?.unique).toBe(true);
  });
});
