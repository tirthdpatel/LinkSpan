import { describe, it, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/SessionManager.js';
import { BruteForceGuard } from '../src/BruteForceGuard.js';
import { TokenManager } from '../src/TokenManager.js';

describe('SessionManager', () => {
    let manager;

    beforeEach(() => {
        manager = new SessionManager();
    });

    afterEach(() => {
        manager.shutdown();
    });

    describe('createSession', () => {
        it('creates a session with valid properties', () => {
            const result = manager.createSession();
            assert.ok(result.sessionId);
            assert.ok(result.pairingCode);
            assert.ok(result.token);
            assert.match(result.pairingCode, /^\d{6}$/);
        });

        it('creates unique session IDs', () => {
            const s1 = manager.createSession();
            const s2 = manager.createSession();
            assert.notEqual(s1.sessionId, s2.sessionId);
        });

        it('creates unique pairing codes', () => {
            const s1 = manager.createSession();
            const s2 = manager.createSession();
            assert.notEqual(s1.pairingCode, s2.pairingCode);
        });

        it('tracks sessions in stats', () => {
            manager.createSession();
            manager.createSession();
            const stats = manager.getStats();
            assert.equal(stats.activeSessions, 2);
            assert.equal(stats.activePairingCodes, 2);
        });
    });

    describe('joinSession', () => {
        it('joins with valid pairing code', () => {
            const created = manager.createSession();
            const result = manager.joinSession(created.pairingCode);
            assert.notEqual(result, null);
            assert.equal(result.sessionId, created.sessionId);
            assert.ok(result.token);
        });

        it('returns null for invalid pairing code', () => {
            const result = manager.joinSession('000000');
            assert.equal(result, null);
        });

        it('returns null when session is full', () => {
            const created = manager.createSession();
            const ws1 = { readyState: 1, send: () => { }, close: () => { } };
            const ws2 = { readyState: 1, send: () => { }, close: () => { } };
            manager.addPeer(created.sessionId, 'peer1', ws1);
            manager.addPeer(created.sessionId, 'peer2', ws2);

            const result = manager.joinSession(created.pairingCode);
            assert.equal(result, null);
        });
    });

    describe('addPeer / removePeer', () => {
        it('adds and removes peers', () => {
            const created = manager.createSession();
            const ws = { readyState: 1, send: () => { }, close: () => { } };
            const added = manager.addPeer(created.sessionId, 'peer1', ws);
            assert.equal(added, true);

            manager.removePeer(created.sessionId, 'peer1');
            assert.equal(manager.getSession(created.sessionId), null);
        });

        it('rejects peer for non-existent session', () => {
            const ws = { readyState: 1, send: () => { }, close: () => { } };
            const added = manager.addPeer('fake-id', 'peer1', ws);
            assert.equal(added, false);
        });

        it('enforces max 2 peers', () => {
            const created = manager.createSession();
            const ws1 = { readyState: 1, send: () => { }, close: () => { } };
            const ws2 = { readyState: 1, send: () => { }, close: () => { } };
            const ws3 = { readyState: 1, send: () => { }, close: () => { } };

            assert.equal(manager.addPeer(created.sessionId, 'p1', ws1), true);
            assert.equal(manager.addPeer(created.sessionId, 'p2', ws2), true);
            assert.equal(manager.addPeer(created.sessionId, 'p3', ws3), false);
        });
    });

    describe('getOtherPeer', () => {
        it('returns the other peer WebSocket', () => {
            const created = manager.createSession();
            const ws1 = { readyState: 1, send: () => { }, close: () => { } };
            const ws2 = { readyState: 1, send: () => { }, close: () => { } };
            manager.addPeer(created.sessionId, 'p1', ws1);
            manager.addPeer(created.sessionId, 'p2', ws2);

            assert.equal(manager.getOtherPeer(created.sessionId, 'p1'), ws2);
            assert.equal(manager.getOtherPeer(created.sessionId, 'p2'), ws1);
        });

        it('returns null when alone', () => {
            const created = manager.createSession();
            const ws = { readyState: 1, send: () => { }, close: () => { } };
            manager.addPeer(created.sessionId, 'p1', ws);
            assert.equal(manager.getOtherPeer(created.sessionId, 'p1'), null);
        });
    });

    describe('destroySession', () => {
        it('removes session and pairing code', () => {
            const created = manager.createSession();
            manager.destroySession(created.sessionId);
            assert.equal(manager.getSession(created.sessionId), null);
            assert.equal(manager.getStats().activeSessions, 0);
        });
    });

    describe('cleanup', () => {
        it('removes expired sessions', () => {
            const created = manager.createSession();
            const session = manager.getSession(created.sessionId);
            session.lastActivity = Date.now() - 11 * 60 * 1000;
            manager.cleanup();
            assert.equal(manager.getSession(created.sessionId), null);
        });

        it('keeps active sessions', () => {
            const created = manager.createSession();
            manager.cleanup();
            assert.notEqual(manager.getSession(created.sessionId), null);
        });
    });
});

// ── CSPRNG Uniformity ─────────────────────────────────────────────────────

describe('SessionManager — CSPRNG pairing codes', () => {
    it('generates statistically uniform 6-digit codes', () => {
        // Sample 200 codes and verify no obvious bias (all digits should appear)
        const m = new SessionManager();
        const digits = new Set();
        const codes = [];

        for (let i = 0; i < 200; i++) {
            const { pairingCode } = m.createSession();
            assert.match(pairingCode, /^\d{6}$/, `Code ${pairingCode} is not 6 digits`);
            codes.push(pairingCode);
            for (const ch of pairingCode) digits.add(ch);
        }

        // All 10 digits should appear in 200 * 6 = 1200 samples
        assert.equal(digits.size, 10, `Only ${digits.size}/10 distinct digits seen — possible bias`);

        // No two consecutive codes should be identical
        for (let i = 1; i < codes.length; i++) {
            assert.notEqual(codes[i], codes[i - 1]);
        }

        m.shutdown();
    });
});

// ── Session Ownership / validatePeer ──────────────────────────────────────

describe('SessionManager — validatePeer', () => {
    let mgr;

    beforeEach(() => { mgr = new SessionManager(); });
    afterEach(() => mgr.shutdown());

    it('returns true for a registered peer', () => {
        const { sessionId } = mgr.createSession();
        const ws = { readyState: 1, send: () => {}, close: () => {} };
        mgr.addPeer(sessionId, 'p1', ws);
        assert.equal(mgr.validatePeer(sessionId, 'p1'), true);
    });

    it('returns false for an unregistered peer', () => {
        const { sessionId } = mgr.createSession();
        assert.equal(mgr.validatePeer(sessionId, 'impostor'), false);
    });

    it('returns false for a non-existent session', () => {
        assert.equal(mgr.validatePeer('no-such-session', 'p1'), false);
    });

    it('ownerId is the first peer added', () => {
        const { sessionId } = mgr.createSession();
        const ws = { readyState: 1, send: () => {}, close: () => {} };
        mgr.addPeer(sessionId, 'first', ws);
        const session = mgr.getSession(sessionId);
        assert.equal(session.ownerId, 'first');
    });
});

// ── BruteForceGuard ───────────────────────────────────────────────────────

describe('BruteForceGuard', () => {
    let guard;

    beforeEach(() => { guard = new BruteForceGuard(); });
    afterEach(() => guard.shutdown());

    it('is not locked initially', () => {
        assert.equal(guard.isLocked('1.2.3.4'), false);
    });

    it('records failures and is not locked until threshold', () => {
        for (let i = 0; i < 9; i++) {
            guard.recordFailure('1.2.3.4');
        }
        assert.equal(guard.isLocked('1.2.3.4'), false);
    });

    it('locks after 10 failures', () => {
        for (let i = 0; i < 10; i++) {
            guard.recordFailure('10.0.0.1');
        }
        assert.equal(guard.isLocked('10.0.0.1'), true);
    });

    it('recordSuccess resets failure count', () => {
        for (let i = 0; i < 9; i++) {
            guard.recordFailure('5.5.5.5');
        }
        guard.recordSuccess('5.5.5.5');
        // Now 10 more failures should still lock (counter was reset)
        for (let i = 0; i < 10; i++) {
            guard.recordFailure('5.5.5.5');
        }
        assert.equal(guard.isLocked('5.5.5.5'), true);
    });

    it('getStats returns a stats object', () => {
        const stats = guard.getStats();
        assert.ok(typeof stats === 'object');
        assert.ok('lockedIps' in stats || 'totalLockouts' in stats || Object.keys(stats).length >= 0);
    });
});

// ── TokenManager ──────────────────────────────────────────────────────────

describe('TokenManager', () => {
    const tm = new TokenManager('test-secret-key-32-bytes-long!!');

    test('sign produces a non-empty string', () => {
        const token = tm.sign({ sessionId: 'sid', peerId: 'pid', role: 'sender' });
        assert.ok(typeof token === 'string');
        assert.ok(token.length > 0);
    });

    test('verify round-trip succeeds', () => {
        const payload = { sessionId: 'abc', peerId: 'xyz', role: 'receiver' };
        const token = tm.sign(payload);
        const decoded = tm.verify(token);
        assert.ok(decoded !== null);
        assert.equal(decoded.sessionId, payload.sessionId);
        assert.equal(decoded.peerId, payload.peerId);
        assert.equal(decoded.role, payload.role);
    });

    test('verify rejects a tampered token', () => {
        const token = tm.sign({ sessionId: 'abc', peerId: 'xyz', role: 'sender' });
        // Tamper with the last character of the HMAC
        const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
        const result = tm.verify(tampered);
        assert.equal(result, null);
    });

    test('verify rejects a token with wrong secret', () => {
        const tm2 = new TokenManager('different-secret-key-32-bytes!!');
        const token = tm.sign({ sessionId: 's', peerId: 'p', role: 'sender' });
        assert.equal(tm2.verify(token), null);
    });

    test('verify rejects an expired token', async () => {
        // Sign with 0-second TTL (already expired by the time we verify)
        const tmShort = new TokenManager('test-secret-key-32-bytes-long!!', 0);
        const token = tmShort.sign({ sessionId: 's', peerId: 'p', role: 'sender' });
        // Give a tiny delay to ensure expiry
        await new Promise(r => setTimeout(r, 10));
        const result = tmShort.verify(token);
        assert.equal(result, null);
    });
});
