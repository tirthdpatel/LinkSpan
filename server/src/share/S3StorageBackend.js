/**
 * S3StorageBackend — share-link blob storage on AWS S3 (or any S3-compatible store:
 * Cloudflare R2, Backblaze B2, MinIO, …, via S3_ENDPOINT). A thin specialization of
 * ObjectStorageBackend over an S3 driver. Blob ids stay server-generated 32-hex tokens,
 * so object keys can never contain user-controlled path segments.
 *
 * Selected with SHARE_STORAGE=s3 (see createStorageBackend). The AWS SDK is an optional
 * dependency, lazily imported by createS3Driver only on this path.
 */

import { Readable } from 'node:stream';
import { ObjectStorageBackend } from './ObjectStorageBackend.js';

export class S3StorageBackend extends ObjectStorageBackend {
    constructor(opts) {
        super({ ...opts, kind: 's3' });
    }
}

/**
 * Build the S3 driver from the environment, lazily importing the AWS SDK.
 *
 *   S3_BUCKET (required)
 *   S3_REGION | AWS_REGION (default us-east-1)
 *   S3_ENDPOINT            custom endpoint for S3-compatible stores (enables path-style)
 *   S3_FORCE_PATH_STYLE    'true' to force path-style addressing
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY  (else the SDK default credential chain)
 *   S3_UPLOAD_PART_SIZE_MB  multipart part size (default: SDK default, 5 MiB)
 *   S3_UPLOAD_CONCURRENCY   parallel in-flight parts per upload (default: SDK default, 4)
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createS3Driver(env = process.env) {
    let S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, Upload;
    try {
        ({ S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3'));
        ({ Upload } = await import('@aws-sdk/lib-storage'));
    } catch {
        throw new Error(
            'SHARE_STORAGE=s3 requires the AWS SDK. Install it with: ' +
            'npm i @aws-sdk/client-s3 @aws-sdk/lib-storage'
        );
    }

    const bucket = env.S3_BUCKET;
    if (!bucket) throw new Error('S3_BUCKET is required for SHARE_STORAGE=s3');

    const custom = Boolean(env.S3_ENDPOINT);
    const client = new S3Client({
        region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
        endpoint: env.S3_ENDPOINT || undefined,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' || custom,
        // SDK ≥3.729 attaches x-amz-checksum-* headers to every request by default;
        // several S3-compatible stores (Backblaze B2, older MinIO/R2) reject them.
        // On a custom endpoint, only send checksums where the API requires them.
        ...(custom ? {
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        } : {}),
        credentials: env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : undefined,
    });

    const partSizeMb = Number(env.S3_UPLOAD_PART_SIZE_MB);
    const partSize = Number.isFinite(partSizeMb) && partSizeMb >= 5 ? partSizeMb * 1024 * 1024 : undefined;
    const queueSize = Number(env.S3_UPLOAD_CONCURRENCY) || undefined;

    return {
        bucket,
        client, // exposed for config assertions in tests and the verify script
        async putStream(key, iterable) {
            // lib-storage's Upload streams + does multipart automatically, aborting the
            // upload if the body errors (e.g. our byte-ceiling guard throws mid-stream).
            const up = new Upload({
                client,
                partSize,
                queueSize,
                params: { Bucket: bucket, Key: key, Body: Readable.from(iterable) },
            });
            await up.done();
        },
        async getStream(key) {
            const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            return r.Body; // a Readable in Node
        },
        async getRangeStream(key, start, end) {
            const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
            return r.Body;
        },
        async deleteObject(key) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
        async headObject(key) {
            try {
                const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
                return r.ContentLength ?? 0;
            } catch (err) {
                if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
                throw err;
            }
        },
    };
}
