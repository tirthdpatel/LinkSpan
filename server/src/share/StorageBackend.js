/**
 * StorageBackend — pluggable blob storage for share links (Features 14/15).
 *
 * A share link stores opaque, client-supplied bytes (typically already E2E-encrypted
 * by the browser/CLI before upload) keyed by a *server-generated* blob id. Blob ids are
 * 128-bit hex tokens — never derived from user input — which structurally eliminates
 * path traversal / arbitrary file read+write for the filesystem backend.
 *
 * Implementations:
 *   - MemoryStorageBackend     — in-process Map. For tests and ephemeral single-node.
 *   - FilesystemStorageBackend — streamed to a confined base directory. Production-ready
 *                                for self-hosted single-node / shared-volume deploys.
 *
 * Cloud backends (S3, GCS, Azure Blob) are first-class extension points: implement the
 * same five async methods (put/get/delete/size/exists) and return one from the factory.
 * The manager and routes depend only on this interface, never on a concrete backend, so
 * a cloud backend drops in with no changes elsewhere. See createStorageBackend().
 *
 * @typedef {Object} StorageBackend
 * @property {(id: string, source: Buffer|import('stream').Readable) => Promise<number>} put
 *           Store bytes under `id`. Returns the number of bytes written.
 * @property {(id: string) => Promise<import('stream').Readable>} get
 *           Open a readable stream of the stored bytes. Rejects if absent.
 * @property {(id: string, start: number, end: number) => Promise<import('stream').Readable>} getRange
 *           Open a readable stream of bytes [start, end] inclusive. Rejects if absent.
 * @property {(id: string) => Promise<void>} delete  Remove the object (idempotent).
 * @property {(id: string) => Promise<number>} size  Byte length, or -1 if absent.
 * @property {(id: string) => Promise<boolean>} exists
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SHARE_MAX_BLOB_BYTES } from '../../../shared/constants.js';

/** Blob ids are always 32 lowercase hex chars (128-bit). Validate before any FS use. */
const BLOB_ID_RE = /^[a-f0-9]{32}$/;

export function isValidBlobId(id) {
    return typeof id === 'string' && BLOB_ID_RE.test(id);
}

/** Raised when a put exceeds the configured per-blob byte ceiling. */
export class BlobTooLargeError extends Error {
    constructor(limit) {
        super(`Blob exceeds maximum size of ${limit} bytes`);
        this.name = 'BlobTooLargeError';
        this.code = 'BLOB_TOO_LARGE';
    }
}

/** Raised when a requested blob does not exist. */
export class BlobNotFoundError extends Error {
    constructor(id) {
        super(`Blob not found: ${id}`);
        this.name = 'BlobNotFoundError';
        this.code = 'BLOB_NOT_FOUND';
    }
}

/**
 * Consume `source` (Buffer or Readable) enforcing a hard byte ceiling, invoking
 * `onChunk(buf)` for each chunk. Throws BlobTooLargeError if the limit is exceeded —
 * the caller is responsible for cleaning up any partial output.
 */
async function streamWithLimit(source, limit, onChunk) {
    let total = 0;
    const iterable = Buffer.isBuffer(source) ? [source] : source;
    for await (const chunk of iterable) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limit) throw new BlobTooLargeError(limit);
        await onChunk(buf);
    }
    return total;
}

/**
 * Derive a remote object key for a blob id under an optional prefix, sharded by the
 * first 2 id chars (mirrors the filesystem backend's directory sharding). Shared by
 * the cloud backends (S3/GCS). The id is validated hex so the key can never contain
 * user-controlled traversal segments.
 */
export function blobKey(prefix, id) {
    if (!isValidBlobId(id)) throw new Error('Invalid blob id');
    const p = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
    return `${p}${id.slice(0, 2)}/${id}`;
}

/**
 * Wrap a Buffer|Readable source as an async iterable of Buffers that enforces a hard
 * byte ceiling while streaming (never buffering the whole blob). Writes the running
 * total into `counter.bytes` so the caller can report bytes written. Throws
 * BlobTooLargeError mid-stream if the limit is exceeded — the cloud backend aborts the
 * in-flight upload and cleans up the partial object.
 */
export async function* limitBytes(source, limit, counter) {
    let total = 0;
    const iterable = Buffer.isBuffer(source) ? [source] : source;
    for await (const chunk of iterable) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limit) throw new BlobTooLargeError(limit);
        counter.bytes = total;
        yield buf;
    }
}

// ── In-memory backend ──────────────────────────────────────────
export class MemoryStorageBackend {
    constructor({ maxBlobBytes = SHARE_MAX_BLOB_BYTES } = {}) {
        this._store = new Map(); // id → Buffer
        this._maxBlobBytes = maxBlobBytes;
        this.kind = 'memory';
    }

    async put(id, source) {
        if (!isValidBlobId(id)) throw new Error('Invalid blob id');
        const parts = [];
        const total = await streamWithLimit(source, this._maxBlobBytes, (buf) => {
            parts.push(buf);
        });
        this._store.set(id, Buffer.concat(parts, total));
        return total;
    }

    async get(id) {
        const buf = this._store.get(id);
        if (!buf) throw new BlobNotFoundError(id);
        return Readable.from(buf);
    }

    async getRange(id, start, end) {
        const buf = this._store.get(id);
        if (!buf) throw new BlobNotFoundError(id);
        // end is inclusive; subarray end is exclusive.
        return Readable.from(buf.subarray(start, end + 1));
    }

