/**
 * Accounts subsystem: AccountManager (register/login/JWT/refresh/OAuth/API keys), the OAuth
 * provider code-exchange flow (mock fetch), and the /auth REST routes incl. the
 * account-ownership tie-in to share links — all over the in-memory API app.
 *
 * Hermetic. Run: node --test tests/
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager, AccountError } from '../src/accounts/AccountManager.js';
import { MemoryAccountStore } from '../src/accounts/AccountStore.js';
import { ApiKeyManager } from '../src/api/ApiKeyManager.js';
import { __test__ as oauthInternals } from '../src/accounts/OAuthProviders.js';
import { createInMemoryApiApp } from '../src/api/inMemoryApp.js';
import { ACCESS_TOKEN_TTL_MS } from '../../shared/constants.js';

function newManager(extra = {}) {
    const apiKeys = new ApiKeyManager({ secret: 'test-secret', allowAnonymous: false });
    const mgr = new AccountManager({ store: new MemoryAccountStore(), jwtSecret: 'jwt-secret', apiKeys, ...extra });
    return { mgr, apiKeys };
}

describe('AccountManager: register/login', () => {
    it('registers, rejects duplicates, and validates input', async () => {
        const { mgr } = newManager();
        const s = await mgr.register({ email: 'Alice@Example.com', password: 'hunter2pw' });
        assert.equal(s.account.email, 'alice@example.com');
        assert.ok(s.accessToken && s.refreshToken);

        await assert.rejects(() => mgr.register({ email: 'alice@example.com', password: 'another-pw' }),
            (e) => e instanceof AccountError && e.code === 'EMAIL_TAKEN');
        await assert.rejects(() => mgr.register({ email: 'bad', password: 'longenough' }), (e) => e.code === 'INVALID_EMAIL');
        await assert.rejects(() => mgr.register({ email: 'b@c.com', password: 'short' }), (e) => e.code === 'WEAK_PASSWORD');
    });

    it('logs in with correct password, rejects wrong', async () => {
        const { mgr } = newManager();
        await mgr.register({ email: 'b@c.com', password: 'correct-horse' });
        const s = await mgr.login({ email: 'b@c.com', password: 'correct-horse' });
        assert.ok(s.accessToken);
        await assert.rejects(() => mgr.login({ email: 'b@c.com', password: 'wrong' }), (e) => e.code === 'INVALID_CREDENTIALS');
        await assert.rejects(() => mgr.login({ email: 'nope@c.com', password: 'whatever1' }), (e) => e.code === 'INVALID_CREDENTIALS');
    });
});

describe('AccountManager: tokens', () => {
    it('verifies access tokens and rejects tampered/expired ones', async () => {
        let clock = Date.now();
        const { mgr } = newManager({ now: () => clock });
        const s = await mgr.register({ email: 'a@b.com', password: 'password123' });
        const claims = mgr.verifyAccessToken(s.accessToken);
        assert.equal(claims.accountId, s.account.id);
        assert.equal(mgr.verifyAccessToken(s.accessToken + 'x'), null);
        clock += ACCESS_TOKEN_TTL_MS + 1000;
        assert.equal(mgr.verifyAccessToken(s.accessToken), null, 'expired token rejected');
    });

    it('rotates refresh tokens (old becomes invalid) and logout invalidates', async () => {
        const { mgr } = newManager();
        const s = await mgr.register({ email: 'r@b.com', password: 'password123' });
        const next = await mgr.refresh(s.refreshToken);
        assert.ok(next.accessToken);
        await assert.rejects(() => mgr.refresh(s.refreshToken), (e) => e.code === 'INVALID_REFRESH');
        await mgr.logout(next.refreshToken);
        await assert.rejects(() => mgr.refresh(next.refreshToken), (e) => e.code === 'INVALID_REFRESH');
    });

    it('signs and verifies stateless OAuth state', () => {
        const { mgr } = newManager();
        const state = mgr.signOAuthState('google');
        assert.equal(mgr.verifyOAuthState(state), 'google');
        assert.equal(mgr.verifyOAuthState(state + 'x'), null);
        assert.equal(mgr.verifyOAuthState('garbage'), null);
    });
});

describe('AccountManager: OAuth find-or-create', () => {
    it('creates, then links by email, then by provider id', async () => {
        const { mgr } = newManager();
        // First OAuth login creates an account.
        const s1 = await mgr.findOrCreateByOAuth({ provider: 'github', providerId: 'gh1', email: 'dev@x.com' });
        // Same provider id → same account.
        const s2 = await mgr.findOrCreateByOAuth({ provider: 'github', providerId: 'gh1', email: 'dev@x.com' });
        assert.equal(s1.account.id, s2.account.id);

        // A password account with a matching verified email gets linked, not duplicated.
        const pw = await mgr.register({ email: 'linkme@x.com', password: 'password123' });
        const linked = await mgr.findOrCreateByOAuth({ provider: 'google', providerId: 'goog9', email: 'linkme@x.com' });
        assert.equal(linked.account.id, pw.account.id);
    });
});

describe('AccountManager: account API keys', () => {
    it('issues a usable key, lists it, and revokes it', async () => {
        const { mgr, apiKeys } = newManager();
        const acct = await mgr.register({ email: 'k@b.com', password: 'password123' });
        const issued = await mgr.issueApiKey(acct.account.id, { scopes: ['links:read'], label: 'ci' });
        assert.ok(issued.key);

        const principal = apiKeys.authenticate(issued.key);
        assert.equal(principal.ownerId, acct.account.id);
        assert.equal(principal.jti, issued.id);

        assert.equal((await mgr.listApiKeys(acct.account.id)).length, 1);
        assert.equal(await mgr.revokeApiKey(acct.account.id, issued.id), true);
        assert.equal(mgr.isApiKeyRevoked(issued.id), true);
        assert.equal((await mgr.listApiKeys(acct.account.id)).length, 0);
    });
});

describe('OAuthProviders code exchange (mock fetch)', () => {
    it('google: exchanges code and reads verified identity', async () => {
        const fetchImpl = async (url) => {
            if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'g-tok' }) };
            if (url.includes('userinfo')) return { ok: true, json: async () => ({ sub: '42', email: 'g@x.com', email_verified: true }) };
            throw new Error(`unexpected ${url}`);
        };
        const google = oauthInternals.makeGoogle({ clientId: 'id', clientSecret: 'sec', fetchImpl });
        assert.match(google.authorizeUrl('st', 'https://app/cb'), /accounts\.google\.com/);
        const { accessToken } = await google.exchangeCode('code', 'https://app/cb');
        const id = await google.getIdentity(accessToken);
        assert.deepEqual(id, { providerId: '42', email: 'g@x.com', emailVerified: true });
    });

    it('github: reads the verified primary email from /user/emails', async () => {
        const fetchImpl = async (url) => {
            if (url.includes('access_token')) return { ok: true, json: async () => ({ access_token: 'gh-tok' }) };
            if (url.endsWith('/user')) return { ok: true, json: async () => ({ id: 7, login: 'dev', email: null }) };
            if (url.endsWith('/user/emails')) return { ok: true, json: async () => ([{ email: 'p@x.com', primary: true, verified: true }]) };
            throw new Error(`unexpected ${url}`);
        };
        const gh = oauthInternals.makeGithub({ clientId: 'id', clientSecret: 'sec', fetchImpl });
        const { accessToken } = await gh.exchangeCode('code', 'https://app/cb');
        const id = await gh.getIdentity(accessToken);
        assert.deepEqual(id, { providerId: '7', email: 'p@x.com', emailVerified: true });
    });
});

// ── REST route integration ─────────────────────────────────────
describe('auth REST routes', () => {
    let server, base;
    const mockGoogle = {
        authorizeUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        exchangeCode: async () => ({ accessToken: 'tok' }),
        getIdentity: async () => ({ providerId: 'g-123', email: 'oauth@example.com', emailVerified: true }),
    };

    before(async () => {
        const built = createInMemoryApiApp({ apiKeySecret: 'auth-secret', allowAnonymous: false, oauthProviders: { google: mockGoogle } });
        server = http.createServer(built.app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}/api/v1`;
    });
    after(() => { server?.close(); });

    const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    it('register → me → refresh', async () => {
        const reg = await (await post('/auth/register', { email: 'u@x.com', password: 'password123' })).json();
        assert.ok(reg.accessToken);

        const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${reg.accessToken}` } });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).account.email, 'u@x.com');

        const refreshed = await (await post('/auth/refresh', { refreshToken: reg.refreshToken })).json();
        assert.ok(refreshed.accessToken && refreshed.refreshToken !== reg.refreshToken);
    });

    it('an account access token can create and list its own share links', async () => {
        const reg = await (await post('/auth/register', { email: 'owner@x.com', password: 'password123' })).json();
        const authH = { authorization: `Bearer ${reg.accessToken}` };

        const created = await (await post('/links', { filename: 'a.txt', size: 1 }, authH)).json();
        assert.ok(created.id);

        const list = await (await fetch(`${base}/links`, { headers: authH })).json();
        assert.equal(list.count, 1, 'link is owned by the account');
    });

    it('account API key works as a bearer credential and can be revoked', async () => {
        const reg = await (await post('/auth/register', { email: 'key@x.com', password: 'password123' })).json();
        const authH = { authorization: `Bearer ${reg.accessToken}` };

        const issued = await (await post('/auth/api-keys', { scopes: ['*'], label: 'ci' }, authH)).json();
        assert.ok(issued.key);

        // The minted key authorizes the API.
        const withKey = await fetch(`${base}/links`, { headers: { authorization: `Bearer ${issued.key}` } });
        assert.equal(withKey.status, 200);

        // Revoke → the key is rejected.
        const del = await fetch(`${base}/auth/api-keys/${issued.id}`, { method: 'DELETE', headers: authH });
        assert.equal(del.status, 200);
        const after = await fetch(`${base}/links`, { headers: { authorization: `Bearer ${issued.key}` } });
        assert.equal(after.status, 401);
    });

    it('login rejects wrong credentials with 401', async () => {
        await post('/auth/register', { email: 'z@x.com', password: 'password123' });
        const bad = await post('/auth/login', { email: 'z@x.com', password: 'nope' });
        assert.equal(bad.status, 401);
    });

    it('OAuth: redirect carries signed state, callback issues a session', async () => {
        const redir = await fetch(`${base}/auth/oauth/google`, { redirect: 'manual' });
        assert.equal(redir.status, 302);
        const loc = new URL(redir.headers.get('location'));
        const state = loc.searchParams.get('state');
        assert.ok(state);

        const cb = await fetch(`${base}/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
        assert.equal(cb.status, 200);
        const session = await cb.json();
        assert.equal(session.account.email, 'oauth@example.com');
        assert.equal(session.account.provider, 'google');
    });

    it('OAuth callback rejects a forged state', async () => {
        const cb = await fetch(`${base}/auth/oauth/google/callback?code=abc&state=forged`);
        assert.equal(cb.status, 400);
    });
});
