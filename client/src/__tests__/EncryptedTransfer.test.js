import { describe, test, expect } from 'vitest';
import { Sender } from '../transfer/Sender.js';
import { Receiver } from '../transfer/Receiver.js';
import { CryptoEngine } from '../crypto/CryptoEngine.js';

// End-to-end integration test of the encrypted transfer pipeline:
//   real Sender → in-memory channel → real Receiver, with real AES-256-GCM +
//   ECDH-derived session keys. Proves (a) the file round-trips intact and
//   (b) what crosses the wire is ciphertext, not plaintext — so a relay can't
//   read it. Runs in the Node env (Web Crypto via setup.js).

/**
 * A pair of in-memory channel endpoints implementing the subset of the
 * ChannelManager API that Sender/Receiver use. Messages delivered to the peer
 * asynchronously (microtask) to preserve send ordering, mimicking a real channel.
 */
function makeChannelPair() {
    const make = () => ({
        _onMessage: null,
        _onFirst: null,
        peer: null,
        sentBinary: [],
        onMessage(h) { this._onMessage = h; },
        onFirstMessage(h) { this._onFirst = h; },
        offFirstMessage() { this._onFirst = null; },
        async send(_i, data) { this._dispatch(data); },
        async sendAny(data) { this._dispatch(data); return 0; },
        _dispatch(data) {
            if (data instanceof ArrayBuffer) this.sentBinary.push(data);
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

/** Minimal in-memory StorageManager. */
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

/** Minimal in-memory ResumeManager (chunk ledger). */
function makeResume(totalChunks) {
    const received = new Set();
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

async function deriveSessionKeys() {
    const kpA = await CryptoEngine.generateECDHKeyPair();
    const kpB = await CryptoEngine.generateECDHKeyPair();
    const pubA = await CryptoEngine.exportPublicKey(kpA);
    const pubB = await CryptoEngine.exportPublicKey(kpB);
    const keyA = await CryptoEngine.deriveSharedKey(kpA, pubB);
    const keyB = await CryptoEngine.deriveSharedKey(kpB, pubA);
    return { keyA, keyB };
}

describe('Encrypted Sender → Receiver round-trip', () => {
    test('a multi-chunk file is delivered intact and verified', async () => {
        const original = randomBytes(600 * 1024); // ~3 encrypted chunks
        const file = new File([original], 'secret.bin', { type: 'application/octet-stream' });

        const { keyA, keyB } = await deriveSessionKeys();
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, keyA);
        const fileMeta = sender.getFileMeta();
        expect(fileMeta.totalChunks).toBeGreaterThan(1);

        const storage = makeStorage();
        const resume = makeResume(fileMeta.totalChunks);

        const blob = await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, resolve, reject, null, keyB
            );
            sender.start();
            receiver.start();
        });

        const got = new Uint8Array(await blob.arrayBuffer());
        expect(got.byteLength).toBe(original.byteLength);
        expect(got).toEqual(original);
    });

    test('a single-chunk file finalizes without a manifest round-trip', async () => {
        const original = randomBytes(8 * 1024); // well under one chunk
        const file = new File([original], 'small.bin', { type: 'application/octet-stream' });

        const { keyA, keyB } = await deriveSessionKeys();
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, keyA);
        const fileMeta = sender.getFileMeta();
        expect(fileMeta.totalChunks).toBe(1);

        // Record every control frame the receiver emits so we can prove it never
        // asks for the whole-file manifest on the single-chunk fast path.
        const receiverSent = [];
        const origDispatch = receiverEp._dispatch.bind(receiverEp);
        receiverEp._dispatch = (data) => {
            if (typeof data === 'string') receiverSent.push(data);
            origDispatch(data);
        };

        const storage = makeStorage();
        const resume = makeResume(fileMeta.totalChunks);

        const blob = await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, resolve, reject, null, keyB
            );
            sender.start();
            receiver.start();
        });

        const got = new Uint8Array(await blob.arrayBuffer());
        expect(got).toEqual(original);
        // The latency win: no MANIFEST_REQUEST was sent.
        const askedForManifest = receiverSent.some((m) => {
            try { return JSON.parse(m).type === 'manifest-request'; } catch { return false; }
        });
        expect(askedForManifest).toBe(false);
    });

    test('bytes on the wire are ciphertext, not plaintext', async () => {
        const original = randomBytes(300 * 1024); // 2 encrypted chunks
        const file = new File([original], 'secret.bin');

        const { keyA, keyB } = await deriveSessionKeys();
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, keyA);
        const fileMeta = sender.getFileMeta();
        const storage = makeStorage();
        const resume = makeResume(fileMeta.totalChunks);

        await new Promise((resolve, reject) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, resolve, reject, null, keyB
            );
            sender.start();
            receiver.start();
        });

        // The sender pushed binary frames (4-byte index header + ciphertext). None of
        // them should contain the original plaintext bytes.
        expect(senderEp.sentBinary.length).toBeGreaterThan(0);
        const plainPrefix = original.subarray(0, 64);
        for (const frame of senderEp.sentBinary) {
            const body = new Uint8Array(frame).subarray(4); // strip index header
            expect(indexOfSub(body, plainPrefix)).toBe(-1);
        }
    });

    test('a wrong session key fails decryption (no silent corruption)', async () => {
        const original = randomBytes(120 * 1024); // 1 chunk
        const file = new File([original], 'secret.bin');

        const { keyA } = await deriveSessionKeys();
        const wrongKey = await CryptoEngine.generateKey(); // unrelated AES key
        const [senderEp, receiverEp] = makeChannelPair();

        const sender = new Sender(file, senderEp, () => {}, null, () => {}, keyA);
        const fileMeta = sender.getFileMeta();
        const storage = makeStorage();
        const resume = makeResume(fileMeta.totalChunks);

        const result = await new Promise((resolve) => {
            const receiver = new Receiver(
                fileMeta, receiverEp, storage, resume,
                () => {}, () => resolve('completed'), () => resolve('errored'), null, wrongKey
            );
            sender.start();
            receiver.start();
        });

        // Decryption fails → treated as integrity failure → errors out after retries,
        // never completes with corrupt data.
        expect(result).toBe('errored');
    });

    test('whole-file manifest mismatch is rejected (no corrupt completion)', async () => {
        const [ep] = makeChannelPair();
        const fileMeta = { fileId: 'x', totalChunks: 2, chunkSize: 3, fileName: 'f', fileSize: 6, fileType: '' };

        let errored = false;
        let completed = false;
        const receiver = new Receiver(
            fileMeta, ep, makeStorage(), makeResume(2),
            () => {}, () => { completed = true; }, () => { errored = true; }
        );

        // Receiver has recorded two chunk hashes; feed it a bogus manifest root.
        await receiver.verifier.recordChunk(0, new Uint8Array([1, 2, 3]).buffer);
        await receiver.verifier.recordChunk(1, new Uint8Array([4, 5, 6]).buffer);
        await receiver._verifyManifestAndFinalize('00'.repeat(32));

        expect(errored).toBe(true);
        expect(completed).toBe(false);
    });
});

function indexOfSub(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}
