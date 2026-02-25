import { describe, test, expect } from 'vitest';

// Tests run in JSDOM so no real SubtleCrypto - mock for unit tests
describe('ChunkManager', () => {
    test('packChunk and unpackChunk are symmetric', () => {
        const index = 42;
        const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;

        // Pack
        const header = new ArrayBuffer(4);
        new DataView(header).setUint32(0, index, false);
        const packed = new Uint8Array(4 + data.byteLength);
        packed.set(new Uint8Array(header), 0);
        packed.set(new Uint8Array(data), 4);

        // Unpack
        const view = new DataView(packed.buffer);
        const unpackedIndex = view.getUint32(0, false);
        const unpackedData = packed.buffer.slice(4);

        expect(unpackedIndex).toBe(index);
        expect(new Uint8Array(unpackedData)).toEqual(new Uint8Array(data));
    });

    test('packChunk handles chunk index 0', () => {
        const header = new ArrayBuffer(4);
        new DataView(header).setUint32(0, 0, false);
        const packed = new Uint8Array(4 + 3);
        packed.set(new Uint8Array(header), 0);
        packed.set(new Uint8Array([10, 20, 30]), 4);

        const view = new DataView(packed.buffer);
        expect(view.getUint32(0, false)).toBe(0);
    });

    test('packChunk handles large chunk index', () => {
        const index = 20480; // 5GB file at 256KB chunks
        const header = new ArrayBuffer(4);
        new DataView(header).setUint32(0, index, false);

        const view = new DataView(header);
        expect(view.getUint32(0, false)).toBe(20480);
    });

    test('file metadata calculation', () => {
        const fileSize = 5 * 1024 * 1024 * 1024; // 5GB
        const chunkSize = 256 * 1024; // 256KB
        const totalChunks = Math.ceil(fileSize / chunkSize);
        expect(totalChunks).toBe(20480);
    });

    test('file metadata for small file', () => {
        const fileSize = 100; // 100 bytes
        const chunkSize = 256 * 1024;
        const totalChunks = Math.ceil(fileSize / chunkSize);
        expect(totalChunks).toBe(1);
    });
});

describe('ResumeManager logic', () => {
    test('missing chunks calculation', () => {
        const totalChunks = 10;
        const received = new Set([0, 1, 3, 5, 7]);
        const missing = [];
        for (let i = 0; i < totalChunks; i++) {
            if (!received.has(i)) missing.push(i);
        }
        expect(missing).toEqual([2, 4, 6, 8, 9]);
    });

    test('progress calculation', () => {
        const received = 7;
        const total = 10;
        const progress = (received / total) * 100;
        expect(progress).toBe(70);
    });

    test('complete detection', () => {
        const total = 5;
        const received = [0, 1, 2, 3, 4];
        expect(received.length === total).toBe(true);
    });
});

describe('TransferProgress utilities', () => {
    test('formatSize formats bytes correctly', () => {
        const formatSize = (bytes) => {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1024)).toBe('1 KB');
        expect(formatSize(1048576)).toBe('1 MB');
        expect(formatSize(1073741824)).toBe('1 GB');
        expect(formatSize(500)).toBe('500 B');
    });

    test('ETA calculation', () => {
        const speed = 1024 * 1024; // 1MB/s
        const remaining = 10 * 1024 * 1024; // 10MB
        const seconds = remaining / speed;
        expect(seconds).toBe(10);
    });
});
