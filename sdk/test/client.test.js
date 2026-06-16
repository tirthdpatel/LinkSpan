/**
 * @linkspan/sdk integration tests — driven against a real in-memory LinkSpan API.
 * Run: node --test test/
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.js';
import { LinkSpanClient, LinkSpanError } from '../src/index.js';

let ctx;
let client;

before(async () => {
    ctx = await startTestServer();
    client = new LinkSpanClient({ baseUrl: ctx.baseUrl });
});
after(async () => { await ctx.stop(); });

describe('LinkSpanClient', () => {
    it('reports info and health', async () => {
        const info = await client.info();
        assert.equal(info.version, 'v1');
        const health = await client.health();
        assert.equal(health.status, 'ok');
    });

    it('createShare → getLink → download round-trip', async () => {
        const data = new TextEncoder().encode('hello sdk');
        const link = await client.createShare(data, { filename: 'greeting.txt', expiresIn: '1h' });
        assert.ok(link.id);
        assert.equal(link.status, 'ready');
        assert.equal(link.size, data.byteLength);

        const meta = await client.getLink(link.id);
        assert.equal(meta.filename, 'greeting.txt');

        const got = await client.download(link.id);
        assert.equal(new TextDecoder().decode(got), 'hello sdk');
    });

    it('encrypt:true stores ciphertext and round-trips with the key', async () => {
        const secret = 'confidential payload';
        const link = await client.createShare(secret, { filename: 'sec.txt', encrypt: true });
        assert.ok(link.encryptionKey, 'createShare returns the generated key');
        assert.equal(link.metadata?.encrypted, 'aes-256-gcm');

        // Server stores ciphertext: a keyless download must not reveal the plaintext.
        const raw = await client.download(link.id);
        assert.notEqual(new TextDecoder().decode(raw), secret);
        // It is also longer than the plaintext (IV + tag overhead).
        assert.ok(raw.byteLength > new TextEncoder().encode(secret).byteLength);

        // With the key it decrypts back to the original.
        const got = await client.download(link.id, { decryptionKey: link.encryptionKey });
        assert.equal(new TextDecoder().decode(got), secret);
    });

    it('decrypting with the wrong key fails (GCM auth)', async () => {
        const { generateKey, exportKey } = await import('../src/index.js');
        const link = await client.createShare('tamper-evident', { filename: 't.txt', encrypt: true });
        const wrong = await exportKey(await generateKey());
        await assert.rejects(() => client.download(link.id, { decryptionKey: wrong }));
    });

    it('accepts a string payload', async () => {
        const link = await client.createShare('just text', { filename: 'note.txt' });
        const got = await client.download(link.id);
        assert.equal(new TextDecoder().decode(got), 'just text');
    });

    it('password protection', async () => {
        const link = await client.createShare('secret', { filename: 's.txt', password: 'pw123' });
        await assert.rejects(() => client.download(link.id), (e) => e instanceof LinkSpanError && e.status === 401);
        const got = await client.download(link.id, { password: 'pw123' });
        assert.equal(new TextDecoder().decode(got), 'secret');
    });

    it('single-use link disappears after one download', async () => {
        const link = await client.createShare('once', { filename: 'o.txt', singleUse: true });
        await client.download(link.id);
        await new Promise((r) => setTimeout(r, 50));
        await assert.rejects(() => client.download(link.id), (e) => e.status === 404);
    });

    it('revoke via ownerToken', async () => {
        const link = await client.createShare('x', { filename: 'r.txt' });
        const r = await client.revoke(link.id, { ownerToken: link.ownerToken });
        assert.equal(r.revoked, true);
        await assert.rejects(() => client.getLink(link.id), (e) => e.status === 404);
    });

    it('API-key client can list its links', async () => {
        const key = ctx.apiKeys.issue({ ownerId: 'sdk-user', scopes: ['*'] });
        const keyed = new LinkSpanClient({ baseUrl: ctx.baseUrl, apiKey: key });
        await keyed.createShare('a', { filename: 'a' });
        await keyed.createShare('b', { filename: 'b' });
        const { count } = await keyed.listLinks();
        assert.equal(count, 2);
    });

    it('listLinks without an API key throws CONFIG', () => {
        assert.throws(() => client.listLinks(), (e) => e.code === 'CONFIG');
    });

    it('surfaces structured errors', async () => {
        await assert.rejects(() => client.getLink('deadbeef'), (e) => e instanceof LinkSpanError && e.status === 400);
    });
});

describe('webhooks', () => {
    it('create → list → delete via an API-key client', async () => {
        const key = ctx.apiKeys.issue({ ownerId: 'wh-user', scopes: ['*'] });
        const keyed = new LinkSpanClient({ baseUrl: ctx.baseUrl, apiKey: key });

        const wh = await keyed.createWebhook({ url: 'https://hooks.example/sdk', events: ['share.created'] });
        assert.ok(wh.id);
        assert.ok(wh.secret);

        const { count } = await keyed.listWebhooks();
        assert.equal(count, 1);

        const del = await keyed.deleteWebhook(wh.id);
        assert.equal(del.deleted, true);
    });

    it('createWebhook without an API key throws CONFIG', () => {
        assert.throws(() => client.createWebhook({ url: 'https://x', events: ['*'] }), (e) => e.code === 'CONFIG');
    });
});

describe('verifyWebhookSignature', () => {
    it('accepts a valid signature and rejects a tampered body or wrong secret', async () => {
        const { verifyWebhookSignature } = await import('../src/index.js');
        const { createHmac } = await import('node:crypto');
        const secret = 'whsec_abc';
        const body = JSON.stringify({ id: 'd1', type: 'share.created', data: {} });
        const t = Math.floor(Date.now() / 1000);
        const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
        const header = `t=${t},v1=${mac}`;

        assert.equal(await verifyWebhookSignature(secret, header, body), true);
        assert.equal(await verifyWebhookSignature(secret, header, body + 'x'), false);
        assert.equal(await verifyWebhookSignature('wrong', header, body), false);
        // Replay window: a far-past timestamp fails when a tolerance is enforced.
        assert.equal(await verifyWebhookSignature(secret, header, body, { toleranceSec: 0, now: () => Date.now() + 600000 }), false);
    });
});