    async delete(id) {
        this._store.delete(id);
    }

    async size(id) {
        const buf = this._store.get(id);
        return buf ? buf.length : -1;
    }

    async exists(id) {
        return this._store.has(id);
    }
}

// ── Filesystem backend ─────────────────────────────────────────
export class FilesystemStorageBackend {
    /**
     * @param {object} opts
     * @param {string} opts.baseDir   Confinement root. All blobs live strictly inside.
     * @param {number} [opts.maxBlobBytes]
     */
    constructor({ baseDir, maxBlobBytes = SHARE_MAX_BLOB_BYTES }) {
        if (!baseDir) throw new Error('FilesystemStorageBackend requires a baseDir');
        this._baseDir = path.resolve(baseDir);
        this._maxBlobBytes = maxBlobBytes;
        this.kind = 'filesystem';
        fs.mkdirSync(this._baseDir, { recursive: true });
    }

    /**
     * Resolve the on-disk path for a blob id and assert it stays inside baseDir.
     * Ids are validated hex, but we re-check the resolved path as defense in depth so
     * a future caller bug can never escape the confinement root.
     */
    _pathFor(id) {
        if (!isValidBlobId(id)) throw new Error('Invalid blob id');
        // Shard by first 2 chars to avoid one giant directory.
        const dir = path.join(this._baseDir, id.slice(0, 2));
        const full = path.join(dir, id);
        const rel = path.relative(this._baseDir, full);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('Resolved blob path escapes storage root');
        }
        return { dir, full };
    }

    async put(id, source) {
        const { dir, full } = this._pathFor(id);
        const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
        await fsp.mkdir(dir, { recursive: true });
        const out = fs.createWriteStream(tmp);
        const limit = this._maxBlobBytes;
        try {
            // Wrap the source so we can enforce the byte ceiling while streaming,
            // never buffering the whole blob in memory.
            let total = 0;
            async function* limited() {
                const iterable = Buffer.isBuffer(source) ? [source] : source;
                for await (const chunk of iterable) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    total += buf.length;
                    if (total > limit) throw new BlobTooLargeError(limit);
                    yield buf;
                }
            }
            await pipeline(limited(), out);
            // Atomic publish: rename only after a fully successful write.
            await fsp.rename(tmp, full);
            return total;
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            await fsp.rm(full, { force: true }).catch(() => {});
            throw err;
        }
    }

    async get(id) {
        const { full } = this._pathFor(id);
        if (!fs.existsSync(full)) throw new BlobNotFoundError(id);
        return fs.createReadStream(full);
    }

    async getRange(id, start, end) {
        const { full } = this._pathFor(id);
        if (!fs.existsSync(full)) throw new BlobNotFoundError(id);
        // createReadStream's end option is inclusive — matches HTTP Range semantics.
        return fs.createReadStream(full, { start, end });
    }

    async delete(id) {
        const { full } = this._pathFor(id);
        await fsp.rm(full, { force: true }).catch(() => {});
    }

    async size(id) {
        const { full } = this._pathFor(id);
        try {
            const st = await fsp.stat(full);
            return st.size;
        } catch {
            return -1;
        }
    }

    async exists(id) {
        const { full } = this._pathFor(id);
        return fs.existsSync(full);
    }
}

/**
 * Factory: pick a storage backend from the environment.
 *
 *   SHARE_STORAGE=memory                         → MemoryStorageBackend
 *   SHARE_STORAGE=filesystem (default)           → FilesystemStorageBackend
 *     SHARE_STORAGE_DIR=/var/lib/linkspan/blobs  (default: <cwd>/.linkspan-blobs)
 *   SHARE_STORAGE=s3                             → S3StorageBackend (AWS S3 / R2 / B2 / MinIO)
 *     S3_BUCKET (req), S3_REGION, S3_ENDPOINT, S3_PREFIX, S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
 *   SHARE_STORAGE=gcs                            → GcsStorageBackend (Google Cloud Storage)
 *     GCS_BUCKET (req), GCS_PROJECT_ID, GCS_KEY_FILE, GCS_PREFIX
 *
 * The cloud SDKs are heavy and optional, so they are lazily imported only when the
 * corresponding backend is selected — the server boots without them installed when
 * using the memory/filesystem backends. They are declared as optionalDependencies.
 *
 * Async because the cloud branches dynamically import their SDK; callers must await.
 */
export async function createStorageBackend(env = process.env) {
    const kind = env.SHARE_STORAGE || 'filesystem';
    if (kind === 'memory') return new MemoryStorageBackend();
    if (kind === 'filesystem') {
        const baseDir = env.SHARE_STORAGE_DIR || path.join(process.cwd(), '.linkspan-blobs');
        return new FilesystemStorageBackend({ baseDir });
    }
    if (kind === 's3') {
        const { S3StorageBackend, createS3Driver } = await import('./S3StorageBackend.js');
        const driver = await createS3Driver(env);
        return new S3StorageBackend({ driver, prefix: env.S3_PREFIX || 'blobs/' });
    }
    if (kind === 'gcs') {
        const { GcsStorageBackend, createGcsDriver } = await import('./GcsStorageBackend.js');
        const driver = await createGcsDriver(env);
        return new GcsStorageBackend({ driver, prefix: env.GCS_PREFIX || 'blobs/' });
    }
    throw new Error(`Unknown SHARE_STORAGE backend: ${kind}`);
}
