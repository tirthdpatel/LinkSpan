import { describe, test, expect } from 'vitest';
import { ChunkManager } from '../transfer/ChunkManager.js';
import { DEFAULT_CHUNK_SIZE } from '@shared/constants.js';

// These tests exercise the REAL ChunkManager static methods and metadata math,
// rather than re-implementing the logic inline (which proves nothing).

describe('ChunkManager.packChunk / unpackChunk', () => {
    test('round-trips index and data symmetrically', () => {
        const index = 42;
        const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;

        const packed = ChunkManager.packChunk(index, data);
        const { index: outIndex, data: outData } = ChunkManager.unpackChunk(packed);

        expect(outIndex).toBe(index);
        expect(new Uint8Array(outData)).toEqual(new Uint8Array(data));
    });

    test('handles chunk index 0', () => {
        const packed = ChunkManager.packChunk(0, new Uint8Array([10, 20, 30]).buffer);
        expect(ChunkManager.unpackChunk(packed).index).toBe(0);
    });

    test('handles a large chunk index (5GB file at 256KB chunks)', () => {
        const index = 20480;
        const packed = ChunkManager.packChunk(index, new Uint8Array([1]).buffer);
        expect(ChunkManager.unpackChunk(packed).index).toBe(index);
    });

    test('prepends a 4-byte big-endian header', () => {
        const data = new Uint8Array([9, 9]).buffer;
        const packed = ChunkManager.packChunk(7, data);
        expect(packed.byteLength).toBe(4 + data.byteLength);
        expect(new DataView(packed).getUint32(0, false)).toBe(7);
    });
});

describe('ChunkManager metadata', () => {
    test('computes totalChunks for a large file', () => {
        // ChunkManager only reads .size for the chunk math, so a lightweight stub
        // lets us cover multi-GB sizing without allocating a real 5GB file.
        const hugeFile = { size: 5 * 1024 * 1024 * 1024, name: 'big.bin', type: '' };
        const cm = new ChunkManager(hugeFile, 256 * 1024);
        expect(cm.totalChunks).toBe(20480);
    });

    test('a file smaller than one chunk yields exactly one chunk', () => {
        const file = new File([new Uint8Array(100)], 'tiny.bin');
        const cm = new ChunkManager(file);
        expect(cm.totalChunks).toBe(1);
    });

    test('getFileMeta exposes the fields the receiver needs', () => {
        const file = new File([new Uint8Array(10)], 'note.txt', { type: 'text/plain' });
        const cm = new ChunkManager(file);
        const meta = cm.getFileMeta();
        expect(meta.fileName).toBe('note.txt');
        expect(meta.fileType).toBe('text/plain');
        expect(meta.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
        expect(meta.totalChunks).toBe(1);
        expect(typeof meta.fileId).toBe('string');
        expect(meta.fileId.length).toBeGreaterThan(0);
    });

    test('getChunk rejects an out-of-range index', async () => {
        const file = new File([new Uint8Array(10)], 'note.txt');
        const cm = new ChunkManager(file);
        await expect(cm.getChunk(99)).rejects.toThrow(/out of range/);
    });
});
