/**
 * StorageBackend contract tests (Features 14/15 + S3/GCS cloud backends).
 *
 * One shared behavioral contract is run against every backend so the cloud backends are
 * provably interchangeable with the in-memory/filesystem ones. The S3 and GCS backends
 * are exercised over an *injected in-memory fake driver* — hermetic, no real cloud, no
 * extra dependencies. (Real AWS/GCP is exercised out-of-band via SHARE_STORAGE=s3|gcs.)
 *
 * Pure in-memory. Run: node --test tests/
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import {
    MemoryStorageBackend,
    blobKey,
    BlobTooLargeError,
    BlobNotFoundError,
} from '../src/share/StorageBackend.js';
import { S3StorageBackend } from '../src/share/S3StorageBackend.js';
import { GcsStorageBackend } from '../src/share/GcsStorageBackend.js';

function newId() {
    return crypto.randomBytes(16).toString('hex');
}

async function collect(stream) {
    const parts = [];
    for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(parts);
}

/** An in-memory object-store driver implementing the 5-method driver protocol. */
function makeFakeDriver() {
    const store = new Map(); // key → Buffer
    return {
        store,
        async putStream(key, iterable) {
            const parts = [];
            for await (const chunk of iterable) parts.push(Buffer.from(chunk));
            store.set(key, Buffer.concat(parts));
        },
        async getStream(key) {
            if (!store.has(key)) { const e = new Error('nf'); e.notFound = true; throw e; }
            return Readable.from(store.get(key));
        },
        async getRangeStream(key, start, end) {
            if (!store.has(key)) { const e = new Error('nf'); e.notFound = true; throw e; }
            return Readable.from(store.get(key).subarray(start, end + 1));
        },
        async deleteObject(key) { store.delete(key); },
        async headObject(key) { return store.has(key) ? store.get(key).length : null; },
    };
}

/** Each entry: [name, () => backend, () => backendWithTinyLimit]. */
const BACKENDS = [
    ['memory', () => new MemoryStorageBackend(), () => new MemoryStorageBackend({ maxBlobBytes: 10 })],
    ['s3', () => new S3StorageBackend({ driver: makeFakeDriver() }), () => new S3StorageBackend({ driver: makeFakeDriver(), maxBlobBytes: 10 })],
    ['gcs', () => new GcsStorageBackend({ driver: makeFakeDriver() }), () => new GcsStorageBackend({ driver: makeFakeDriver(), maxBlobBytes: 10 })],
];

for (const [name, make, makeTiny] of BACKENDS) {
    describe(`StorageBackend contract: ${name}`, () => {
        it('put (Buffer) → get round-trips exactly', async () => {
            const be = make();
            const id = newId();
            const data = Buffer.from('the quick brown fox');
            const written = await be.put(id, data);
            assert.equal(written, data.length);
            assert.deepEqual(await collect(await be.get(id)), data);
        });

        it('put (Readable) → get round-trips exactly', async () => {
            const be = make();
            const id = newId();
            const data = crypto.randomBytes(50_000);
            const written = await be.put(id, Readable.from([data.subarray(0, 20000), data.subarray(20000)]));
            assert.equal(written, data.length);
            assert.deepEqual(await collect(await be.get(id)), data);
        });

        it('getRange returns the inclusive byte range', async () => {
            const be = make();
            const id = newId();
            await be.put(id, Buffer.from('0123456789'));
            assert.equal((await collect(await be.getRange(id, 2, 5))).toString(), '2345');
            assert.equal((await collect(await be.getRange(id, 0, 0))).toString(), '0');
        });

        it('size / exists reflect presence', async () => {
            const be = make();
            const id = newId();
            assert.equal(await be.size(id), -1);
            assert.equal(await be.exists(id), false);
            await be.put(id, Buffer.from('hello'));
            assert.equal(await be.size(id), 5);
            assert.equal(await be.exists(id), true);
        });

        it('delete is idempotent and removes the blob', async () => {
            const be = make();
            const id = newId();
            await be.put(id, Buffer.from('bye'));
            await be.delete(id);
            await be.delete(id); // no throw second time
            assert.equal(await be.exists(id), false);
        });

        it('get/getRange reject with BlobNotFoundError when absent', async () => {
            const be = make();
            await assert.rejects(() => be.get(newId()), (e) => e instanceof BlobNotFoundError);
            await assert.rejects(() => be.getRange(newId(), 0, 1), (e) => e instanceof BlobNotFoundError);
        });

        it('put over the byte ceiling throws BlobTooLargeError and stores nothing', async () => {
            const be = makeTiny();
            const id = newId();
            await assert.rejects(() => be.put(id, Buffer.from('this is definitely more than ten bytes')),
                (e) => e instanceof BlobTooLargeError);
            assert.equal(await be.exists(id), false);
        });

        it('rejects an invalid blob id', async () => {
            const be = make();
            await assert.rejects(() => be.put('../etc/passwd', Buffer.from('x')));
        });
    });
}

describe('blobKey', () => {
    it('shards by the first two hex chars under the prefix', () => {
        const id = 'abcdef0123456789abcdef0123456789';
        assert.equal(blobKey('blobs/', id), `blobs/ab/${id}`);
        assert.equal(blobKey('blobs', id), `blobs/ab/${id}`); // normalizes trailing slash
        assert.equal(blobKey('', id), `ab/${id}`);
    });
    it('rejects a non-hex id (no traversal surface)', () => {
        assert.throws(() => blobKey('blobs/', '../../evil'));
    });
});
