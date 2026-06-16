/**
 * Unit tests for ApiKeyManager (Feature 17 auth/authz).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyManager } from '../src/api/ApiKeyManager.js';

describe('ApiKeyManager', () => {
    it('issues and verifies a signed key', () => {
        const m = new ApiKeyManager({ secret: 'test-secret', allowAnonymous: false });
        const key = m.issue({ ownerId: 'alice', scopes: ['links:write'] });
        const p = m.authenticate(key);
        assert.equal(p.ownerId, 'alice');
        assert.deepEqual(p.scopes, ['links:write']);
    });

    it('rejects a tampered signed key', () => {
        const m = new ApiKeyManager({ secret: 'test-secret' });
        const key = m.issue({ ownerId: 'alice' });
        assert.equal(m.authenticate(key + 'x'), null);
        // Flip the last char to a guaranteed-different one (replacing with a fixed 'A'
        // was a no-op ~1/64 of the time when the signature already ended in 'A').
        const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
        assert.equal(m.authenticate(tampered), null);
    });

    it('rejects a key signed with a different secret', () => {
        const a = new ApiKeyManager({ secret: 'secret-a' });
        const b = new ApiKeyManager({ secret: 'secret-b' });
        assert.equal(b.authenticate(a.issue({ ownerId: 'x' })), null);
    });

    it('supports static keys', () => {
        const m = new ApiKeyManager({ staticKeys: { 'sk_live_abc': 'owner1' } });
        assert.equal(m.authenticate('sk_live_abc').ownerId, 'owner1');
        assert.equal(m.authenticate('sk_live_wrong'), null);
    });

    it('rejects an expired signed key, accepts an unexpired one', () => {
        const m = new ApiKeyManager({ secret: 'test-secret', allowAnonymous: false });
        const expired = m.issue({ ownerId: 'alice', exp: Date.now() - 1000 });
        assert.equal(m.authenticate(expired), null);
        const valid = m.issue({ ownerId: 'alice', expiresInMs: 60_000 });
        assert.equal(m.authenticate(valid).ownerId, 'alice');
    });

    it('keys minted without expiry never expire (back-compat)', () => {
        const m = new ApiKeyManager({ secret: 'test-secret' });
        const key = m.issue({ ownerId: 'alice' });
        assert.equal(m.authenticate(key).ownerId, 'alice');
    });

    it('honors the denylist', () => {
        const m = new ApiKeyManager({ secret: 's', denylist: ['banned'] });
        const key = m.issue({ ownerId: 'banned' });
        assert.equal(m.authenticate(key), null);
    });

    it('scope checks', () => {
        const wild = { ownerId: 'a', scopes: ['*'] };
        const scoped = { ownerId: 'b', scopes: ['links:read'] };
        assert.equal(ApiKeyManager.hasScope(wild, 'links:write'), true);
        assert.equal(ApiKeyManager.hasScope(scoped, 'links:read'), true);
        assert.equal(ApiKeyManager.hasScope(scoped, 'links:write'), false);
        assert.equal(ApiKeyManager.hasScope(null, 'links:read'), false);
    });

    it('middleware: 401 when a key is required but absent', () => {
        const m = new ApiKeyManager({ allowAnonymous: false });
        const req = { headers: {} };
        let status; const res = { status(s) { status = s; return this; }, json() { return this; } };
        m.middleware()(req, res, () => { throw new Error('should not call next'); });
        assert.equal(status, 401);
    });

    it('middleware: allows anonymous when enabled', () => {
        const m = new ApiKeyManager({ allowAnonymous: true });
        const req = { headers: {} };
        let called = false;
        m.middleware()(req, { status() { return this; }, json() { return this; } }, () => { called = true; });
        assert.equal(called, true);
        assert.equal(req.principal, null);
    });
});
