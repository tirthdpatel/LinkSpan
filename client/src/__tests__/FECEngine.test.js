import { describe, test, expect } from 'vitest';
import {
    FECEncoder,
    FECDecoder,
    adaptiveGroupSize,
    FEC_MIN_GROUP,
    FEC_MAX_GROUP,
    fecParityIndex,
    fecGroupFromIndex,
    isFecParityIndex,
} from '../transfer/FECEngine.js';
import { ChunkManager } from '../transfer/ChunkManager.js';

/**
 * Create a random ArrayBuffer of `size` bytes.
 */
function randomBuffer(size) {
    const buf = new ArrayBuffer(size);
    const view = new Uint8Array(buf);
    for (let i = 0; i < size; i++) view[i] = Math.floor(Math.random() * 256);
    return buf;
}

describe('adaptiveGroupSize', () => {
    test('returns max group for 0% loss', () => {
        expect(adaptiveGroupSize(0)).toBe(FEC_MAX_GROUP);
        expect(adaptiveGroupSize(-0.01)).toBe(FEC_MAX_GROUP);
        expect(adaptiveGroupSize(NaN)).toBe(FEC_MAX_GROUP);
    });

    test('scales inversely with loss rate', () => {
        expect(adaptiveGroupSize(0.02)).toBe(FEC_MAX_GROUP); // 1/0.02=50, capped at 16
        expect(adaptiveGroupSize(0.05)).toBe(FEC_MAX_GROUP); // 1/0.05=20, capped at 16
        expect(adaptiveGroupSize(0.1)).toBe(10);  // 1/0.1=10
        expect(adaptiveGroupSize(0.25)).toBe(FEC_MIN_GROUP); // 1/0.25=4
        expect(adaptiveGroupSize(0.5)).toBe(FEC_MIN_GROUP);  // 1/0.5=2, floored to 4
    });
});

describe('FEC parity frame namespacing', () => {
    test('parity index survives the unsigned u32 chunk framing round-trip', () => {
        // Regression: packChunk writes the index as an UNSIGNED u32, so a plain negative
        // parity index would wrap into the valid chunk-index range and be misrouted.
        for (const groupId of [0, 1, 7, 255, 7000]) {
            const parityData = randomBuffer(64);
            const packed = ChunkManager.packChunk(fecParityIndex(groupId), parityData);
            const { index } = ChunkManager.unpackChunk(packed);
            expect(isFecParityIndex(index)).toBe(true);
            expect(fecGroupFromIndex(index)).toBe(groupId);
        }
    });

    test('real (small) chunk indices are never mistaken for parity', () => {
        for (const idx of [0, 1, 100, 1_000_000, 50_000_000]) {
            const packed = ChunkManager.packChunk(idx, randomBuffer(8));
            const { index } = ChunkManager.unpackChunk(packed);
            expect(isFecParityIndex(index)).toBe(false);
        }
    });
});

describe('FECEncoder', () => {
    test('emits parity after groupSize chunks', () => {
        const encoder = new FECEncoder(4);
        const chunks = Array.from({ length: 4 }, () => randomBuffer(256));

        expect(encoder.addChunk(0, chunks[0])).toBeNull();
        expect(encoder.addChunk(1, chunks[1])).toBeNull();
        expect(encoder.addChunk(2, chunks[2])).toBeNull();

        const parity = encoder.addChunk(3, chunks[3]);
        expect(parity).not.toBeNull();
        expect(parity.groupId).toBe(0);
        expect(parity.groupStart).toBe(0);
        expect(parity.groupSize).toBe(4);
        expect(parity.parityData).toBeInstanceOf(ArrayBuffer);
    });

    test('flush() emits parity for a partial group', () => {
        const encoder = new FECEncoder(8);
        for (let i = 0; i < 3; i++) {
            encoder.addChunk(i, randomBuffer(128));
        }
        const parity = encoder.flush();
        expect(parity).not.toBeNull();
        expect(parity.groupSize).toBe(3);
    });

    test('flush() returns null for a single-chunk partial group', () => {
        const encoder = new FECEncoder(8);
        encoder.addChunk(0, randomBuffer(128));
        expect(encoder.flush()).toBeNull();
    });

    test('emits per-chunk ciphertext lengths for length-safe reconstruction', () => {
        const encoder = new FECEncoder(4);
        const sizes = [100, 200, 150, 250];
        let parity;
        sizes.forEach((s, i) => { parity = encoder.addChunk(i, randomBuffer(s)); });
        expect(parity.chunkLengths).toEqual(sizes);
    });
});

