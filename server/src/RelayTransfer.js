import {
    MAX_RELAY_SESSION_BYTES,
    MAX_RELAY_DURATION_MS,
} from '../../shared/constants.js';

/**
 * RelayTransfer — Server-relay fallback when WebRTC DataChannels fail.
 *
 * Activated when a session sends MSG.RELAY_REQUEST.
 * After activation, MSG.RELAY_CHUNK messages are forwarded to the other peer
 * as binary data, mirroring the DataChannel protocol without modification.
 *
 * Limits:
 *   - MAX_RELAY_SESSION_BYTES per session (default 100MB)
 *   - MAX_RELAY_DURATION_MS per session (default 30 minutes)
 *
 * The relay uses the existing WebSocket sessions — no new infrastructure needed.
 * For large files, the relay is memory-efficient: it never buffers chunks,
 * only forwards them immediately to the other peer.
 */
export class RelayTransfer {
    constructor() {
        /** @type {Map<string, RelaySession>} sessionId → relay state */
        this._sessions = new Map();
    }

    /**
     * Activate relay mode for a session.
     * @param {string} sessionId
     * @returns {boolean} true if activated successfully
     */
    activate(sessionId) {
        if (this._sessions.has(sessionId)) return true; // already active

        this._sessions.set(sessionId, {
            sessionId,
            bytesRelayed: 0,
            startedAt: Date.now(),
            timeout: setTimeout(() => {
                this._sessions.delete(sessionId);
                console.log(`[Relay] Session ${sessionId.slice(0, 8)} expired`);
            }, MAX_RELAY_DURATION_MS),
        });

        console.log(`[Relay] Session ${sessionId.slice(0, 8)} activated`);
        return true;
    }

    /**
     * Check if a session has relay active.
     * @param {string} sessionId
     * @returns {boolean}
     */
    isActive(sessionId) {
        return this._sessions.has(sessionId);
    }

    /**
     * Account for a relayed chunk and enforce the session byte cap.
     *
     * Since all relay traffic is now JSON (binary chunks are base64-encoded),
     * the server never handles raw bytes directly. This method purely tracks
     * the byte count and enforces the cap — the caller handles the actual
     * forwarding via sendJson().
     *
     * @param {string} sessionId
     * @param {number} byteCount - number of bytes being relayed (original, pre-base64)
     * @returns {{ ok: boolean, reason?: string }}
     */
    relayChunk(sessionId, byteCount) {
        const relay = this._sessions.get(sessionId);
        if (!relay) return { ok: false, reason: 'Relay not active for this session' };

        relay.bytesRelayed += byteCount;

        if (relay.bytesRelayed > MAX_RELAY_SESSION_BYTES) {
            this.deactivate(sessionId);
            return { ok: false, reason: 'Relay size limit exceeded' };
        }

        return { ok: true };
    }

    /**
     * Deactivate relay for a session (transfer complete or limit exceeded).
     * @param {string} sessionId
     */
    deactivate(sessionId) {
        const relay = this._sessions.get(sessionId);
        if (!relay) return;

        clearTimeout(relay.timeout);
        this._sessions.delete(sessionId);
        console.log(`[Relay] Session ${sessionId.slice(0, 8)} deactivated — ${relay.bytesRelayed} bytes relayed`);
    }

    /**
     * Get relay stats for monitoring.
     */
    getStats() {
        let totalBytes = 0;
        for (const session of this._sessions.values()) {
            totalBytes += session.bytesRelayed;
        }
        return {
            activeSessions: this._sessions.size,
            totalBytesRelayed: totalBytes,
        };
    }

    /**
     * Shutdown all relay sessions.
     */
    shutdown() {
        for (const [sessionId] of this._sessions) {
            this.deactivate(sessionId);
        }
    }
}
