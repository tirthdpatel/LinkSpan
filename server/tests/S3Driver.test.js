/**
 * createS3Driver configuration tests — S3-compatible endpoint compatibility.
 *
 * AWS SDK ≥3.729 sends x-amz-checksum-* headers on every request by default, which
 * S3-compatible stores (Backblaze B2, older MinIO) reject. When S3_ENDPOINT is set the
 * driver must fall back to WHEN_REQUIRED checksums and path-style addressing. These
 * tests build a real S3Client (no network) and assert the resolved config.
 *
 * Run: node --test tests/
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createS3Driver } from '../src/share/S3StorageBackend.js';

const B2_ENV = {
    S3_BUCKET: 'linkspan-shares',
    S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
    S3_REGION: 'eu-central-003',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
};

const AWS_ENV = {
    S3_BUCKET: 'linkspan-shares',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
};

// SDK config values may be plain values or async providers; normalize.
async function resolved(v) {
    return typeof v === 'function' ? v() : v;
}

describe('createS3Driver', () => {
    it('requires S3_BUCKET', async () => {
        await assert.rejects(() => createS3Driver({}), /S3_BUCKET is required/);
    });

    it('custom endpoint → WHEN_REQUIRED checksums and path-style addressing', async () => {
        const d = await createS3Driver(B2_ENV);
        const cfg = d.client.config;
        assert.equal(await resolved(cfg.requestChecksumCalculation), 'WHEN_REQUIRED');
        assert.equal(await resolved(cfg.responseChecksumValidation), 'WHEN_REQUIRED');
        assert.equal(await resolved(cfg.forcePathStyle), true);
        const ep = await resolved(cfg.endpoint);
        assert.equal(ep.hostname, 's3.eu-central-003.backblazeb2.com');
        assert.equal(await resolved(cfg.region), 'eu-central-003');
    });

    it('plain AWS (no endpoint) keeps SDK checksum defaults and virtual-hosted style', async () => {
        const d = await createS3Driver(AWS_ENV);
        const cfg = d.client.config;
        assert.equal(await resolved(cfg.requestChecksumCalculation), 'WHEN_SUPPORTED');
        assert.equal(await resolved(cfg.responseChecksumValidation), 'WHEN_SUPPORTED');
        assert.equal(await resolved(cfg.forcePathStyle), false);
    });

    it('uses explicit static credentials when provided', async () => {
        const d = await createS3Driver(B2_ENV);
        const creds = await resolved(d.client.config.credentials);
        assert.equal(creds.accessKeyId, 'key');
        assert.equal(creds.secretAccessKey, 'secret');
    });
});