describe('FECDecoder', () => {
    test('reconstructs a single missing chunk from parity', () => {
        const groupSize = 4;
        const chunkSize = 256;
        const encoder = new FECEncoder(groupSize);
        const decoder = new FECDecoder();

        // Generate chunks and encode parity
        const chunks = Array.from({ length: groupSize }, () => randomBuffer(chunkSize));
        let parity;
        for (let i = 0; i < groupSize; i++) {
            parity = encoder.addChunk(i, chunks[i]);
        }
        expect(parity).not.toBeNull();

        // Register parity with decoder
        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData);

        // Simulate receiving all chunks EXCEPT chunk 2
        for (let i = 0; i < groupSize; i++) {
            if (i !== 2) decoder.addChunk(i, chunks[i], parity.groupId);
        }

        // Reconstruct missing chunk 2
        const recovered = decoder.tryReconstruct(parity.groupId);
        expect(recovered).not.toBeNull();
        expect(recovered.chunkIndex).toBe(2);
        expect(new Uint8Array(recovered.data)).toEqual(new Uint8Array(chunks[2]));
    });

    test('returns null when 2+ chunks are missing', () => {
        const groupSize = 4;
        const encoder = new FECEncoder(groupSize);
        const decoder = new FECDecoder();

        const chunks = Array.from({ length: groupSize }, () => randomBuffer(128));
        let parity;
        for (let i = 0; i < groupSize; i++) {
            parity = encoder.addChunk(i, chunks[i]);
        }

        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData);
        // Only provide chunks 0 and 1 (missing 2 and 3)
        decoder.addChunk(0, chunks[0], parity.groupId);
        decoder.addChunk(1, chunks[1], parity.groupId);

        expect(decoder.tryReconstruct(parity.groupId)).toBeNull();
    });

    test('reconstructs first chunk in group', () => {
        const groupSize = 4;
        const encoder = new FECEncoder(groupSize);
        const decoder = new FECDecoder();

        const chunks = Array.from({ length: groupSize }, () => randomBuffer(200));
        let parity;
        for (let i = 0; i < groupSize; i++) {
            parity = encoder.addChunk(i, chunks[i]);
        }

        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData);
        for (let i = 1; i < groupSize; i++) {
            decoder.addChunk(i, chunks[i], parity.groupId);
        }

        const recovered = decoder.tryReconstruct(parity.groupId);
        expect(recovered).not.toBeNull();
        expect(recovered.chunkIndex).toBe(0);
        expect(new Uint8Array(recovered.data)).toEqual(new Uint8Array(chunks[0]));
    });

    test('reconstructs last chunk in group', () => {
        const groupSize = 4;
        const encoder = new FECEncoder(groupSize);
        const decoder = new FECDecoder();

        const chunks = Array.from({ length: groupSize }, () => randomBuffer(200));
        let parity;
        for (let i = 0; i < groupSize; i++) {
            parity = encoder.addChunk(i, chunks[i]);
        }

        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData);
        for (let i = 0; i < groupSize - 1; i++) {
            decoder.addChunk(i, chunks[i], parity.groupId);
        }

        const recovered = decoder.tryReconstruct(parity.groupId);
        expect(recovered).not.toBeNull();
        expect(recovered.chunkIndex).toBe(3);
        expect(new Uint8Array(recovered.data)).toEqual(new Uint8Array(chunks[3]));
    });

    test('handles variable-length chunks (pads with zeros)', () => {
        const groupSize = 4;
        const encoder = new FECEncoder(groupSize);
        const decoder = new FECDecoder();

        // Different sized chunks
        const chunks = [
            randomBuffer(100),
            randomBuffer(200),
            randomBuffer(150),
            randomBuffer(250),
        ];
        let parity;
        for (let i = 0; i < groupSize; i++) {
            parity = encoder.addChunk(i, chunks[i]);
        }

        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData);
        // Drop chunk 1 (200 bytes)
        decoder.addChunk(0, chunks[0], parity.groupId);
        decoder.addChunk(2, chunks[2], parity.groupId);
        decoder.addChunk(3, chunks[3], parity.groupId);

        const recovered = decoder.tryReconstruct(parity.groupId);
        expect(recovered).not.toBeNull();
        expect(recovered.chunkIndex).toBe(1);
        // First 200 bytes should match (the rest may be zero-padded)
        const expected = new Uint8Array(chunks[1]);
        const actual = new Uint8Array(recovered.data).slice(0, expected.length);
        expect(actual).toEqual(expected);
    });

    test('trims a reconstructed chunk to its exact length when chunkLengths given', () => {
        // GCM decryption rejects a wrong-length input, so a reconstructed chunk must be
        // trimmed back from the group's zero-padded max length to its true length.
        const encoder = new FECEncoder(4);
        const chunks = [randomBuffer(100), randomBuffer(200), randomBuffer(150), randomBuffer(250)];
        let parity;
        for (let i = 0; i < 4; i++) parity = encoder.addChunk(i, chunks[i]);

        const decoder = new FECDecoder();
        decoder.addParity(parity.groupId, parity.groupStart, parity.groupSize, parity.parityData, parity.chunkLengths);
        // Drop chunk 1 (200 bytes) — the others are longer, so the group max is 250.
        decoder.addChunk(0, chunks[0], parity.groupId);
        decoder.addChunk(2, chunks[2], parity.groupId);
        decoder.addChunk(3, chunks[3], parity.groupId);

        const recovered = decoder.tryReconstruct(parity.groupId);
        expect(recovered.chunkIndex).toBe(1);
        expect(recovered.data.byteLength).toBe(200); // trimmed exactly, not padded to 250
        expect(new Uint8Array(recovered.data)).toEqual(new Uint8Array(chunks[1]));
    });

    test('groupIdForIndex routes a chunk index to its registered group', () => {
        const decoder = new FECDecoder();
        decoder.addParity(0, 0, 4, randomBuffer(100));   // covers indices 0..3
        decoder.addParity(1, 4, 4, randomBuffer(100));   // covers indices 4..7
        expect(decoder.groupIdForIndex(2)).toBe(0);
        expect(decoder.groupIdForIndex(5)).toBe(1);
        expect(decoder.groupIdForIndex(99)).toBeNull();
    });

    test('isGroupComplete returns true when all chunks received', () => {
        const decoder = new FECDecoder();
        decoder.addParity(0, 0, 3, randomBuffer(100));
        decoder.addChunk(0, randomBuffer(100), 0);
        decoder.addChunk(1, randomBuffer(100), 0);
        expect(decoder.isGroupComplete(0)).toBe(false);
        decoder.addChunk(2, randomBuffer(100), 0);
        expect(decoder.isGroupComplete(0)).toBe(true);
    });

    test('removeGroup frees memory', () => {
        const decoder = new FECDecoder();
        decoder.addParity(0, 0, 4, randomBuffer(100));
        decoder.removeGroup(0);
        expect(decoder.tryReconstruct(0)).toBeNull();
    });
});
