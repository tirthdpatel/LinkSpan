import { describe, test, expect } from 'vitest';
import { BatchSender } from '../transfer/BatchSender.js';
import { BatchReceiver } from '../transfer/BatchReceiver.js';
import { buildBatch } from '../transfer/FileTree.js';

// End-to-end batch/folder transfer: real BatchSender → in-memory channel pair →
// real BatchReceiver, exercising the per-file Sender/Receiver engine for each file,
// sequential FILE_COMPLETE acking, and ZIP reconstruction (incl. an empty folder).

function makeChannelPair() {
    const make = () => ({
        _onMessage: null,
        peer: null,
        onMessage(h) { this._onMessage = h; },
        onFirstMessage() {},
        offFirstMessage() {},
        async send(_i, data) { this._dispatch(data); },
        async sendAny(data) { this._dispatch(data); return 0; },
        _dispatch(data) {
            const peer = this.peer;
            queueMicrotask(() => { if (peer._onMessage) peer._onMessage(data, 0); });
        },
        getChannelStats() { return [{ index: 0, state: 'open', bufferedAmount: 0, throughput: 0 }]; },
        resetStats() {},
        closeAll() {},
    });
    const a = make();
    const b = make();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

function makeStorage() {
    const chunks = new Map();
    let meta = null;
    return {
        async initFile(m) { meta = m; chunks.clear(); },
        getMode() { return 'memory'; },
        async writeChunk(i, d) { chunks.set(i, new Uint8Array(d)); },
        async assembleFile() {
            const ordered = [...chunks.keys()].sort((x, y) => x - y).map((k) => chunks.get(k));
            const total = ordered.reduce((n, c) => n + c.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of ordered) { out.set(c, off); off += c.byteLength; }
            return new Blob([out], { type: meta?.fileType || 'application/octet-stream' });
        },
    };
}

function makeResume() {
    const received = new Set();
    let total = 0;
    return {
        async init(_id, t) { total = t; },
        async recoverFromStorage() { return null; },
        hasChunk(_id, i) { return received.has(i); },
        markChunkReceived(_id, i) { received.add(i); },
        getMissingChunks() {
            const m = [];
            for (let i = 0; i < total; i++) if (!received.has(i)) m.push(i);
            return m;
        },
        getProgress() { return total ? (received.size / total) * 100 : 0; },
        isComplete() { return total > 0 && received.size === total; },
        async clear() {},
        flush() { return Promise.resolve(); },
    };
}

const te = new TextEncoder();
const td = new TextDecoder();

function randomBytes(n) {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += 65536) {
        crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
    }
    return out;
}

// Minimal STORE-zip parser (see ZipBuilder.test.js for the documented version).
async function parseStoreZip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    const total = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const lho = dv.getUint32(p + 42, true);
        const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
        entries.push({ name, lho });
        p += 46 + nameLen + extraLen + commentLen;
    }
    for (const e of entries) {
        const compSize = dv.getUint32(e.lho + 18, true);
        const nameLen = dv.getUint16(e.lho + 26, true);
        const extraLen = dv.getUint16(e.lho + 28, true);
        const dataStart = e.lho + 30 + nameLen + extraLen;
        e.data = buf.subarray(dataStart, dataStart + compSize);
    }
    return entries;
}

function runBatch(batch) {
    const [senderEp, receiverEp] = makeChannelPair();
    return new Promise((resolve, reject) => {
        const receiver = new BatchReceiver(
            receiverEp,
            Promise.resolve(null), // no encryption in this test
            {
                onComplete: (blob, name, isArchive) => resolve({ blob, name, isArchive }),
                onError: reject,
            },
            { makeStorage, makeResume }
        );
        receiver.start();

        const sender = new BatchSender(batch, senderEp, null, {
            onError: reject,
        });
        sender.start().catch(reject);
    });
}

describe('Batch / folder transfer end-to-end', () => {
    test('reconstructs a folder tree (nested + empty dir) into a ZIP, bytes intact', async () => {
        const aBytes = randomBytes(200 * 1024); // multi-chunk
        const bBytes = te.encode('hello world');
        const batch = buildBatch({
            files: [
                { file: new File([aBytes], 'a.bin'), relativePath: 'root/a.bin' },
                { file: new File([bBytes], 'b.txt'), relativePath: 'root/sub/b.txt' },
            ],
            directories: ['root', 'root/sub', 'root/empty'],
        });

        const { blob, name, isArchive } = await runBatch(batch);
        expect(isArchive).toBe(true);
        expect(name.endsWith('.zip')).toBe(true);

        const entries = await parseStoreZip(blob);
        const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

        // Files reconstructed at their exact relative paths.
        expect(new Uint8Array(byName['root/a.bin'].data)).toEqual(aBytes);
        expect(td.decode(byName['root/sub/b.txt'].data)).toBe('hello world');
        // Empty directory preserved.
        expect(byName['root/empty/']).toBeTruthy();
        expect(byName['root/empty/'].data.length).toBe(0);
    });

    test('a single loose file is delivered as-is, not zipped', async () => {
        const bytes = randomBytes(50 * 1024);
        const batch = buildBatch({
            files: [{ file: new File([bytes], 'photo.jpg'), relativePath: 'photo.jpg' }],
            directories: [],
        });

        const { blob, name, isArchive } = await runBatch(batch);
        expect(isArchive).toBe(false);
        expect(name).toBe('photo.jpg');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    });

    test('multiple loose files are packaged together', async () => {
        const batch = buildBatch({
            files: [
                { file: new File([te.encode('one')], 'one.txt'), relativePath: 'one.txt' },
                { file: new File([te.encode('two')], 'two.txt'), relativePath: 'two.txt' },
                { file: new File([te.encode('three')], 'three.txt'), relativePath: 'three.txt' },
            ],
            directories: [],
        });

        const { isArchive, blob } = await runBatch(batch);
        expect(isArchive).toBe(true);
        const entries = await parseStoreZip(blob);
        const names = entries.map((e) => e.name).sort();
        expect(names).toEqual(['one.txt', 'three.txt', 'two.txt']);
    });
});
