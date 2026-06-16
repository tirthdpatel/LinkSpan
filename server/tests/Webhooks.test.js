/**
 * Webhook subsystem tests: WebhookManager (signing, dispatch matching, retry/backoff,
 * SSRF guard, ownership) and the REST routes via the in-memory API app.
 *
 * Hermetic — fetch and timers are injected, no network, no Redis. Run: node --test tests/
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { WebhookManager, WebhookError, signPayload } from '../src/webhooks/WebhookManager.js';
import { MemoryWebhookStore } from '../src/webhooks/WebhookStore.js';
import { createInMemoryApiApp } from '../src/api/inMemoryApp.js';

/** A fetch double that records calls and returns whatever the handler decides. */
function mockFetch(handler) {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({ url, opts });
        return handler(url, opts, calls.length);
    };
    fn.calls = calls;
    return fn;
}

/** Run scheduled backoff callbacks immediately so retries don't actually wait. */
const immediate = (fn) => { fn(); return 0; };

function newManager(fetchImpl, extra = {}) {
    return new WebhookManager({
        store: new MemoryWebhookStore(),
        fetchImpl,
        setTimeoutImpl: immediate,
        allowPrivate: true,
        ...extra,
    });
}

describe('signPayload', () => {
    it('produces a verifiable t=,v1= signature', () => {
        const sig = signPayload('s3cret', '{"a":1}', 1700000000);
        const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(sig);
        assert.ok(m);
        const expected = crypto.createHmac('sha256', 's3cret').update(`1700000000.{"a":1}`).digest('hex');
        assert.equal(m[2], expected);
    });
});

describe('WebhookManager.register', () => {
    it('generates a secret and returns it once', async () => {
        const m = newManager(mockFetch(() => ({ status: 200 })));
        const wh = await m.register({ ownerId: 'alice', url: 'https://hooks.example/x', events: ['share.created'] });
        assert.match(wh.secret, /^[a-f0-9]+$/);
        assert.deepEqual(wh.events, ['share.created']);
        // Subsequent reads omit the secret.
        const got = await m.get('alice', wh.id);
        assert.equal(got.secret, undefined);
    });

    it('rejects non-http(s) and (when not allowPrivate) private URLs', async () => {
        const m = new WebhookManager({ store: new MemoryWebhookStore(), allowPrivate: false });
        await assert.rejects(() => m.register({ ownerId: 'a', url: 'ftp://x/y', events: ['*'] }),
            (e) => e instanceof WebhookError && e.code === 'INVALID_URL');
        await assert.rejects(() => m.register({ ownerId: 'a', url: 'http://localhost/y', events: ['*'] }),
            (e) => e.code === 'FORBIDDEN_URL');
        await assert.rejects(() => m.register({ ownerId: 'a', url: 'http://10.0.0.5/y', events: ['*'] }),
            (e) => e.code === 'FORBIDDEN_URL');
        await assert.rejects(() => m.register({ ownerId: 'a', url: 'http://192.168.1.1/y', events: ['*'] }),
            (e) => e.code === 'FORBIDDEN_URL');
    });

    it('rejects unknown event types', async () => {
        const m = newManager(mockFetch(() => ({ status: 200 })));
        await assert.rejects(() => m.register({ ownerId: 'a', url: 'https://x/y', events: ['not.a.real.event'] }),
            (e) => e.code === 'INVALID_EVENTS');
    });
});

describe('WebhookManager.dispatch', () => {
    it('delivers a correctly-signed payload to matching subscribers only', async () => {
        const fetchImpl = mockFetch(() => ({ status: 200 }));
        const m = newManager(fetchImpl);
        const wh = await m.register({ ownerId: 'a', url: 'https://hooks.example/sink', events: ['share.created'] });
        await m.register({ ownerId: 'a', url: 'https://hooks.example/other', events: ['share.revoked'] });

        const matched = await m.dispatch('share.created', { id: 'abc' }, { awaitAll: true });
        assert.equal(matched, 1);
        assert.equal(fetchImpl.calls.length, 1);

        const { url, opts } = fetchImpl.calls[0];
        assert.equal(url, 'https://hooks.example/sink');
        assert.equal(opts.headers['X-LinkSpan-Event'], 'share.created');
        const body = JSON.parse(opts.body);
        assert.equal(body.type, 'share.created');
        assert.equal(body.data.id, 'abc');

        // Verify the signature over the exact raw body.
        const sig = opts.headers['X-LinkSpan-Signature'];
        const sm = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(sig);
        const expected = crypto.createHmac('sha256', wh.secret).update(`${sm[1]}.${opts.body}`).digest('hex');
        assert.equal(sm[2], expected);
    });

    it('delivers to a wildcard subscriber', async () => {
        const fetchImpl = mockFetch(() => ({ status: 200 }));
        const m = newManager(fetchImpl);
        await m.register({ ownerId: 'a', url: 'https://x/all', events: ['*'] });
        assert.equal(await m.dispatch('session.created', {}, { awaitAll: true }), 1);
    });

    it('never delivers payloads carrying secret fields (sanitized upstream)', async () => {
        // Sanitization happens in server.js, but ensure dispatch passes data through verbatim
        // so the upstream sanitizer is the single source of truth.
        const fetchImpl = mockFetch(() => ({ status: 200 }));
        const m = newManager(fetchImpl);
        await m.register({ ownerId: 'a', url: 'https://x/s', events: ['*'] });
        await m.dispatch('share.created', { id: 'z', visibility: 'public' }, { awaitAll: true });
        assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).data.visibility, 'public');
    });
});

