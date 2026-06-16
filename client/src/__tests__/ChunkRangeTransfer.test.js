import { describe, test, expect } from 'vitest';
import { Sender } from '../transfer/Sender.js';
import { Receiver } from '../transfer/Receiver.js';
import { TRANSFER_MSG } from '@shared/constants.js';

// Protocol-level tests for range-list chunk requests (CHUNK_REQUEST_RANGE), driving a
// real Sender → in-memory channel → real Receiver (unencrypted: cryptoKey = null, so
// the wire carries plaintext chunks — fine, this exercises the REQUEST path).

/**
 * In-memory channel pair that records the control frames each side SENDS, so a test
 * can assert how the receiver framed its pulls (range vs per-chunk).
 */
function makeChannelPair() {
    const make = () => ({
        _onMessage: null,
        _onFirst: null,
        peer: null,
        sentText: [],   // JSON control frames this endpoint sent
        onMessage(h) { this._onMessage = h; },
        onFirstMessage(h) { this._onFirst = h; },
        offFirstMessage() { this._onFirst = null; },
        async send(_i, data) { this._dispatch(data); },
        async sendAny(data) { this._dispatch(data); return 0; },
        _dispatch(data) {
            if (typeof data === 'string') this.sentText.push(data);
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

/**
 * In-memory ResumeManager. `preReceived` seeds chunks as already-stored, simulating a
 * resumed transfer after an interrupt/reload — the receiver should then only pull the
 * remaining (sparse) gaps.
 */
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

function parse(frames) {
    return frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
}

describe('Range-list chunk requests (CHUNK_REQUEST_RANGE)', () => {
    test('range-capable receiver coalesces pulls and the file round-trips intact', async () => {
        const original = randomBytes(900 * 1024); // several chunks
        const file = new File([original], 'r.bin');
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, null);
        const fileMeta = { ...sender.getFileMeta(), supportsRangeRequest: true };
        expect(fileMeta.totalChunks).toBeGreaterThan(3);

        const blob = await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, makeStorage(), makeResume(fileMeta.totalChunks),
                () => {}, resolve, reject, null, null
            );
            sender.start();
            receiver.start();
        });

        const got = new Uint8Array(await blob.arrayBuffer());
        expect(got).toEqual(original);

        // The receiver used range frames, never per-chunk requests.
        const sent = parse(receiverEp.sentText);
        const rangeFrames = sent.filter((m) => m.type === TRANSFER_MSG.CHUNK_REQUEST_RANGE);
        const perChunk = sent.filter((m) => m.type === TRANSFER_MSG.CHUNK_REQUEST);
        expect(rangeFrames.length).toBeGreaterThan(0);
        expect(perChunk.length).toBe(0);
        // Each frame carries well-formed ranges.
        for (const f of rangeFrames) {
            expect(Array.isArray(f.ranges)).toBe(true);
            for (const r of f.ranges) {
                expect(Number.isInteger(r.start)).toBe(true);
                expect(r.count).toBeGreaterThan(0);
            }
        }
    });

    test('old receiver (no capability) falls back to per-chunk CHUNK_REQUEST', async () => {
        const original = randomBytes(600 * 1024);
        const file = new File([original], 'r.bin');
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, null);
        // No supportsRangeRequest flag → receiver must use per-chunk requests.
        const fileMeta = sender.getFileMeta();

        const blob = await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, makeStorage(), makeResume(fileMeta.totalChunks),
                () => {}, resolve, reject, null, null
            );
            sender.start();
            receiver.start();
        });

        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
        const sent = parse(receiverEp.sentText);
        expect(sent.filter((m) => m.type === TRANSFER_MSG.CHUNK_REQUEST).length).toBeGreaterThan(0);
        expect(sent.filter((m) => m.type === TRANSFER_MSG.CHUNK_REQUEST_RANGE).length).toBe(0);
    });

    test('interrupted/resumed transfer requests only the sparse gaps and completes', async () => {
        const original = randomBytes(700 * 1024);
        const file = new File([original], 'r.bin');
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, null);
        const fileMeta = { ...sender.getFileMeta(), supportsRangeRequest: true };
        const total = fileMeta.totalChunks;
        expect(total).toBeGreaterThanOrEqual(4);

        // Simulate a post-reload sparse ledger: every other chunk already received. The
        // receiver must pull the remaining gaps — but the storage doesn't actually hold
        // the "pre-received" chunks, so for a real round-trip we only pre-mark chunks we
        // also seed into storage.
        const storage = makeStorage();
        const preReceived = [];
        for (let i = 0; i < total; i += 2) {
            preReceived.push(i);
            const chunk = await sender.chunkManager.getChunk(i);
            await storage.writeChunk(i, chunk);
            // Simulate the same sender having served these chunks earlier this session,
            // so its manifest root (getOrderedHashes) covers the full file. (Resume from
            // a FRESH sender that only serves gaps is a separate, latent manifest gap —
            // out of scope here; this test targets the range-request path.)
            await sender.verifier.recordChunk(i, chunk);
        }
        const resume = makeResume(total, preReceived);
        const missingBefore = resume.getMissingChunks();
        expect(missingBefore.length).toBeGreaterThan(0);

        const blob = await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, resolve, reject, null, null
            );
            sender.start();
            receiver.start();
        });

        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);

        // Every requested index falls within the original missing set (no re-pulling of
        // already-received chunks).
        const sent = parse(receiverEp.sentText);
        const requested = new Set();
        for (const f of sent.filter((m) => m.type === TRANSFER_MSG.CHUNK_REQUEST_RANGE)) {
            for (const r of f.ranges) {
                for (let i = 0; i < r.count; i++) requested.add(r.start + i);
            }
        }
        expect(requested.size).toBeGreaterThan(0);
        for (const idx of requested) expect(missingBefore).toContain(idx);
    });

    test('sender ignores an invalid range frame without serving or crashing', async () => {
        const original = randomBytes(300 * 1024);
        const file = new File([original], 'r.bin');
        const [senderEp] = makeChannelPair();

        let errored = false;
        const sender = new Sender(file, senderEp, () => {}, null, () => { errored = true; }, null);
        sender.start();

        const total = sender.chunkManager.totalChunks;
        // Out-of-bounds range — must be rejected by validateRanges in the sender.
        await sender._handleChunkRequestRange([{ start: 0, count: total + 5 }]);
        // Overlapping ranges — also rejected.
        await sender._handleChunkRequestRange([{ start: 0, count: 2 }, { start: 1, count: 2 }]);
        // Negative start — rejected.
        await sender._handleChunkRequestRange([{ start: -1, count: 1 }]);

        // Let any erroneously-scheduled sends flush.
        await new Promise((r) => setTimeout(r, 10));

        expect(errored).toBe(false);
        // No chunk data was emitted in response to the invalid frames.
        expect(senderEp.sentText.filter((f) => f.includes(TRANSFER_MSG.CHUNK_DATA)).length).toBe(0);
    });
});
