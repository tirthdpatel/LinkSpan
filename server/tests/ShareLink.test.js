/**
 * Unit tests for the share-link subsystem (Features 14/15):
 * storage backends, metadata store, and the ShareLinkManager lifecycle/policy.
 *
 * Pure in-memory — no live server, no Redis, no disk. Run: node --test tests/
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
    MemoryStorageBackend,
    FilesystemStorageBackend,
    isValidBlobId,
    BlobTooLargeError,
    BlobNotFoundError,
} from '../src/share/StorageBackend.js';
import { MemoryShareLinkStore } from '../src/share/ShareLinkStore.js';
import { ShareLinkManager, resolveExpiryMs, ShareError } from '../src/share/ShareLinkManager.js';
import { SHARE_MAX_EXPIRY_MS, SHARE_MIN_EXPIRY_MS } from '../../shared/constants.js';

async function collect(stream) {
    const parts = [];
    for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(parts);
}

function newManager() {
    return new ShareLinkManager({
        store: new MemoryShareLinkStore(),
        storage: new MemoryStorageBackend(),
        baseUrl: 'https://share.example',
    });
}

async function createReady(mgr, opts = {}, bytes = Buffer.from('hello world')) {
    const { record, uploadToken } = await mgr.create({
        filename: 'file.bin', size: bytes.length, ...opts,
    });
    await mgr.attachContent(record.id, uploadToken, bytes);
    return { id: record.id, uploadToken, bytes };
}

// ── Storage backends ───────────────────────────────────────────
describe('StorageBackend', () => {
    it('memory: put/get/size/exists/delete round-trip', async () => {
        const s = new MemoryStorageBackend();
        const id = 'a'.repeat(32);
        const n = await s.put(id, Buffer.from('abc'));
        assert.equal(n, 3);
        assert.equal(await s.size(id), 3);
        assert.equal(await s.exists(id), true);
        assert.equal((await collect(await s.get(id))).toString(), 'abc');
        await s.delete(id);
        assert.equal(await s.exists(id), false);
        await assert.rejects(() => s.get(id), BlobNotFoundError);
    });

    it('memory: accepts a stream source', async () => {
        const s = new MemoryStorageBackend();
        const id = 'b'.repeat(32);
        await s.put(id, Readable.from([Buffer.from('foo'), Buffer.from('bar')]));
        assert.equal((await collect(await s.get(id))).toString(), 'foobar');
    });

    it('memory: enforces the per-blob byte ceiling', async () => {
        const s = new MemoryStorageBackend({ maxBlobBytes: 4 });
        await assert.rejects(() => s.put('c'.repeat(32), Buffer.from('toolong')), BlobTooLargeError);
    });

    it('rejects invalid blob ids (path-traversal defense)', () => {
        assert.equal(isValidBlobId('a'.repeat(32)), true);
        assert.equal(isValidBlobId('../etc/passwd'), false);
        assert.equal(isValidBlobId('A'.repeat(32)), false); // uppercase not allowed
        assert.equal(isValidBlobId('a'.repeat(31)), false);
    });

    it('filesystem: round-trip + confinement, atomic publish', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-blob-'));
        const s = new FilesystemStorageBackend({ baseDir: dir });
        const id = 'd'.repeat(32);
        await s.put(id, Readable.from([Buffer.from('disk-bytes')]));
        assert.equal(await s.exists(id), true);
        assert.equal((await collect(await s.get(id))).toString(), 'disk-bytes');
        // No leftover temp files
        const shard = fs.readdirSync(path.join(dir, 'dd'));
        assert.deepEqual(shard, [id]);
        await s.delete(id);
        assert.equal(await s.exists(id), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('filesystem: rejects an escaping blob id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-blob-'));
        const s = new FilesystemStorageBackend({ baseDir: dir });
        await assert.rejects(() => s.put('../../evil', Buffer.from('x')), /Invalid blob id/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ── Expiry resolution ──────────────────────────────────────────
describe('resolveExpiryMs', () => {
    it('maps presets', () => {
        assert.equal(resolveExpiryMs('5m'), 5 * 60 * 1000);
        assert.equal(resolveExpiryMs('7d'), 7 * 24 * 60 * 60 * 1000);
    });
    it('clamps custom values into [MIN, MAX]', () => {
        assert.equal(resolveExpiryMs(1), SHARE_MIN_EXPIRY_MS);
        assert.equal(resolveExpiryMs(SHARE_MAX_EXPIRY_MS * 10), SHARE_MAX_EXPIRY_MS);
    });
    it('rejects nonsense', () => {
        assert.throws(() => resolveExpiryMs('not-a-number'), ShareError);
        assert.throws(() => resolveExpiryMs(-5), ShareError);
    });
});

// ── Manager lifecycle ──────────────────────────────────────────
describe('ShareLinkManager', () => {
    let mgr;
    beforeEach(() => { mgr = newManager(); });

    it('create → upload → download round-trip', async () => {
        const { id, bytes } = await createReady(mgr);
        const { stream, filename, size } = await mgr.openDownload(id);
        assert.equal(filename, 'file.bin');
        assert.equal(size, bytes.length);
        assert.equal((await collect(stream)).toString(), 'hello world');
    });

    it('download before upload returns NOT_READY', async () => {
        const { record } = await mgr.create({ filename: 'x', size: 3 });
        await assert.rejects(() => mgr.openDownload(record.id), (e) => e.code === 'NOT_READY');
    });

    it('rejects upload with a wrong token', async () => {
        const { record } = await mgr.create({ filename: 'x', size: 3 });
        await assert.rejects(() => mgr.attachContent(record.id, 'wrong', Buffer.from('abc')),
            (e) => e.code === 'UNAUTHORIZED');
    });

    it('password: required, incorrect, and correct', async () => {
        const { id } = await createReady(mgr, { password: 's3cret' });
        await assert.rejects(() => mgr.validateDownload(id), (e) => e.code === 'PASSWORD_REQUIRED');
        await assert.rejects(() => mgr.validateDownload(id, 'nope'), (e) => e.code === 'PASSWORD_INCORRECT');
        const rec = await mgr.validateDownload(id, 's3cret');
        assert.equal(rec.id, id);
    });

    it('single-use link is consumed after one download', async () => {
        const { id } = await createReady(mgr, { singleUse: true });
        const { stream } = await mgr.openDownload(id);
        await collect(stream);
        await mgr.recordDownload(id);
        // Gone: blob + metadata reaped
        await assert.rejects(() => mgr.openDownload(id), (e) => e.code === 'NOT_FOUND');
    });

    it('enforces maxDownloads then reaps', async () => {
        const { id } = await createReady(mgr, { maxDownloads: 2 });
        await mgr.recordDownload(id); // 1
        const rec = await mgr.getRecord(id);
        assert.equal(rec.downloadCount, 1);
        await mgr.recordDownload(id); // 2 → exhausted
        await assert.rejects(() => mgr.validateDownload(id), (e) => e.code === 'NOT_FOUND');
    });

    it('expired link returns EXPIRED', async () => {
        const { record, uploadToken } = await mgr.create({ filename: 'x', size: 3, expiresIn: SHARE_MIN_EXPIRY_MS });
        await mgr.attachContent(record.id, uploadToken, Buffer.from('abc'));
        // Force expiry by rewriting the stored record's expiresAt in the past.
        const raw = await mgr.getRecord(record.id);
        raw.expiresAt = Date.now() - 1000;
        await mgr._store.update(record.id, raw);
        await assert.rejects(() => mgr.validateDownload(record.id), (e) => e.code === 'EXPIRED');
    });

    it('revoke: owner check + capability, then gone', async () => {
        const { record } = await mgr.create({ filename: 'x', size: 3, ownerId: 'alice' });
        await assert.rejects(() => mgr.revoke(record.id, { ownerId: 'mallory' }), (e) => e.code === 'FORBIDDEN');
        await mgr.revoke(record.id, { ownerId: 'alice' });
        await assert.rejects(() => mgr.getRecord(record.id).then((r) => { if (!r) throw new ShareError('NOT_FOUND', 'x', 404); }),
            (e) => e.code === 'NOT_FOUND');
    });

    it('lists links by owner', async () => {
        await mgr.create({ filename: 'a', size: 1, ownerId: 'bob' });
        await mgr.create({ filename: 'b', size: 1, ownerId: 'bob' });
        await mgr.create({ filename: 'c', size: 1, ownerId: 'carol' });
        const links = await mgr.listByOwner('bob');
        assert.equal(links.length, 2);
    });

    it('sweeper reaps expired links and their blobs', async () => {
        const store = new MemoryShareLinkStore();
        const storage = new MemoryStorageBackend();
        const m = new ShareLinkManager({ store, storage });
        const { record, uploadToken } = await m.create({ filename: 'x', size: 3, expiresIn: SHARE_MIN_EXPIRY_MS });
        await m.attachContent(record.id, uploadToken, Buffer.from('abc'));
        const blobId = (await m.getRecord(record.id)).blobId;
        assert.equal(await storage.exists(blobId), true);
        // Expire the store entry.
        store._records.get(record.id).expiresAt = Date.now() - 1;
        const reaped = await m.sweepOnce();
        assert.equal(reaped, 1);
        assert.equal(await storage.exists(blobId), false);
    });

    it('toPublic never leaks password material or upload token', async () => {
        const { record } = await mgr.create({ filename: 'x', size: 3, password: 'p' });
        const pub = mgr.toPublic(record);
        assert.equal(pub.passwordProtected, true);
        assert.equal(pub.passwordHash, undefined);
        assert.equal(pub.passwordSalt, undefined);
        assert.equal(pub.uploadTokenHash, undefined);
    });
});