describe('WebhookManager retries', () => {
    it('retries with backoff then succeeds; records success', async () => {
        let n = 0;
        const fetchImpl = mockFetch(() => { n++; return { status: n < 3 ? 500 : 200 }; });
        const m = newManager(fetchImpl);
        const wh = await m.register({ ownerId: 'a', url: 'https://x/retry', events: ['*'] });
        const out = await m.test('a', wh.id);
        assert.equal(out.ok, true);
        assert.equal(out.attempts, 3);
        const deliveries = await m.listDeliveries('a', wh.id);
        assert.equal(deliveries[0].status, 'success');
        assert.equal(deliveries[0].attempts, 3);
    });

    it('gives up after max attempts on persistent failure; records failed', async () => {
        const fetchImpl = mockFetch(() => ({ status: 503 }));
        const m = newManager(fetchImpl, { maxAttempts: 4 });
        const wh = await m.register({ ownerId: 'a', url: 'https://x/dead', events: ['*'] });
        const out = await m.test('a', wh.id);
        assert.equal(out.ok, false);
        assert.equal(out.attempts, 4);
        assert.equal(fetchImpl.calls.length, 4);
        const deliveries = await m.listDeliveries('a', wh.id);
        assert.equal(deliveries[0].status, 'failed');
    });

    it('treats a thrown network error as a retryable failure', async () => {
        let n = 0;
        const fetchImpl = mockFetch(() => { n++; if (n === 1) throw new Error('ECONNREFUSED'); return { status: 200 }; });
        const m = newManager(fetchImpl);
        const wh = await m.register({ ownerId: 'a', url: 'https://x/flaky', events: ['*'] });
        const out = await m.test('a', wh.id);
        assert.equal(out.ok, true);
        assert.equal(out.attempts, 2);
    });
});

describe('WebhookManager ownership', () => {
    it('scopes get/delete/list to the owner', async () => {
        const m = newManager(mockFetch(() => ({ status: 200 })));
        const wh = await m.register({ ownerId: 'alice', url: 'https://x/a', events: ['*'] });
        await m.register({ ownerId: 'bob', url: 'https://x/b', events: ['*'] });

        assert.equal((await m.list('alice')).length, 1);
        await assert.rejects(() => m.get('bob', wh.id), (e) => e.code === 'NOT_FOUND');
        await assert.rejects(() => m.delete('bob', wh.id), (e) => e.code === 'NOT_FOUND');
        await m.delete('alice', wh.id);
        assert.equal((await m.list('alice')).length, 0);
    });
});

// ── REST route integration (real http server + fetch, like api.integration.test.js) ──
describe('webhook REST routes', () => {
    let server, base, key;

    before(async () => {
        const built = createInMemoryApiApp({ apiKeySecret: 'wh-secret', allowAnonymous: false });
        key = built.apiKeys.issue({ ownerId: 'acct_1', scopes: ['*'] });
        server = http.createServer(built.app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}/api/v1/webhooks`;
    });
    after(() => { server?.close(); });

    const authHeaders = () => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });

    it('requires an API key (401 anonymous)', async () => {
        const res = await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://x/y', events: ['*'] }),
        });
        assert.equal(res.status, 401);
    });

    it('creates, lists, fetches, and deletes a webhook', async () => {
        const create = await fetch(base, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ url: 'https://hooks.example/z', events: ['share.created'] }),
        });
        const created = await create.json();
        assert.equal(create.status, 201);
        assert.ok(created.secret);
        const id = created.id;

        const list = await (await fetch(base, { headers: authHeaders() })).json();
        assert.equal(list.count, 1);

        const get = await (await fetch(`${base}/${id}`, { headers: authHeaders() })).json();
        assert.equal(get.secret, undefined);

        const del = await fetch(`${base}/${id}`, { method: 'DELETE', headers: authHeaders() });
        assert.equal(del.status, 200);
        assert.equal((await del.json()).deleted, true);
    });

    it('rejects a malformed webhook id', async () => {
        const res = await fetch(`${base}/not-an-id`, { headers: authHeaders() });
        assert.equal(res.status, 400);
    });
});
