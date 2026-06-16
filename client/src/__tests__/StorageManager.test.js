/**
 * StorageManager.test.js — IndexedDB chunk-storage path.
 *
 * Exercises the real (fake-indexeddb) IDB backend: write → assemble round-trip,
 * compound-key isolation between concurrent files, and the regression that the old
 * per-file-store design silently lost data when a store was missing.
 */

import { describe, test, expect } from 'vitest';
import { StorageManager } from '../storage/StorageManager.js';

// Force the IDB tier (Node test env has no FS Access API / OPFS anyway).
function idbStorage() {
    const sm = new StorageManager();
    sm.mode = 'idb';
    return sm;
}

function meta(fileId, totalChunks, chunkSize = 8) {
    return { fileId, fileName: `${fileId}.bin`, fileType: 'application/octet-stream', totalChunks, chunkSize };
}

function buf(bytes) {
    return new Uint8Array(bytes).buffer;
}

describe('StorageManager — IndexedDB backend', () => {
    // Each test uses unique fileIds; the compound [fileId, index] key isolates them,
    // so no per-test database reset is needed.

    test('writes chunks and assembles them back in order', async () => {
        const sm = idbStorage();
        await sm.initFile(meta('file-A', 3));
        // Write out of order to prove assembly sorts by index.
        await sm.writeChunk(2, buf([20, 21]));
        await sm.writeChunk(0, buf([0, 1]));
        await sm.writeChunk(1, buf([10, 11]));

        const blob = await sm.assembleFile();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect([...bytes]).toEqual([0, 1, 10, 11, 20, 21]);
        await sm.cleanup();
    });

    test('written chunks are actually persisted (no silent no-op)', async () => {
        const sm = idbStorage();
        await sm.initFile(meta('file-B', 2));
        await sm.writeChunk(0, buf([1, 2, 3]));
        await sm.writeChunk(1, buf([4, 5, 6]));

        // A fresh manager (new session) must see the persisted chunks via assembly.
        const sm2 = idbStorage();
        await sm2.initFile(meta('file-B', 2));
        // Re-mark as written so the corruption guard passes, then assemble.
        sm2._writtenChunks.set(0, true);
        sm2._writtenChunks.set(1, true);
        const blob = await sm2.assembleFile();
        expect(blob.size).toBe(6);
        await sm2.cleanup();
    });

    test('compound key isolates files — assembling one never reads another', async () => {
        const a = idbStorage();
        const b = idbStorage();
        await a.initFile(meta('file-X', 1));
        await b.initFile(meta('file-Y', 1));
        await a.writeChunk(0, buf([1, 1, 1, 1]));
        await b.writeChunk(0, buf([2, 2]));

        const blobA = await a.assembleFile();
        expect(blobA.size).toBe(4); // only file-X's chunk, not file-Y's
        await a.cleanup();
        await b.cleanup();
    });

    test('IDB fallback refuses a file too large to assemble in memory', async () => {
        const sm = idbStorage();
        const huge = { fileId: 'file-huge', fileName: 'huge.bin', fileType: 'application/octet-stream',
            totalChunks: 1, chunkSize: 8, fileSize: 5 * 1024 * 1024 * 1024 }; // 5 GB > 2 GB cap
        await expect(sm.initFile(huge)).rejects.toThrow(/too large/i);
    });

    test('a normal-sized file is accepted on the IDB fallback', async () => {
        const sm = idbStorage();
        await sm.initFile(meta('file-ok', 1)); // no fileSize / small → allowed
        await sm.writeChunk(0, buf([1, 2]));
        const blob = await sm.assembleFile();
        expect(blob.size).toBe(2);
        await sm.cleanup();
    });

    test('cleanup of one file leaves another file intact', async () => {
        const a = idbStorage();
        await a.initFile(meta('file-1', 1));
        await a.writeChunk(0, buf([9, 9]));

        const b = idbStorage();
        await b.initFile(meta('file-2', 1));
        await b.writeChunk(0, buf([7, 7, 7]));

        // Assembling file-1 cleans up only file-1's chunks.
        await a.assembleFile();

        // file-2 must still be assemblable.
        b._writtenChunks.set(0, true);
        const blobB = await b.assembleFile();
        expect(blobB.size).toBe(3);
        await b.cleanup();
    });
});
