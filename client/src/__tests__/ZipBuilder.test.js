import { describe, test, expect } from 'vitest';
import { buildZip, _internal } from '../transfer/ZipBuilder.js';

const td = new TextDecoder();
const te = new TextEncoder();

describe('ZipBuilder — CRC32', () => {
    test('matches the canonical CRC-32 of "123456789"', () => {
        const crc = _internal.crc32Update(0, te.encode('123456789'));
        expect(crc >>> 0).toBe(0xcbf43926);
    });

    test('streaming CRC over a Blob equals one-shot CRC', async () => {
        const bytes = te.encode('the quick brown fox jumps over the lazy dog');
        const oneShot = _internal.crc32Update(0, bytes);
        const streamed = await _internal.crc32OfBlob(new Blob([bytes]), 8);
        expect(streamed).toBe(oneShot);
    });
});

/**
 * Minimal STORE-only ZIP reader, sufficient to validate ZipBuilder output:
 * parses the End Of Central Directory, walks the central directory for names and
 * local-header offsets, then reads each entry's stored bytes from its local header.
 */
async function parseStoreZip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);

    // Find EOCD (0x06054b50) scanning back from the end.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    expect(eocd).toBeGreaterThanOrEqual(0);
    const total = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);

    const entries = [];
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
        expect(dv.getUint32(p, true)).toBe(0x02014b50);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const lho = dv.getUint32(p + 42, true);
        const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
        const crc = dv.getUint32(p + 16, true);
        entries.push({ name, lho, crc });
        p += 46 + nameLen + extraLen + commentLen;
    }

    // Read stored data from each local header.
    for (const e of entries) {
        expect(dv.getUint32(e.lho, true)).toBe(0x04034b50);
        const compSize = dv.getUint32(e.lho + 18, true);
        const nameLen = dv.getUint16(e.lho + 26, true);
        const extraLen = dv.getUint16(e.lho + 28, true);
        const dataStart = e.lho + 30 + nameLen + extraLen;
        e.data = buf.subarray(dataStart, dataStart + compSize);
    }
    return entries;
}

describe('ZipBuilder — archive structure', () => {
    test('produces a valid STORE archive with files and an empty directory', async () => {
        const blob = await buildZip([
            { name: 'empty', dir: true },
            { name: 'a.txt', blob: new Blob([te.encode('hello')]) },
            { name: 'dir/b.txt', blob: new Blob([te.encode('world')]) },
        ]);
        expect(blob.type).toBe('application/zip');

        const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        expect([head[0], head[1], head[2], head[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

        const entries = await parseStoreZip(blob);
        const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

        expect(Object.keys(byName).sort()).toEqual(['a.txt', 'dir/b.txt', 'empty/']);
        expect(td.decode(byName['a.txt'].data)).toBe('hello');
        expect(td.decode(byName['dir/b.txt'].data)).toBe('world');
        expect(byName['empty/'].data.length).toBe(0);

        // Stored CRC must match the data.
        expect(byName['a.txt'].crc >>> 0).toBe(_internal.crc32Update(0, te.encode('hello')));
    });

    test('handles many entries (count in EOCD)', async () => {
        const entries = [];
        for (let i = 0; i < 50; i++) {
            entries.push({ name: `f${i}.bin`, blob: new Blob([te.encode(`data-${i}`)]) });
        }
        const blob = await buildZip(entries);
        const parsed = await parseStoreZip(blob);
        expect(parsed.length).toBe(50);
        expect(td.decode(parsed.find((e) => e.name === 'f7.bin').data)).toBe('data-7');
    });
});
