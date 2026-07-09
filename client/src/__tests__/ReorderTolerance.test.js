import { describe, test, expect } from 'vitest';
import { Receiver } from '../transfer/Receiver.js';
import { IntegrityVerifier } from '../transfer/IntegrityVerifier.js';
import { ChunkManager } from '../transfer/ChunkManager.js';
import { TRANSFER_MSG } from '@shared/constants.js';

// The wire sends a metadata frame then the binary frame per chunk. Ordered channels
// guarantee that order; these tests prove the Receiver also survives an UNORDERED channel
// (binary outrunning its metadata) so ordered:true can later be flipped for throughput.

describe('IntegrityVerifier.recordChunkHash', () => {
    test('stores a precomputed hash without re-hashing', async () => {
        const v = new IntegrityVerifier();
        const data = new Uint8Array([1, 2, 3, 4]).buffer;
        const hash = await IntegrityVerifier.hash(data);
        v.recordChunkHash(7, hash);
        expect(v.getChunkHash(7)).toBe(hash);
        // The recorded hash must match what hashing the data would have produced, so the
        // manifest root is identical whether we re-hash or reuse the verified hash.
        expect(v.getChunkHash(7)).toBe(await IntegrityVerifier.hash(data));
    });
});

function makeMocks(missing) {
    const remaining = new Set(missing);
    const stored = new Map();
    let handler = null;
    const channelManager = {
        onMessage(h) { handler = h; },
        async sendAny() { return 0; },
        async send() {},
        getChannelStats() { return [{ index: 0, state: 'open', throughput: 0 }]; },
        resetStats() {},
    };
    const storageManager = {
        async initFile() {},
        getMode() { return 'memory'; },
        async writeChunk(i, d) { stored.set(i, new Uint8Array(d)); },
    };
    const resumeManager = {
        async init() {},
        getMissingChunks() { return [...remaining]; },
        hasChunk(_id, i) { return !remaining.has(i); },
        markChunkReceived(_id, i) { remaining.delete(i); },
        getProgress() { return 0; },
        isComplete() { return false; }, // keep the test focused on the write, skip finalize
        flush() { return Promise.resolve(); },
    };
    return { channelManager, storageManager, resumeManager, stored, inject: (m) => handler(m) };
}

describe('Receiver tolerates binary-before-metadata (unordered channel)', () => {
    test('buffers an early binary frame and writes it once metadata arrives', async () => {
        const data = new Uint8Array([10, 20, 30, 40]);
        const hash = await IntegrityVerifier.hash(data.buffer);
        const m = makeMocks([0]);
        const receiver = new Receiver(
            { fileId: 'f1', totalChunks: 1, chunkSize: 16, fileType: 'application/octet-stream' },
            m.channelManager, m.storageManager, m.resumeManager,
            () => {}, () => {}, () => {}, null, null,
        );
        await receiver.start();

        // Binary arrives FIRST (out of order) — must be held, not written or re-requested.
        await m.inject(ChunkManager.packChunk(0, data.buffer));
        expect(m.stored.has(0)).toBe(false);

        // Metadata lands second — the buffered binary is now processed and written.
        // Awaiting the handler awaits the full decrypt→verify→write path (deterministic).
        await m.inject(JSON.stringify({ type: TRANSFER_MSG.CHUNK_DATA, index: 0, hash, size: data.byteLength }));
        expect(m.stored.has(0)).toBe(true);
        expect(m.stored.get(0)).toEqual(data);
    });

    test('still works in the normal metadata-then-binary order', async () => {
        const data = new Uint8Array([5, 6, 7, 8]);
        const hash = await IntegrityVerifier.hash(data.buffer);
        const m = makeMocks([0]);
        const receiver = new Receiver(
            { fileId: 'f2', totalChunks: 1, chunkSize: 16, fileType: 'application/octet-stream' },
            m.channelManager, m.storageManager, m.resumeManager,
            () => {}, () => {}, () => {}, null, null,
        );
        await receiver.start();

        await m.inject(JSON.stringify({ type: TRANSFER_MSG.CHUNK_DATA, index: 0, hash, size: data.byteLength }));
        await m.inject(ChunkManager.packChunk(0, data.buffer));
        expect(m.stored.get(0)).toEqual(data);
    });
});
