import { v4 as uuidv4 } from 'uuid';
import {
    SESSION_TIMEOUT_MS,
    MAX_PEERS_PER_SESSION,
    PAIRING_CODE_LENGTH,
} from '../../shared/constants.js';

export class SessionManager {
    constructor() {
        /** @type {Map<string, Session>} */
        this.sessions = new Map();
        /** @type {Map<string, string>} pairingCode → sessionId */
        this.pairingCodes = new Map();

        // Periodic cleanup every 60 seconds
        this._cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }

    /**
     * Create a new session.
     * @returns {{ sessionId: string, pairingCode: string, token: string }}
     */
    createSession() {
        const sessionId = uuidv4();
        const pairingCode = this._generatePairingCode();
        const token = uuidv4();

        const session = {
            sessionId,
            pairingCode,
            token,
            peers: [],
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

        const token = uuidv4();
        session.lastActivity = Date.now();

        return { sessionId, token };
    }

    /**
     * Register a WebSocket connection for a peer in a session.
     * @param {string} sessionId
     * @param {string} peerId - unique identifier for this peer
     * @param {WebSocket} ws
     * @returns {boolean}
     */
    addPeer(sessionId, peerId, ws) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (session.peers.length >= MAX_PEERS_PER_SESSION) return false;

        session.peers.push({ peerId, ws });
        session.lastActivity = Date.now();
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
     * Get session by ID.
     * @param {string} sessionId
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.lastActivity = Date.now();
        return session || null;
    }

    /**
     * Destroy a session and clean up.
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
        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
                // Notify connected peers before destroying
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
     * Get stats for diagnostics.
     */
    getStats() {
        return {
            activeSessions: this.sessions.size,
            activePairingCodes: this.pairingCodes.size,
        };
    }

    /**
     * Generate a unique 6-digit numeric pairing code.
     * @returns {string}
     */
    _generatePairingCode() {
        let code;
        do {
            code = Math.floor(100000 + Math.random() * 900000).toString();
        } while (this.pairingCodes.has(code));
        return code;
    }

    /**
     * Shutdown the manager.
     */
    shutdown() {
        clearInterval(this._cleanupInterval);
        for (const [sessionId] of this.sessions) {
            this.destroySession(sessionId);
        }
    }
}
