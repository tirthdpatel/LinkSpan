#!/usr/bin/env node
/**
 * verify-s3-backend — exercise the configured share-link storage backend against the
 * real bucket: put (multipart) → size/exists → get → getRange → delete, verifying
 * content hashes and reporting throughput. Run it once after pointing the env at a
 * new provider (Backblaze B2, Supabase, R2, MinIO) before trusting it in prod.
 *
 * Usage (from server/):
 *   SHARE_STORAGE=s3 S3_BUCKET=... S3_ENDPOINT=... S3_REGION=... \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   node scripts/verify-s3-backend.mjs [--mb 16]
 *
 * --mb N   test blob size in MiB (default 16 — big enough to force multipart).
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createStorageBackend } from '../src/share/StorageBackend.js';

const mbFlag = process.argv.indexOf('--mb');
const MB = mbFlag !== -1 ? Number(process.argv[mbFlag + 1]) : 16;
if (!Number.isFinite(MB) || MB <= 0) {
    console.error('--mb must be a positive number');
    process.exit(1);
}
const SIZE = Math.round(MB * 1024 * 1024);

function* randomChunks(total, chunkSize = 1024 * 1024) {
    let left = total;
    while (left > 0) {
        const n = Math.min(chunkSize, left);
        left -= n;
        yield crypto.randomBytes(n);
    }
}

async function hashStream(stream) {
    const h = crypto.createHash('sha256');
    let bytes = 0;
    for await (const c of stream) { h.update(c); bytes += c.length; }
    return { digest: h.digest('hex'), bytes };
}

const fmt = (bytes, ms) => `${(bytes / 1024 / 1024).toFixed(1)} MiB in ${(ms / 1000).toFixed(1)}s = ${((bytes * 8) / 1000 / ms).toFixed(1)} Mbps`;

const backend = await createStorageBackend(process.env);
console.log(`backend: ${backend.kind}  test blob: ${MB} MiB`);

const id = crypto.randomBytes(16).toString('hex');
let ok = true;
try {
    // put — hash while generating so we can compare after download.
    const putHash = crypto.createHash('sha256');
    const source = Readable.from((function* () {
        for (const c of randomChunks(SIZE)) { putHash.update(c); yield c; }
    })());
    let t = Date.now();
    const written = await backend.put(id, source);
    console.log(`put      ✓ ${fmt(written, Date.now() - t)}`);
    const expected = putHash.digest('hex');

    // size / exists
    const size = await backend.size(id);
    if (size !== SIZE) throw new Error(`size mismatch: got ${size}, want ${SIZE}`);
    if (!(await backend.exists(id))) throw new Error('exists() returned false');
    console.log('size     ✓ exists ✓');

    // full get — verify hash
    t = Date.now();
    const { digest, bytes } = await hashStream(await backend.get(id));
    if (digest !== expected) throw new Error('downloaded content hash mismatch');
    console.log(`get      ✓ ${fmt(bytes, Date.now() - t)} (sha256 match)`);

    // ranged get — inclusive semantics
    const start = 1024, end = 1024 + 65535;
    const { bytes: rangeBytes } = await hashStream(await backend.getRange(id, start, end));
    if (rangeBytes !== end - start + 1) throw new Error(`range length: got ${rangeBytes}, want ${end - start + 1}`);
    console.log('getRange ✓ inclusive semantics correct');
} catch (err) {
    ok = false;
    console.error(`FAIL: ${err.message}`);
} finally {
    await backend.delete(id).catch((e) => console.error(`cleanup delete failed: ${e.message}`));
    if (!(await backend.exists(id).catch(() => false))) console.log('delete   ✓ cleaned up');
}

console.log(ok ? '\nAll checks passed — backend is production-ready.' : '\nBackend verification FAILED.');
process.exit(ok ? 0 : 1);
