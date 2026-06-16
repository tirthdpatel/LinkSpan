import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import {
    SESSION_TIMEOUT_MS,
    MAX_PEERS_PER_SESSION,
} from '../../shared/constants.js';
import { RelayTransfer } from './RelayTransfer.js';

export class SessionManager {
    constructor() {
        /** @type {Map<string, Session>} sessionId → session */
        this.sessions = new Map();
        /** @type {Map<string, string>} pairingCode → sessionId */
        this.pairingCodes = new Map();

        // Server-relay fallback state (single-instance, in memory). The Redis
        // backend mirrors these methods using shared keys so relay works across
        // instances; routing all relay state through the session manager keeps
        // server.js identical for both deployments.
        this._relay = new RelayTransfer();

        this._startTime = Date.now();

        // Periodic cleanup every 60 seconds
        this._cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }

    // ── Cross-peer delivery ────────────────────────────────────

    /**
     * Deliver a JSON message to the *other* peer in a session.
     *
     * On the in-memory backend the other peer is always local, so this is a
     * direct WebSocket send. The Redis backend overrides this to route across
     * instances via pub/sub. Returning a boolean lets callers know whether a
     * peer was actually reachable.
     *
     * @param {string} sessionId
     * @param {string} fromPeerId
     * @param {object} message
     * @returns {Promise<boolean>} true if delivered
     */
    async sendToOtherPeer(sessionId, fromPeerId, message) {
        const ws = this.getOtherPeer(sessionId, fromPeerId);
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    // ── Relay fallback (delegates to internal RelayTransfer) ───

    activateRelay(sessionId) { return this._relay.activate(sessionId); }
    isRelayActive(sessionId) { return this._relay.isActive(sessionId); }
    accountRelay(sessionId, bytes) { return this._relay.relayChunk(sessionId, bytes); }
    deactivateRelay(sessionId) { return this._relay.deactivate(sessionId); }

    /**
     * @returns {{ relayActiveSessions: number, relayBytesRelayed: number }}
     */
    getRelayStats() {
        const s = this._relay.getStats();
        return { relayActiveSessions: s.activeSessions, relayBytesRelayed: s.totalBytesRelayed };
    }

    // ── Session Lifecycle ──────────────────────────────────────

    /**
     * Create a new session.
     * @returns {{ sessionId: string, pairingCode: string, token: string }}
     */
    createSession() {
        const sessionId = uuidv4();
        const pairingCode = this._generatePairingCode();
        const token = this._generateSecureToken();

        /** @type {Session} */
        const session = {
            sessionId,
            pairingCode,
            token,
            peers: [],          // [{ peerId, ws, role }]
            ownerId: null,      // set when first peer is added
            createdAt: Date.now(),
            lastActivity: Date.now(),
        };

        this.sessions.set(sessionId, session);
        this.pairingCodes.set(pairingCode, sessionId);

        return { sessionId, pairingCode, token };
    }

    /**
     * Join an existing session by pairing code.
     * @param {string} pairingCode
     * @returns {{ sessionId: string, token: string } | null}
     */
    joinSession(pairingCode) {
        const sessionId = this.pairingCodes.get(pairingCode);
        if (!sessionId) return null;

        const session = this.sessions.get(sessionId);
        if (!session) return null;

        if (session.peers.length >= MAX_PEERS_PER_SESSION) return null;

        const token = this._generateSecureToken();
        session.lastActivity = Date.now();

        return { sessionId, token };
    }

    /**
     * Register a WebSocket connection for a peer in a session.
     * @param {string} sessionId
     * @param {string} peerId
     * @param {WebSocket} ws
     * @param {'sender'|'receiver'} [role]
     * @returns {boolean}
     */
    addPeer(sessionId, peerId, ws, role = 'unknown') {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (session.peers.length >= MAX_PEERS_PER_SESSION) return false;

        session.peers.push({ peerId, ws, role });
        session.lastActivity = Date.now();

        // First peer becomes owner
        if (session.peers.length === 1) {
            session.ownerId = peerId;
        }

        return true;
    }

    /**
     * Remove a peer from a session.
     * @param {string} sessionId
     * @param {string} peerId
     */
    removePeer(sessionId, peerId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.peers = session.peers.filter((p) => p.peerId !== peerId);
        session.lastActivity = Date.now();

        // Destroy session if empty
        if (session.peers.length === 0) {
            this.destroySession(sessionId);
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
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const other = session.peers.find((p) => p.peerId !== fromPeerId);
        return other ? other.ws : null;
    }

    /**
     * Validate that a peerId is a registered member of a session.
     * Use before relaying any SDP/ICE message.
     * @param {string} sessionId
     * @param {string} peerId
     * @returns {boolean}
     */
    validatePeer(sessionId, peerId) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        return session.peers.some((p) => p.peerId === peerId);
    }

    /**
     * Get session by ID (updates lastActivity).
     * @param {string} sessionId
     * @returns {Session | null}
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.lastActivity = Date.now();
        return session || null;
    }

    // ── Lifecycle ──────────────────────────────────────────────

    /**
     * Destroy a session and clean up all references.
     * @param {string} sessionId
     */
    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        this.pairingCodes.delete(session.pairingCode);
        this.sessions.delete(sessionId);
    }

    /**
     * Clean up expired sessions.
     */
    cleanup() {
        const now = Date.now();

        // Expire stale sessions
        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
                for (const peer of session.peers) {
                    try {
                        peer.ws.send(
                            JSON.stringify({
                                type: 'session-closed',
                                reason: 'timeout',
                            })
                        );
                        peer.ws.close();
                    } catch {
                        // Peer already disconnected
                    }
                }
                this.destroySession(sessionId);
            }
        }
    }

    /**
     * Get stats for diagnostics / health endpoint.
     * @returns {object}
     */
    getStats() {
        return {
            activeSessions: this.sessions.size,
            activePairingCodes: this.pairingCodes.size,
            uptimeSeconds: Math.floor((Date.now() - this._startTime) / 1000),
        };
    }

    /**
     * Shutdown the manager — clear interval and destroy all sessions.
     */
    shutdown() {
        clearInterval(this._cleanupInterval);
        this._relay.shutdown();
        for (const [sessionId] of this.sessions) {
            this.destroySession(sessionId);
        }
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Generate a unique 6-digit numeric pairing code using CSPRNG.
     * Uses Node.js built-in crypto.randomInt — cryptographically secure.
     * @returns {string}
     */
    _generatePairingCode() {
        let code;
        let attempts = 0;
        do {
            // crypto.randomInt(min, max) returns integer in [min, max)
            code = crypto.randomInt(100000, 1000000).toString();
            attempts++;
            if (attempts > 1000) {
                throw new Error('Failed to generate unique pairing code — too many active sessions');
            }
        } while (this.pairingCodes.has(code));
        return code;
    }

    /**
     * Generate a cryptographically secure opaque token.
     * @returns {string} 32-byte hex token
     */
    _generateSecureToken() {
        return crypto.randomBytes(32).toString('hex');
    }
}
