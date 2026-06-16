import { describe, test, expect } from 'vitest';
import { Sender } from '../transfer/Sender.js';
import { Receiver } from '../transfer/Receiver.js';

// Regression test for the resume manifest-root bug: the sender's whole-file manifest
// root must cover EVERY chunk, not just the chunks served this session. On a resumed
// transfer the receiver only re-requests the missing gaps, so a sender that serves only
// those gaps must still re-hash the already-transferred chunks from the source when
// building the manifest — otherwise the root has empty slots and verification fails on
// an otherwise-perfect file.
//
// Unlike ChunkRangeTransfer.test.js's resume test, this one does NOT pre-record the
// sender's hashes, so it genuinely exercises the bug (it failed before the fix).

function makeChannelPair() {
    const make = () => ({
        _onMessage: null,
        _onFirst: null,
        peer: null,
        onMessage(h) { this._onMessage = h; },
        onFirstMessage(h) { this._onFirst = h; },
        offFirstMessage() { this._onFirst = null; },
        async send(_i, data) { this._dispatch(data); },
        async sendAny(data) { this._dispatch(data); return 0; },
        _dispatch(data) {
            const peer = this.peer;
            queueMicrotask(() => {
                if (peer._onFirst) peer._onFirst(data, 0);
                if (peer._onMessage) peer._onMessage(data, 0);
            });
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
        async initFile(m) { meta = m; },
        getMode() { return 'memory'; },
        async writeChunk(index, data) { chunks.set(index, new Uint8Array(data)); },
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

function makeResume(totalChunks, preReceived = []) {
    const received = new Set(preReceived);
    return {
        async init() {},
        async recoverFromStorage() { return null; },
        hasChunk(_id, i) { return received.has(i); },
        markChunkReceived(_id, i) { received.add(i); },
        getMissingChunks() {
            const m = [];
            for (let i = 0; i < totalChunks; i++) if (!received.has(i)) m.push(i);
            return m;
        },
        getProgress() { return (received.size / totalChunks) * 100; },
        isComplete() { return received.size === totalChunks; },
        async clear() {},
    };
}

function randomBytes(n) {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += 65536) {
        crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
    }
    return out;
}

describe('Resume whole-file manifest verification', () => {
    test('a fresh sender serving only the gap chunks still verifies whole-file', async () => {
        const original = randomBytes(800 * 1024);
        const file = new File([original], 'resume.bin');
        const [senderEp, receiverEp] = makeChannelPair();

        // Fresh sender (mid-transfer "page reload" → brand-new Sender instance that has
        // served NOTHING this session; its verifier is empty).
        const sender = new Sender(file, senderEp, () => {}, null, () => {}, null);
        const fileMeta = { ...sender.getFileMeta(), supportsRangeRequest: true };
        const total = fileMeta.totalChunks;
        expect(total).toBeGreaterThanOrEqual(3);

        // Prior session already received the even chunks: seed storage + resume ledger
        // ONLY. Crucially, do NOT pre-record the sender's hashes — the fix must re-hash
        // the unsent chunks from the source when building the manifest.
        const storage = makeStorage();
        const preReceived = [];
        for (let i = 0; i < total; i += 2) {
            preReceived.push(i);
            await storage.writeChunk(i, await sender.chunkManager.getChunk(i));
        }
        const resume = makeResume(total, preReceived);
        expect(sender.verifier.getVerifiedCount()).toBe(0); // sender served nothing yet

        const result = await new Promise((resolve) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, (blob) => resolve({ ok: true, blob }),
                (err) => resolve({ ok: false, err }), null, null
            );
            sender.start();
            receiver.start();
        });

        expect(result.ok).toBe(true); // would be false ("manifest root mismatch") before the fix
        const got = new Uint8Array(await result.blob.arrayBuffer());
        expect(got).toEqual(original);
    });

    test('_buildWholeFileHashes reuses recorded hashes and only reads the gaps', async () => {
        const original = randomBytes(500 * 1024);
        const file = new File([original], 'full.bin');
        const [senderEp] = makeChannelPair();
        const sender = new Sender(file, senderEp, () => {}, null, () => {}, null);
        const total = sender.chunkManager.totalChunks;
        expect(total).toBeGreaterThanOrEqual(2);

        // Spy on source reads.
        const reads = [];
        const realGetChunk = sender.chunkManager.getChunk.bind(sender.chunkManager);
        sender.chunkManager.getChunk = async (i) => { reads.push(i); return realGetChunk(i); };

        // Case A: nothing recorded yet (fully fresh resume) → must read every chunk.
        const a = await sender._buildWholeFileHashes(total);
        expect(a).toHaveLength(total);
        expect(a.every((h) => typeof h === 'string' && h.length === 64)).toBe(true);
        expect([...new Set(reads)].sort((x, y) => x - y))
            .toEqual(Array.from({ length: total }, (_, i) => i));

        // Case B: now that every chunk hash is recorded, a rebuild reads NOTHING extra.
        reads.length = 0;
        const b = await sender._buildWholeFileHashes(total);
        expect(b).toEqual(a);      // identical root inputs
        expect(reads).toEqual([]); // no source reads — reused the recorded hashes
    });
});
