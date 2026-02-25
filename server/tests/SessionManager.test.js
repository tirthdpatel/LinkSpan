import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/SessionManager.js';

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
