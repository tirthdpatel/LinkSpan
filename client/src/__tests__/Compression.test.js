import { describe, test, expect } from 'vitest';
import {
    maybeCompress,
    maybeDecompress,
    deflateRaw,
    inflateRaw,
    compressionSupported,
} from '../transfer/Compression.js';

const enc = (s) => new TextEncoder().encode(s).buffer;
const eq = (a, b) => {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
};

describe('Compression codec (per-chunk DEFLATE)', () => {
    test('runtime supports (de)compression under test', () => {
        expect(compressionSupported).toBe(true);
    });

    test('compresses repetitive data and round-trips exactly', async () => {
        const original = enc('hello world '.repeat(2000));
        const { data, compressed } = await maybeCompress(original);
        expect(compressed).toBe(true);
        expect(data.byteLength).toBeLessThan(original.byteLength);
        const back = await maybeDecompress(data, compressed);
        expect(eq(back, original)).toBe(true);
    });

    test('leaves incompressible (random) data verbatim — never expands it', async () => {
        const rnd = new Uint8Array(8192);
        crypto.getRandomValues(rnd);
        const { data, compressed } = await maybeCompress(rnd.buffer);
        expect(compressed).toBe(false);
        expect(data.byteLength).toBe(rnd.byteLength);
        // maybeDecompress must be a no-op when the flag is false.
        expect(eq(await maybeDecompress(data, false), rnd.buffer)).toBe(true);
    });

    test('empty chunk is a no-op', async () => {
        const { data, compressed } = await maybeCompress(new ArrayBuffer(0));
        expect(compressed).toBe(false);
        expect(data.byteLength).toBe(0);
    });

    test('deflateRaw/inflateRaw round-trip', async () => {
        const original = enc('the quick brown fox '.repeat(500));
        expect(eq(await inflateRaw(await deflateRaw(original)), original)).toBe(true);
    });
});
