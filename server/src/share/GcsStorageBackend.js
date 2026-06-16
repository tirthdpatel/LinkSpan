/**
 * GcsStorageBackend — share-link blob storage on Google Cloud Storage. A thin
 * specialization of ObjectStorageBackend over a GCS driver. Blob ids stay
 * server-generated 32-hex tokens, so object names never contain user-controlled paths.
 *
 * Selected with SHARE_STORAGE=gcs (see createStorageBackend). @google-cloud/storage is
 * an optional dependency, lazily imported by createGcsDriver only on this path.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectStorageBackend } from './ObjectStorageBackend.js';

export class GcsStorageBackend extends ObjectStorageBackend {
    constructor(opts) {
        super({ ...opts, kind: 'gcs' });
    }
}

/**
 * Build the GCS driver from the environment, lazily importing the SDK.
 *
 *   GCS_BUCKET (required)
 *   GCS_PROJECT_ID   (else inferred from credentials/environment)
 *   GCS_KEY_FILE     path to a service-account JSON (else ADC / workload identity)
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createGcsDriver(env = process.env) {
    let Storage;
    try {
        ({ Storage } = await import('@google-cloud/storage'));
    } catch {
        throw new Error(
            'SHARE_STORAGE=gcs requires the GCS SDK. Install it with: npm i @google-cloud/storage'
        );
    }

    const bucketName = env.GCS_BUCKET;
    if (!bucketName) throw new Error('GCS_BUCKET is required for SHARE_STORAGE=gcs');

    const storage = new Storage({
        projectId: env.GCS_PROJECT_ID || undefined,
        keyFilename: env.GCS_KEY_FILE || undefined,
    });
    const bucket = storage.bucket(bucketName);

    return {
        bucket: bucketName,
        async putStream(key, iterable) {
            // resumable:false → a single streamed upload (lower latency for our blob sizes;
            // the byte ceiling is enforced upstream in the iterable).
            await pipeline(Readable.from(iterable), bucket.file(key).createWriteStream({ resumable: false }));
        },
        async getStream(key) {
            const file = bucket.file(key);
            // createReadStream surfaces a missing object as a late 'error' event, not a
            // rejection — so probe existence first to honor the get() contract (reject if absent).
            const [exists] = await file.exists();
            if (!exists) { const e = new Error('not found'); e.notFound = true; throw e; }
            return file.createReadStream();
        },
        async getRangeStream(key, start, end) {
            const file = bucket.file(key);
            const [exists] = await file.exists();
            if (!exists) { const e = new Error('not found'); e.notFound = true; throw e; }
            return file.createReadStream({ start, end });
        },
        async deleteObject(key) {
            await bucket.file(key).delete({ ignoreNotFound: true });
        },
        async headObject(key) {
            try {
                const [md] = await bucket.file(key).getMetadata();
                return Number(md.size ?? 0);
            } catch (err) {
                if (err?.code === 404) return null;
                throw err;
            }
        },
    };
}
