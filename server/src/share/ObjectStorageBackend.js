/**
 * ObjectStorageBackend — a StorageBackend implemented over an injected object-store
 * "driver" (S3, GCS, or an in-memory fake). It contains all backend-agnostic logic:
 * blob-id validation, key derivation/sharding, the streaming byte ceiling, and mapping
 * a driver "not found" into the shared BlobNotFoundError. The driver only has to speak a
 * tiny 5-method protocol, which keeps both the real cloud wrappers and the test fakes
 * trivial and keeps this class identical for every cloud provider.
 *
 * Driver protocol (all async):
 *   putStream(key, asyncIterable<Buffer>) → Promise<void>   store bytes (streamed)
 *   getStream(key)                        → Promise<Readable>   reject if absent
 *   getRangeStream(key, start, end)       → Promise<Readable>   inclusive end
 *   deleteObject(key)                     → Promise<void>    idempotent
 *   headObject(key)                       → Promise<number|null>   byte size, or null if absent
 *
 * A driver signals "absent" either by rejecting with an error carrying `.notFound`,
 * an HTTP 404 (`$metadata.httpStatusCode === 404` / `code === 404`), or an S3-style
 * `name`/`code` of 'NoSuchKey' | 'NotFound'.
 */

import { blobKey, limitBytes, BlobNotFoundError } from './StorageBackend.js';
import { SHARE_MAX_BLOB_BYTES } from '../../../shared/constants.js';

function isNotFound(err) {
    if (!err) return false;
    return Boolean(
        err.notFound ||
        err.$metadata?.httpStatusCode === 404 ||
        err.code === 404 ||
        err.code === 'NoSuchKey' ||
        err.code === 'ENOENT' ||
        err.name === 'NoSuchKey' ||
        err.name === 'NotFound'
    );
}

export class ObjectStorageBackend {
    /**
     * @param {object} opts
     * @param {object} opts.driver       Object-store driver (see protocol above).
     * @param {string} [opts.prefix]     Key prefix, e.g. 'blobs/'.
     * @param {number} [opts.maxBlobBytes]
     * @param {string} [opts.kind]       Reported backend kind (e.g. 's3' | 'gcs').
     */
    constructor({ driver, prefix = 'blobs/', maxBlobBytes = SHARE_MAX_BLOB_BYTES, kind = 'object' }) {
        if (!driver) throw new Error('ObjectStorageBackend requires a driver');
        this._driver = driver;
        this._prefix = prefix;
        this._maxBlobBytes = maxBlobBytes;
        this.kind = kind;
    }

    async put(id, source) {
        const key = blobKey(this._prefix, id);
        const counter = { bytes: 0 };
        try {
            await this._driver.putStream(key, limitBytes(source, this._maxBlobBytes, counter));
            return counter.bytes;
        } catch (err) {
            // Best-effort cleanup of any partial/aborted object (over-limit or transport error).
            await this._driver.deleteObject(key).catch(() => {});
            throw err;
        }
    }

    async get(id) {
        return this._streamOrNotFound(id, () => this._driver.getStream(blobKey(this._prefix, id)));
    }

    async getRange(id, start, end) {
        return this._streamOrNotFound(id, () => this._driver.getRangeStream(blobKey(this._prefix, id), start, end));
    }

    async _streamOrNotFound(id, fn) {
        try {
            return await fn();
        } catch (err) {
            if (isNotFound(err)) throw new BlobNotFoundError(id);
            throw err;
        }
    }

    async delete(id) {
        await this._driver.deleteObject(blobKey(this._prefix, id));
    }

    async size(id) {
        const s = await this._driver.headObject(blobKey(this._prefix, id));
        return s == null ? -1 : s;
    }

    async exists(id) {
        return (await this._driver.headObject(blobKey(this._prefix, id))) != null;
    }
}
