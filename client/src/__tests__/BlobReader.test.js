import { describe, test, expect } from 'vitest';
import { readBlobToArrayBuffer } from '../transfer/blobReader.js';

// A minimal Blob-like that reads from a backing Uint8Array, with a configurable number of
// initial NotReadableError failures per slice — models the transient mobile read hiccup.
function flakyBlob(bytes, failuresPerSlice = 0) {
    const fails = new Map();
    const make = (buf, from) => ({
        size: buf.length,
        slice(start, end) { return make(buf.subarray(start, end), (from || 0) + start); },
        async arrayBuffer() {
            const key = from || 0;
            const seen = fails.get(key) || 0;
            if (seen < failuresPerSlice) {
                fails.set(key, seen + 1);
                const e = new Error('The requested file could not be read');
                e.name = 'NotReadableError';
                throw e;
            }
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
        },
    });
    return make(bytes, 0);
}

describe('readBlobToArrayBuffer', () => {
    test('reads a small blob in one shot', async () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const buf = await readBlobToArrayBuffer(flakyBlob(data));
        expect(new Uint8Array(buf)).toEqual(data);
    });

    test('reassembles a large blob from slices in order', async () => {
        // 20 KB over a 4 KB slice size → 5 slices reassembled.
        const data = new Uint8Array(20 * 1024).map((_, i) => i % 256);
        const buf = await readBlobToArrayBuffer(flakyBlob(data), { sliceBytes: 4 * 1024 });
        expect(new Uint8Array(buf)).toEqual(data);
    });

    test('retries a transient NotReadableError and still succeeds', async () => {
        const data = new Uint8Array(12 * 1024).map((_, i) => i % 256);
        // Each slice fails once before succeeding — within the default retry budget.
        const buf = await readBlobToArrayBuffer(flakyBlob(data, 1), { sliceBytes: 4 * 1024 });
        expect(new Uint8Array(buf)).toEqual(data);
    });

    test('gives up after exhausting retries', async () => {
        const data = new Uint8Array([9, 9, 9]);
        await expect(
            readBlobToArrayBuffer(flakyBlob(data, 99), { retries: 1 })
        ).rejects.toThrow(/could not be read/);
    });
});
