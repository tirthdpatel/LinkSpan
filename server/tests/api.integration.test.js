/**
 * REST API integration test (Feature 17).
 *
 * Builds a standalone Express app with the real router wired to in-memory backends,
 * binds an ephemeral port, and exercises the full HTTP surface with global fetch.
 * No WebSocket/signaling server and no Redis required.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createInMemoryApiApp } from '../src/api/inMemoryApp.js';

let server;
let base;
let apiKeys;
let telemetry;

before(async () => {
    const built = createInMemoryApiApp({ apiKeySecret: 'itest-secret' });
    apiKeys = built.apiKeys;
    telemetry = built.telemetry;
    server = http.createServer(built.app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => { server?.close(); });

async function createLink(body, headers = {}) {
    const res = await fetch(`${base}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
}

async function upload(id, token, bytes) {
    return fetch(`${base}/links/${id}/content`, {
        method: 'PUT',
        headers: { 'x-upload-token': token, 'content-type': 'application/octet-stream' },
        body: bytes,
    });
}

describe('REST API', () => {
    it('GET / advertises capabilities', async () => {
        const res = await fetch(`${base}/`);
        const json = await res.json();
        assert.equal(json.version, 'v1');
        assert.equal(json.capabilities.shareLinks, true);
    });

    it('serves an OpenAPI document', async () => {
        const res = await fetch(`${base}/openapi.json`);
        const spec = await res.json();
        assert.equal(spec.openapi, '3.1.0');
        assert.ok(spec.paths['/links']);
    });

    it('full lifecycle: create → upload → metadata → download', async () => {
        const { res, json } = await createLink({ filename: 'hello.txt', size: 5 });
        assert.equal(res.status, 201);
        assert.ok(json.id);
        assert.ok(json.uploadToken);
        assert.ok(json.ownerToken, 'anonymous create returns a capability token');
        assert.equal(json.status, 'pending');

        const up = await upload(json.id, json.uploadToken, Buffer.from('world'));
        assert.equal(up.status, 200);

        const meta = await (await fetch(`${base}/links/${json.id}`)).json();
        assert.equal(meta.status, 'ready');
        assert.equal(meta.size, 5);

        const dl = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(dl.status, 200);
        assert.equal(dl.headers.get('content-disposition').includes('hello.txt'), true);
        assert.equal(await dl.text(), 'world');
    });

    it('supports HTTP Range requests (206 partial + Accept-Ranges)', async () => {
        const { json } = await createLink({ filename: 'r.bin', size: 11 });
        await upload(json.id, json.uploadToken, Buffer.from('0123456789A'));

        // Full download advertises range support.
        const full = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(full.headers.get('accept-ranges'), 'bytes');
        await full.text();

        // A byte range returns 206 + the right slice + Content-Range.
        const part = await fetch(`${base}/links/${json.id}/download`, { headers: { range: 'bytes=2-5' } });
        assert.equal(part.status, 206);
        assert.equal(part.headers.get('content-range'), 'bytes 2-5/11');
        assert.equal(part.headers.get('content-length'), '4');
        assert.equal(await part.text(), '2345');

        // A suffix range (last 3 bytes).
        const suffix = await fetch(`${base}/links/${json.id}/download`, { headers: { range: 'bytes=-3' } });
        assert.equal(suffix.status, 206);
        assert.equal(await suffix.text(), '89A');

        // An unsatisfiable range → 416 with Content-Range: bytes */size.
        const bad = await fetch(`${base}/links/${json.id}/download`, { headers: { range: 'bytes=50-60' } });
        assert.equal(bad.status, 416);
        assert.equal(bad.headers.get('content-range'), 'bytes */11');
    });

    it('a Range request does not consume a single-use link', async () => {
        const { json } = await createLink({ filename: 'su.bin', size: 5, singleUse: true });
        await upload(json.id, json.uploadToken, Buffer.from('hello'));
        // Partial read must NOT meter the download...
        const part = await fetch(`${base}/links/${json.id}/download`, { headers: { range: 'bytes=0-1' } });
        assert.equal(part.status, 206);
        await part.text();
        await new Promise((r) => setTimeout(r, 30));
        // ...so the full download still works exactly once.
        const full = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(full.status, 200);
        assert.equal(await full.text(), 'hello');
    });

    it('rejects a malformed link id', async () => {
        const res = await fetch(`${base}/links/not-a-valid-id`);
        assert.equal(res.status, 400);
    });

    it('upload requires the correct token', async () => {
        const { json } = await createLink({ filename: 'a', size: 1 });
        const bad = await upload(json.id, 'wrong-token', Buffer.from('x'));
        assert.equal(bad.status, 401);
    });

    it('password-protected download enforces the password', async () => {
        const { json } = await createLink({ filename: 'secret.txt', size: 3, password: 'hunter2' });
        await upload(json.id, json.uploadToken, Buffer.from('abc'));

        const noPw = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(noPw.status, 401);

        const wrong = await fetch(`${base}/links/${json.id}/download`, { headers: { 'x-share-password': 'nope' } });
        assert.equal(wrong.status, 403);

        const ok = await fetch(`${base}/links/${json.id}/download`, { headers: { 'x-share-password': 'hunter2' } });
        assert.equal(ok.status, 200);
        assert.equal(await ok.text(), 'abc');
    });

    it('single-use link is gone after one download', async () => {
        const { json } = await createLink({ filename: 'once.txt', size: 3, singleUse: true });
        await upload(json.id, json.uploadToken, Buffer.from('one'));
        const first = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(first.status, 200);
        await first.text();
        // allow the close handler to record the download
        await new Promise((r) => setTimeout(r, 50));
        const second = await fetch(`${base}/links/${json.id}/download`);
        assert.equal(second.status, 404);
    });

    it('revoke via capability ownerToken', async () => {
        const { json } = await createLink({ filename: 'r.txt', size: 1 });
        await upload(json.id, json.uploadToken, Buffer.from('z'));
        const del = await fetch(`${base}/links/${json.id}`, {
            method: 'DELETE',
            headers: { 'x-owner-token': json.ownerToken },
        });
        assert.equal(del.status, 200);
        const after = await fetch(`${base}/links/${json.id}`);
        assert.equal(after.status, 404);
    });

    it('API-key owner can list their links', async () => {
        const key = apiKeys.issue({ ownerId: 'lister', scopes: ['*'] });
        await createLink({ filename: 'k1', size: 1 }, { authorization: `Bearer ${key}` });
        await createLink({ filename: 'k2', size: 1 }, { authorization: `Bearer ${key}` });
        const res = await fetch(`${base}/links`, { headers: { authorization: `Bearer ${key}` } });
        const json = await res.json();
        assert.equal(res.status, 200);
        assert.equal(json.count, 2);
    });

    it('rejects oversized expiry by clamping, not erroring', async () => {
        const { res, json } = await createLink({ filename: 'e', size: 1, expiresIn: '5m' });
        assert.equal(res.status, 201);
        assert.ok(json.expiresAt - json.createdAt <= 5 * 60 * 1000 + 1000);
    });

    // ── Opt-in aggregate telemetry ─────────────────────────────
    it('accepts a valid anonymized telemetry event (no auth) and aggregates it', async () => {
        const before = telemetry.snapshot().total;
        const res = await fetch(`${base}/telemetry`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ outcome: 'success', mode: 'p2p', sizeBucket: '10to100mb', durationBucket: '10to60s' }),
        });
        assert.equal(res.status, 204);
        const snap = telemetry.snapshot();
        assert.equal(snap.total, before + 1);
        assert.equal(snap.transfers['success|p2p'] >= 1, true);
    });

    it('returns 204 but does not aggregate an invalid telemetry event', async () => {
        const before = telemetry.snapshot();
        const res = await fetch(`${base}/telemetry`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ outcome: 'nope', mode: 'x', sizeBucket: 'y', durationBucket: 'z' }),
        });
        assert.equal(res.status, 204); // never an oracle
        const after = telemetry.snapshot();
        assert.equal(after.total, before.total);       // not counted
        assert.equal(after.rejected, before.rejected + 1);
    });
});
