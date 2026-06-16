import { describe, test, expect } from 'vitest';
import {
    pickChunkSize,
    DEFAULT_CHUNK_SIZE,
    GCM_OVERHEAD_BYTES,
    CHUNK_HEADER_BYTES,
} from '@shared/constants.js';

const MB = 1024 * 1024;

describe('pickChunkSize (Phase 4.3 dynamic chunking)', () => {
    test('scales with file size', () => {
        expect(pickChunkSize(200 * 1024)).toBe(64 * 1024);        // small → 64 KB
        expect(pickChunkSize(10 * MB)).toBe(256 * 1024 - GCM_OVERHEAD_BYTES - CHUNK_HEADER_BYTES); // capped
        expect(pickChunkSize(5 * 1024 * MB)).toBe(DEFAULT_CHUNK_SIZE - GCM_OVERHEAD_BYTES - CHUNK_HEADER_BYTES); // large → max
    });

    test('never returns a size whose framed ciphertext exceeds the 256 KB wire limit', () => {
        // This is the safety invariant: header + IV + plaintext + tag ≤ 256 KB,
        // for every file size, encrypted.
        const sizes = [0, 1, 1024, 200 * 1024, MB, 10 * MB, 100 * MB, 1024 * MB, 50 * 1024 * MB];
        for (const s of sizes) {
            const plaintext = pickChunkSize(s, true);
            const framed = CHUNK_HEADER_BYTES + GCM_OVERHEAD_BYTES + plaintext;
            expect(framed).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
            expect(plaintext).toBeGreaterThan(0);
        }
    });

    test('unencrypted transfers may use a slightly larger plaintext (no GCM overhead)', () => {
        const enc = pickChunkSize(5 * 1024 * MB, true);
        const plain = pickChunkSize(5 * 1024 * MB, false);
        expect(plain).toBe(DEFAULT_CHUNK_SIZE - CHUNK_HEADER_BYTES);
        expect(plain).toBeGreaterThan(enc);
        expect(CHUNK_HEADER_BYTES + plain).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    });

    test('degenerate sizes fall back to the max (no zero/negative chunks)', () => {
        expect(pickChunkSize(0)).toBeGreaterThan(0);
        expect(pickChunkSize(-5)).toBeGreaterThan(0);
        expect(pickChunkSize(NaN)).toBeGreaterThan(0);
    });
});
