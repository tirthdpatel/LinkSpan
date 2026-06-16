import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import {
    SESSION_TIMEOUT_MS,
    MAX_PEERS_PER_SESSION,
    MAX_RELAY_SESSION_BYTES,
    MAX_RELAY_DURATION_MS,
} from '../../shared/constants.js';

// Sorted set of active session IDs scored by absolute expiry time (ms). Used for
// an accurate, drift-free active-session count (see getStats / _touchSessionIndex).
const SESSION_INDEX_KEY = 'linkspan:sessions';

/**
 * RedisSessionManager — Redis-backed session store for multi-instance deployments.
 *
 * Implements the same interface as SessionManager so server.js requires
 * zero changes when switching between single-instance and clustered deployments.
 *
 * Redis Key Scheme:
 *   session:{sessionId}    → JSON session object (TTL = SESSION_TIMEOUT_MS)
 *   code:{pairingCode}     → sessionId (TTL = SESSION_TIMEOUT_MS)
 *   peers:{sessionId}      → JSON array of peer metadata
 *
 * WebSocket handles (ws objects) cannot be stored in Redis — they are kept in a
 * local Map per instance. The two peers of a session may land on *different*
 * server instances (no sticky sessions required), so each peer's owning instance
 * is recorded in the session metadata and cross-instance delivery is done over
 * Redis pub/sub: each instance subscribes to a private channel `inst:{id}`, and
 * sendToOtherPeer() either delivers locally or publishes to the peer's instance.
 *
 * Relay-fallback state (active flag + byte counter) also lives in Redis so the
 * per-session byte cap is enforced even when the sender and receiver are on
 * different instances.
 */
export class RedisSessionManager {
    /**
     * @param {string} redisUrl - Redis connection URL (e.g., redis://localhost:6379)
     */
    constructor(redisUrl) {
        this._client = createClient({ url: redisUrl });
        this._client.on('error', (err) => console.error('[Redis] Error:', err.message));
        /** @type {Map<string, Map<string, WebSocket>>} sessionId → peerId → ws */
        this._wsRegistry = new Map();
        // Unique per process — identifies which instance owns a peer's WebSocket.
        this._instanceId = uuidv4();
        this._subClient = null;
        this._startTime = Date.now();
    }

    /**
     * Connect to Redis and subscribe to this instance's pub/sub channel so it
     * can receive messages destined for peers it owns.
     */
    async connect() {
        await this._client.connect();

        // A subscriber needs a dedicated connection in node-redis v4.
        this._subClient = this._client.duplicate();
        this._subClient.on('error', (err) => console.error('[Redis sub] Error:', err.message));
        await this._subClient.connect();
        await this._subClient.subscribe(`inst:${this._instanceId}`, (raw) => this._onBusMessage(raw));
    }

