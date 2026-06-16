import { describe, test, expect } from 'vitest';
import { DestinationManager } from '../storage/DestinationManager.js';
import { BatchSender } from '../transfer/BatchSender.js';
import { BatchReceiver } from '../transfer/BatchReceiver.js';
import { buildBatch } from '../transfer/FileTree.js';

// A minimal in-memory fake of the File System Access directory/file handles, enough
// to exercise writeTree's structure-preserving behaviour and its path validation.
function makeFile(name) {
    let data = null;
    return {
        name,
        kind: 'file',
        _read: () => data,
        async createWritable() {
            return {
                async write(b) { data = b; },
                async close() {},
            };
        },
    };
}
function makeDir(name = '') {
    const children = new Map();
    return {
        name,
        kind: 'directory',
        children,
        async getDirectoryHandle(seg, { create } = {}) {
            if (!children.has(seg)) {
                if (!create) throw new Error('not found');
                children.set(seg, makeDir(seg));
            }
            return children.get(seg);
        },
        async getFileHandle(seg, { create } = {}) {
            if (!children.has(seg)) {
                if (!create) throw new Error('not found');
                children.set(seg, makeFile(seg));
            }
            return children.get(seg);
        },
    };
}

// Flatten the fake tree to { 'a/b.txt': <Uint8Array>, 'a/empty/': null }.
async function flatten(dir, prefix = '') {
    const out = {};
    for (const [name, handle] of dir.children) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            const sub = await flatten(handle, path);
            if (Object.keys(sub).length === 0) out[`${path}/`] = null; // empty dir marker
            Object.assign(out, sub);
        } else {
            const d = handle._read();
            // Writables may be handed a Blob or a BufferSource; normalize to bytes.
            out[path] = d && typeof d.arrayBuffer === 'function'
                ? new Uint8Array(await d.arrayBuffer())
                : (d ? new Uint8Array(d) : d);
        }
    }
    return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

describe('DestinationManager.writeTree (Feature 5)', () => {
    test('writes a nested tree preserving structure, paths and empty dirs', async () => {
        const dm = new DestinationManager();
        const root = makeDir();
        const entries = [
            { name: 'root/empty', dir: true },
            { name: 'root/a.txt', blob: new Blob([te.encode('alpha')]) },
            { name: 'root/sub/b.txt', blob: new Blob([te.encode('bravo')]) },
        ];
        const stats = await dm.writeTree(root, entries);
        expect(stats.files).toBe(2);

        const flat = await flatten(root);
        expect(td.decode(flat['root/a.txt'])).toBe('alpha');
        expect(td.decode(flat['root/sub/b.txt'])).toBe('bravo');
        expect('root/empty/' in flat).toBe(true); // empty directory created
    });

    test('refuses traversal / unsafe path segments (no arbitrary write)', async () => {
        const dm = new DestinationManager();
        const root = makeDir();
        await expect(dm.writeTree(root, [{ name: '../escape.txt', blob: new Blob([te.encode('x')]) }]))
            .rejects.toThrow(/unsafe|illegal/i);
        // Nothing was written outside the root.
        expect(root.children.size).toBe(0);
    });

    test('writeFile places a single file with its subpath', async () => {
        const dm = new DestinationManager();
        const root = makeDir();
        await dm.writeFile(root, 'docs/readme.md', new Blob([te.encode('hi')]));
        const flat = await flatten(root);
        expect(td.decode(flat['docs/readme.md'])).toBe('hi');
    });
});

// ── End-to-end: a received batch is written straight to the chosen directory ──
function makeChannelPair() {
    const make = () => ({
        _onMessage: null, peer: null,
        onMessage(h) { this._onMessage = h; },
        async send(_i, d) { this._dispatch(d); },
        async sendAny(d) { this._dispatch(d); return 0; },
        _dispatch(d) { const p = this.peer; queueMicrotask(() => p._onMessage && p._onMessage(d, 0)); },
        getChannelStats() { return [{ index: 0, state: 'open', bufferedAmount: 0, throughput: 0 }]; },
        resetStats() {}, closeAll() {},
    });
    const a = make(); const b = make(); a.peer = b; b.peer = a; return [a, b];
}
function makeStorage() {
    const chunks = new Map(); let meta = null;
    return {
        async initFile(m) { meta = m; chunks.clear(); },
        getMode() { return 'memory'; },
        async writeChunk(i, d) { chunks.set(i, new Uint8Array(d)); },
        async assembleFile() {
            const ordered = [...chunks.keys()].sort((x, y) => x - y).map((k) => chunks.get(k));
            const out = new Uint8Array(ordered.reduce((n, c) => n + c.byteLength, 0));
            let off = 0; for (const c of ordered) { out.set(c, off); off += c.byteLength; }
            return new Blob([out], { type: meta?.fileType || 'application/octet-stream' });
        },
    };
}
function makeResume() {
    const received = new Set(); let total = 0;
    return {
        async init(_id, t) { total = t; }, async recoverFromStorage() { return null; },
        hasChunk(_id, i) { return received.has(i); }, markChunkReceived(_id, i) { received.add(i); },
        getMissingChunks() { const m = []; for (let i = 0; i < total; i++) if (!received.has(i)) m.push(i); return m; },
        getProgress() { return total ? (received.size / total) * 100 : 0; },
        isComplete() { return total > 0 && received.size === total; },
        async clear() {}, flush() { return Promise.resolve(); },
    };
}

describe('BatchReceiver → directory destination (Feature 5)', () => {
    test('writes the reconstructed folder tree to a chosen directory instead of zipping', async () => {
        const dm = new DestinationManager();
        const dest = makeDir('Downloads');
        const [senderEp, receiverEp] = makeChannelPair();

        const batch = buildBatch({
            files: [
                { file: new File([te.encode('alpha')], 'a.txt'), relativePath: 'pkg/a.txt' },
                { file: new File([te.encode('bravo')], 'b.txt'), relativePath: 'pkg/sub/b.txt' },
            ],
            directories: ['pkg', 'pkg/sub', 'pkg/empty'],
        });

        const result = await new Promise((resolve, reject) => {
            const receiver = new BatchReceiver(receiverEp, Promise.resolve(null), {
                onComplete: (blob, name, isArchive, info) => resolve({ blob, name, isArchive, info }),
                onError: reject,
            }, {
                makeStorage, makeResume,
                getDestination: async () => dest,
                writeTree: (h, e) => dm.writeTree(h, e),
            });
            receiver.start();
            new BatchSender(batch, senderEp, null, { onError: reject }).start().catch(reject);
        });

        // Written to disk → no blob to download, info flags the destination.
        expect(result.blob).toBeNull();
        expect(result.info.writtenToDisk).toBe(true);
        expect(result.info.location).toBe('Downloads');

        const flat = await flatten(dest);
        expect(td.decode(flat['pkg/a.txt'])).toBe('alpha');
        expect(td.decode(flat['pkg/sub/b.txt'])).toBe('bravo');
        expect('pkg/empty/' in flat).toBe(true);
    });
});
