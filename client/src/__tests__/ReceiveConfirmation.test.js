import { describe, test, expect, vi } from 'vitest';
import { BatchSender } from '../transfer/BatchSender.js';
import { BatchReceiver } from '../transfer/BatchReceiver.js';
import { buildBatch } from '../transfer/FileTree.js';
import { TRANSFER_MSG, TRANSFER_TYPE } from '@shared/constants.js';

// Reuse the in-memory channel pair pattern from BatchTransfer.test.
function makeChannelPair() {
    const make = () => ({
        _onMessage: null,
        peer: null,
        sent: [],
        onMessage(h) { this._onMessage = h; },
        async send(_i, data) { this._dispatch(data); },
        async sendAny(data) { this.sent.push(data); this._dispatch(data); return 0; },
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
        getMissingChunks() { const m = []; for (let i = 0; i < total; i++) if (!received.has(i)) m.push(i); return m; },
        getProgress() { return total ? (received.size / total) * 100 : 0; },
        isComplete() { return total > 0 && received.size === total; },
        async clear() {},
        flush() { return Promise.resolve(); },
    };
}

const te = new TextEncoder();
function fileBatch() {
    return buildBatch({
        files: [{ file: new File([te.encode('secret payload')], 'doc.txt'), relativePath: 'doc.txt' }],
        directories: [],
    });
}

describe('Receive confirmation workflow (Feature 4)', () => {
    test('sender announces identity + type and blocks until the receiver accepts', async () => {
        const [senderEp, receiverEp] = makeChannelPair();
        const awaiting = vi.fn();
        let approvalMeta = null;

        const done = new Promise((resolve, reject) => {
            const receiver = new BatchReceiver(receiverEp, Promise.resolve(null), {
                requestApproval: async (meta) => { approvalMeta = meta; return { accept: true, remember: false }; },
                onComplete: (blob) => resolve(blob),
                onError: reject,
            }, { makeStorage, makeResume });
            receiver.start();

            const sender = new BatchSender(fileBatch(), senderEp, null, {
                onAwaitingApproval: awaiting,
                onError: reject,
            }, { identity: { deviceId: 'abc123', deviceName: 'Test Mac' }, transferType: TRANSFER_TYPE.FILES });
            sender.start().catch(reject);
        });

        const blob = await done;
        // Sender entered the awaiting-approval state.
        expect(awaiting).toHaveBeenCalled();
        // Receiver saw the announced identity + summary fields.
        expect(approvalMeta.senderName).toBe('Test Mac');
        expect(approvalMeta.senderDeviceId).toBe('abc123');
        expect(approvalMeta.transferType).toBe(TRANSFER_TYPE.FILES);
        expect(approvalMeta.fileCount).toBe(1);
        // The file actually transferred after acceptance.
        expect(await blob.text()).toBe('secret payload');
        // Receiver acknowledged with RECEIVE_ACCEPT before any chunk request.
        expect(receiverEp.sent.some((m) => typeof m === 'string' && m.includes(TRANSFER_MSG.RECEIVE_ACCEPT))).toBe(true);
    });

    test('rejection aborts: no file data flows and the sender is notified', async () => {
        const [senderEp, receiverEp] = makeChannelPair();
        const rejected = vi.fn();

        await new Promise((resolve, reject) => {
            const receiver = new BatchReceiver(receiverEp, Promise.resolve(null), {
                requestApproval: async () => ({ accept: false }),
                onRejected: () => {},
                onComplete: () => reject(new Error('should not complete on rejection')),
                onError: () => reject(new Error('should not error')),
            }, { makeStorage, makeResume });
            receiver.start();

            const sender = new BatchSender(fileBatch(), senderEp, null, {
                onRejected: () => { rejected(); resolve(); },
                onComplete: () => reject(new Error('sender should not complete')),
                onError: (e) => reject(e),
            }, { identity: { deviceId: 'x', deviceName: 'Y' } });
            sender.start().catch(reject);
        });

        expect(rejected).toHaveBeenCalled();
        // The receiver never requested a chunk.
        expect(receiverEp.sent.some((m) => typeof m === 'string' && m.includes(TRANSFER_MSG.CHUNK_REQUEST))).toBe(false);
        expect(receiverEp.sent.some((m) => typeof m === 'string' && m.includes(TRANSFER_MSG.RECEIVE_REJECT))).toBe(true);
    });

    test('the sender offer expires if the receiver never responds', async () => {
        vi.useFakeTimers();
        const [senderEp] = makeChannelPair(); // receiver endpoint left unwired (silent peer)

        const errSpy = vi.fn();
        const sender = new BatchSender(fileBatch(), senderEp, null, {
            onError: errSpy,
        });
        const started = sender.start();
        // Fast-forward past the approval timeout.
        await vi.advanceTimersByTimeAsync(61_000);
        await started;

        expect(errSpy).toHaveBeenCalled();
        expect(errSpy.mock.calls[0][0].message).toMatch(/did not respond/i);
        vi.useRealTimers();
    });
});