    /**
     * Handle a message published to this instance's channel — deliver it to the
     * locally-held WebSocket for the target peer.
     * @param {string} raw - JSON { sessionId, targetPeerId, message }
     */
    _onBusMessage(raw) {
        let env;
        try {
            env = JSON.parse(raw);
        } catch {
            return;
        }
        const ws = this._wsRegistry.get(env.sessionId)?.get(env.targetPeerId);
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(env.message));
        }
    }

    // ── Cross-peer delivery ────────────────────────────────────

    /**
     * Deliver a JSON message to the other peer in a session, wherever it lives.
     * @param {string} sessionId
     * @param {string} fromPeerId
     * @param {object} message
     * @returns {Promise<boolean>} true if a peer was found and dispatched
     */
    async sendToOtherPeer(sessionId, fromPeerId, message) {
        const raw = await this._client.get(`session:${sessionId}`);
        if (!raw) return false;

        const session = JSON.parse(raw);
        const other = session.peers.find((p) => p.peerId !== fromPeerId);
        if (!other) return false;

        if (other.instanceId === this._instanceId) {
            // Other peer is local — deliver directly.
            const ws = this._wsRegistry.get(sessionId)?.get(other.peerId);
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify(message));
                return true;
            }
            return false;
        }

        // Other peer is on a different instance — route over pub/sub.
        await this._client.publish(
            `inst:${other.instanceId}`,
            JSON.stringify({ sessionId, targetPeerId: other.peerId, message })
        );
        return true;
    }

    // ── Relay fallback (Redis-backed, cross-instance) ──────────

    /**
     * Mark a session's relay as active and initialise its byte counter.
     * @param {string} sessionId
     */
    async activateRelay(sessionId) {
        const ttl = Math.ceil(MAX_RELAY_DURATION_MS / 1000);
        await this._client.set(`relay:active:${sessionId}`, '1', { EX: ttl });
        // Only seed the counter if it doesn't already exist (idempotent re-activation).
        await this._client.set(`relay:bytes:${sessionId}`, '0', { EX: ttl, NX: true });
        return true;
    }

    async isRelayActive(sessionId) {
        return (await this._client.exists(`relay:active:${sessionId}`)) === 1;
    }

    /**
     * Atomically require the relay be active, add bytes, and enforce the cap.
     * One round-trip via a Lua script keeps the per-chunk cost low and the
     * check-and-increment race-free across instances.
     * @param {string} sessionId
     * @param {number} bytes
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async accountRelay(sessionId, bytes) {
        const result = await this._client.eval(
            `if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
             local total = redis.call('INCRBY', KEYS[2], ARGV[1])
             if total > tonumber(ARGV[2]) then
                redis.call('DEL', KEYS[1]); redis.call('DEL', KEYS[2]); return -2
             end
             return total`,
            {
                keys: [`relay:active:${sessionId}`, `relay:bytes:${sessionId}`],
                arguments: [String(bytes), String(MAX_RELAY_SESSION_BYTES)],
            }
        );
        if (result === -1) return { ok: false, reason: 'Relay not active for this session' };
        if (result === -2) return { ok: false, reason: 'Relay size limit exceeded' };
        return { ok: true };
    }

    async deactivateRelay(sessionId) {
        await Promise.all([
            this._client.del(`relay:active:${sessionId}`),
            this._client.del(`relay:bytes:${sessionId}`),
        ]);
    }

    /**
     * Relay stats are not aggregated across instances (would need a KEYS scan);
     * report zeros so /stats keys stay consistent with the in-memory backend.
     */
    getRelayStats() {
        return { relayActiveSessions: 0, relayBytesRelayed: 0 };
    }

    // ── Session Lifecycle ──────────────────────────────────────

    /**
     * Create a new session.
     * @returns {{ sessionId: string, pairingCode: string, token: string }}
     */
    async createSession() {
        const sessionId = uuidv4();
        const pairingCode = await this._generatePairingCode();
        const token = crypto.randomBytes(32).toString('hex');

        const session = {
            sessionId,
            pairingCode,
            token,
            peers: [],
            ownerId: null,
            createdAt: Date.now(),
            lastActivity: Date.now(),
        };

        const ttlSeconds = Math.ceil(SESSION_TIMEOUT_MS / 1000);

        await Promise.all([
            this._client.set(`session:${sessionId}`, JSON.stringify(session), { EX: ttlSeconds }),
            this._client.set(`code:${pairingCode}`, sessionId, { EX: ttlSeconds }),
            this._touchSessionIndex(sessionId),
        ]);

        return { sessionId, pairingCode, token };
    }

    /**
     * Join an existing session by pairing code.
     * @param {string} pairingCode
     * @returns {Promise<{ sessionId: string, token: string } | null>}
     */
    async joinSession(pairingCode) {
        const sessionId = await this._client.get(`code:${pairingCode}`);
        if (!sessionId) return null;

        const raw = await this._client.get(`session:${sessionId}`);
        if (!raw) return null;

        const session = JSON.parse(raw);
        if (session.peers.length >= MAX_PEERS_PER_SESSION) return null;

        const token = crypto.randomBytes(32).toString('hex');
        session.lastActivity = Date.now();

        const ttlSeconds = Math.ceil(SESSION_TIMEOUT_MS / 1000);
        await this._client.set(`session:${sessionId}`, JSON.stringify(session), { EX: ttlSeconds });
        await this._touchSessionIndex(sessionId);

        return { sessionId, token };
    }

    /**
     * Register a WebSocket connection for a peer.
     * @param {string} sessionId
     * @param {string} peerId
     * @param {WebSocket} ws
     * @param {string} [role]
     * @returns {Promise<boolean>}
     */
    async addPeer(sessionId, peerId, ws, role = 'unknown') {
        const raw = await this._client.get(`session:${sessionId}`);
        if (!raw) return false;

        const session = JSON.parse(raw);
        if (session.peers.length >= MAX_PEERS_PER_SESSION) return false;

        // Record which instance owns this peer's WebSocket so the other peer's
        // instance knows where to route messages.
        session.peers.push({ peerId, role, instanceId: this._instanceId });
        session.lastActivity = Date.now();

        if (!session.ownerId) {
            session.ownerId = peerId;
        }

        const ttlSeconds = Math.ceil(SESSION_TIMEOUT_MS / 1000);
        await this._client.set(`session:${sessionId}`, JSON.stringify(session), { EX: ttlSeconds });
        await this._touchSessionIndex(sessionId);

        // Store WS handle locally (cannot be serialized to Redis)
        if (!this._wsRegistry.has(sessionId)) {
            this._wsRegistry.set(sessionId, new Map());
        }
        this._wsRegistry.get(sessionId).set(peerId, ws);

        return true;
    }

    /**
     * Remove a peer from a session.
     * @param {string} sessionId
     * @param {string} peerId
     */
    async removePeer(sessionId, peerId) {
        const raw = await this._client.get(`session:${sessionId}`);
        if (!raw) return;

        const session = JSON.parse(raw);
        session.peers = session.peers.filter((p) => p.peerId !== peerId);

        if (session.peers.length === 0) {
            await this.destroySession(sessionId);
        } else {
            const ttlSeconds = Math.ceil(SESSION_TIMEOUT_MS / 1000);
            await this._client.set(`session:${sessionId}`, JSON.stringify(session), { EX: ttlSeconds });
            await this._touchSessionIndex(sessionId);
        }

        // Remove WS handle
        const wsMap = this._wsRegistry.get(sessionId);
        if (wsMap) {
            wsMap.delete(peerId);
            if (wsMap.size === 0) this._wsRegistry.delete(sessionId);
        }
    }

    // ── Peer Access ────────────────────────────────────────────

    /**
     * Get the other peer's WebSocket in a session.
     * @param {string} sessionId
     * @param {string} fromPeerId
     * @returns {WebSocket | null}
     */
    getOtherPeer(sessionId, fromPeerId) {
        const wsMap = this._wsRegistry.get(sessionId);
        if (!wsMap) return null;

        for (const [peerId, ws] of wsMap) {
            if (peerId !== fromPeerId) return ws;
        }
        return null;
    }

    /**
     * Validate that a peerId is registered in a session.
     * @param {string} sessionId
     * @param {string} peerId
     * @returns {boolean}
     */
    validatePeer(sessionId, peerId) {
        const wsMap = this._wsRegistry.get(sessionId);
        return wsMap ? wsMap.has(peerId) : false;
    }

    // ── Stats ──────────────────────────────────────────────────

    /**
     * @returns {Promise<{ activeSessions: number, activePairingCodes: number, uptimeSeconds: number, backend: string }>}
     */
    async getStats() {
        let activeSessions = 0;
        try {
            // The session index is a sorted set scored by expiry time. Drop any
            // entries whose TTL has passed (a plain INCR/DECR counter drifts upward
            // because TTL expiry never decrements it), then count what remains.
            await this._client.zRemRangeByScore(SESSION_INDEX_KEY, 0, Date.now());
            activeSessions = await this._client.zCard(SESSION_INDEX_KEY);
        } catch { /* Redis error — return best-effort zero */ }

        return {
            activeSessions,
            activePairingCodes: activeSessions, // 1:1 with sessions
            uptimeSeconds: Math.floor((Date.now() - this._startTime) / 1000),
            backend: 'redis',
        };
    }

    // ── Lifecycle ──────────────────────────────────────────────

    async destroySession(sessionId) {
        const raw = await this._client.get(`session:${sessionId}`);
        if (raw) {
            const session = JSON.parse(raw);
            await Promise.all([
                this._client.del(`session:${sessionId}`),
                this._client.del(`code:${session.pairingCode}`),
                this._client.zRem(SESSION_INDEX_KEY, sessionId),
            ]);
        } else {
            // Session already gone (e.g. key TTL expired) — still drop the index entry.
            await this._client.zRem(SESSION_INDEX_KEY, sessionId);
        }
        this._wsRegistry.delete(sessionId);
    }

    /**
     * Add or refresh this session's entry in the expiry-scored index, scored with
     * the same absolute expiry as its `session:*` key TTL. Called wherever that key
     * is (re)set, so the index and the keys expire together.
     * @param {string} sessionId
     */
    _touchSessionIndex(sessionId) {
        return this._client.zAdd(SESSION_INDEX_KEY, {
            score: Date.now() + SESSION_TIMEOUT_MS,
            value: sessionId,
        });
    }

    /**
     * Cleanup is handled by Redis TTLs — no periodic sweep needed.
     */
    cleanup() { /* TTLs handle expiry */ }

    /**
     * Shutdown — disconnect from Redis.
     */
    async shutdown() {
        try {
            await this._subClient?.quit();
        } catch { /* noop */ }
        try {
            await this._client.quit();
        } catch { /* noop */ }
    }

    // ── Private ────────────────────────────────────────────────

    async _generatePairingCode() {
        let code;
        let attempts = 0;
        do {
            code = crypto.randomInt(100000, 1000000).toString();
            const existing = await this._client.get(`code:${code}`);
            if (!existing) return code;
            attempts++;
        } while (attempts < 1000);

        throw new Error('Failed to generate unique pairing code');
    }
}
