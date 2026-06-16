import { describe, test, expect } from 'vitest';
import { FileManifest } from '../transfer/FileManifest.js';
import { IntegrityVerifier } from '../transfer/IntegrityVerifier.js';

// FileManifest is the whole-file commitment used for final verification (Phase 2.2/2.3).
// These tests pin its determinism and tamper-detection properties.

async function hashOf(bytes) {
    return IntegrityVerifier.hash(new Uint8Array(bytes).buffer);
}

describe('FileManifest', () => {
    test('buildFromHashes is deterministic for the same inputs', async () => {
        const hashes = [await hashOf([1, 2, 3]), await hashOf([4, 5, 6])];
        const a = await FileManifest.buildFromHashes(hashes);
        const b = await FileManifest.buildFromHashes(hashes);
        expect(a.rootHash).toBe(b.rootHash);
        expect(a.rootHash.length).toBeGreaterThan(0);
    });

    test('reordering chunks changes the root (detects out-of-order assembly)', async () => {
        const h0 = await hashOf([1, 2, 3]);
        const h1 = await hashOf([4, 5, 6]);
        const ordered = await FileManifest.buildFromHashes([h0, h1]);
        const swapped = await FileManifest.buildFromHashes([h1, h0]);
        expect(ordered.rootHash).not.toBe(swapped.rootHash);
    });

    test('a single substituted chunk hash changes the root (detects tampering)', async () => {
        const base = [await hashOf([1, 2, 3]), await hashOf([4, 5, 6]), await hashOf([7, 8, 9])];
        const tampered = [...base];
        tampered[1] = await hashOf([4, 5, 7]); // one byte different
        const a = await FileManifest.buildFromHashes(base);
        const b = await FileManifest.buildFromHashes(tampered);
        expect(a.rootHash).not.toBe(b.rootHash);
    });

    test('verifyRoot accepts a matching root and rejects a wrong one', async () => {
        const hashes = [await hashOf([1]), await hashOf([2])];
        const { rootHash } = await FileManifest.buildFromHashes(hashes);
        expect(await FileManifest.verifyRoot(hashes, rootHash)).toBe(true);
        expect(await FileManifest.verifyRoot(hashes, '00'.repeat(32))).toBe(false);
    });

    test('verifyChunk matches a chunk against its committed hash', async () => {
        const data = new Uint8Array([10, 20, 30]).buffer;
        const hashes = [await IntegrityVerifier.hash(data)];
        expect(await FileManifest.verifyChunk(hashes, 0, data)).toBe(true);
        expect(await FileManifest.verifyChunk(hashes, 0, new Uint8Array([9, 9, 9]).buffer)).toBe(false);
        expect(await FileManifest.verifyChunk(hashes, 5, data)).toBe(false); // out of range
    });
});
