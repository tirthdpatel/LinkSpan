import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TurnCredentialProvider } from '../src/api/TurnCredentials.js';

describe('TurnCredentialProvider', () => {
    it('is disabled when no provider env is set', async () => {
        const p = new TurnCredentialProvider({ env: {} });
        assert.equal(p.mode, 'disabled');
        assert.equal(p.enabled, false);
        assert.deepEqual(await p.getIceServers(), { iceServers: [], ttl: 0 });
    });

    it('static-secret mode mints coturn REST-API credentials with a valid HMAC', async () => {
        const env = {
            TURN_STATIC_SECRET: 'topsecret',
            TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
            TURN_CRED_TTL_SECONDS: '600',
        };
        const p = new TurnCredentialProvider({ env });
        assert.equal(p.mode, 'static-secret');

        const { iceServers, ttl } = await p.getIceServers();
        assert.equal(ttl, 600);
        assert.equal(iceServers.length, 1);
        const [server] = iceServers;
        assert.deepEqual(server.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);

        // username = "<expiry>:linkspan" with expiry ≈ now + ttl
        const [expiryStr, user] = server.username.split(':');
        assert.equal(user, 'linkspan');
        const expiry = Number(expiryStr);
        const expected = Math.floor(Date.now() / 1000) + 600;
        assert.ok(Math.abs(expiry - expected) < 5, 'expiry embeds now+ttl');

        // credential = base64(HMAC-SHA1(secret, username)) — what coturn recomputes
        const hmac = crypto.createHmac('sha1', 'topsecret').update(server.username).digest('base64');
        assert.equal(server.credential, hmac);
    });

    it('cloudflare mode fetches, normalizes, and caches ice servers', async () => {
        let calls = 0;
        const fetchImpl = async (url, opts) => {
            calls++;
            assert.match(url, /\/turn\/keys\/kid123\/credentials\/generate-ice-servers$/);
            assert.equal(opts.headers.Authorization, 'Bearer tok456');
            assert.equal(JSON.parse(opts.body).ttl, 7200);
            return {
                ok: true,
                json: async () => ({
                    iceServers: [{
                        urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
                        username: 'u', credential: 'c',
                    }],
                }),
            };
        };
        const env = { CLOUDFLARE_TURN_KEY_ID: 'kid123', CLOUDFLARE_TURN_API_TOKEN: 'tok456' };
        const p = new TurnCredentialProvider({ env, fetchImpl });
        assert.equal(p.mode, 'cloudflare');

        const first = await p.getIceServers();
        assert.equal(first.ttl, 7200);
        assert.equal(first.iceServers[0].username, 'u');

        // Second call is served from cache — no extra upstream hit.
        await p.getIceServers();
        assert.equal(calls, 1);
    });

    it('cloudflare mode accepts the older single-object response shape', async () => {
        const fetchImpl = async () => ({
            ok: true,
            json: async () => ({ iceServers: { urls: ['turn:x'], username: 'u', credential: 'c' } }),
        });
        const p = new TurnCredentialProvider({
            env: { CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' },
            fetchImpl,
        });
        const { iceServers } = await p.getIceServers();
        assert.equal(iceServers.length, 1);
        assert.deepEqual(iceServers[0].urls, ['turn:x']);
    });

    it('cloudflare upstream failure degrades to empty (never throws)', async () => {
        const p = new TurnCredentialProvider({
            env: { CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' },
            fetchImpl: async () => ({ ok: false, status: 503 }),
        });
        assert.deepEqual(await p.getIceServers(), { iceServers: [], ttl: 0 });
    });

    it('dedupes concurrent cloudflare fetches into one upstream call', async () => {
        let calls = 0;
        let release;
        const gate = new Promise((r) => { release = r; });
        const fetchImpl = async () => {
            calls++;
            await gate;
            return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'c' }] }) };
        };
        const p = new TurnCredentialProvider({
            env: { CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' },
            fetchImpl,
        });
        const both = Promise.all([p.getIceServers(), p.getIceServers()]);
        release();
        const [a, b] = await both;
        assert.equal(calls, 1);
        assert.deepEqual(a, b);
    });
});
