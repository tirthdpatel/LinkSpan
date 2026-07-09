import {
    MAX_CHANNELS,
    CHANNEL_CONFIG,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
} from '@shared/constants.js';
import { getCachedIceServers } from './IceServers.js';

// Grace period a 'disconnected' connection is given to self-heal before we force an
// ICE restart. Long enough that a brief blip doesn't churn the connection, short enough
// that a real network switch recovers quickly instead of sitting dead.
const ICE_RESTART_GRACE_MS = 3000;

/**
 * PeerConnection — Wraps RTCPeerConnection with ICE config, multi-channel setup,
 * ICE restart, and browser sleep/wake detection.
 *
 * Improvements from v1:
 * - restartIce(): creates a new offer with iceRestart: true
 * - onfailed vs ondisconnected handled distinctly (failed needs ICE restart)
 * - Browser sleep/tab suspend detection via visibilitychange + freeze events
 * - On wakeup: triggers ICE restart to recover from stale connection
 */
export class PeerConnection {
    /**
     * @param {{
     *   onIceCandidate: Function,
     *   onChannel: Function,
     *   onConnectionStateChange: Function,
     *   onIceRestartRequired?: Function
     * }} callbacks
     */
    /**
     * @param {RTCIceServer[]} [iceServers] resolved list (e.g. from resolveIceServers());
     *   defaults to the synchronous cache/static fallback.
     */
    constructor(callbacks, iceServers) {
        this.callbacks = callbacks;
        /** @type {RTCPeerConnection | null} */
        this.pc = null;
        /** @type {RTCDataChannel[]} */
        this.channels = [];
        this._iceServers = iceServers || getCachedIceServers();
        this._sleepDetector = null;
        this._lastSeen = Date.now();
        /** @type {ReturnType<typeof setTimeout> | null} pending 'disconnected' → restart */
        this._iceRestartTimer = null;
        /** guards against overlapping ICE restarts (failed + disconnected racing) */
        this._iceRestarting = false;
    }

    // ── Lifecycle ──────────────────────────────────────────────

    /**
     * Initialize the peer connection.
     */
    init() {
        this.pc = new RTCPeerConnection({
            iceServers: this._iceServers,
            iceCandidatePoolSize: 10,
        });

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.callbacks.onIceCandidate(event.candidate.toJSON());
            }
        };

        this.pc.onconnectionstatechange = () => {
            const state = this.pc.connectionState;
            this.callbacks.onConnectionStateChange(state);

            if (state === 'failed') {
                // Hard failure — restart immediately.
                this._clearIceRestartTimer();
                console.warn('[PeerConnection] Connection failed — attempting ICE restart');
                this._tryIceRestart();
            } else if (state === 'disconnected') {
                // A network switch (Wi-Fi ↔ cellular) parks the connection in
                // 'disconnected', often for 15–30 s before it ever reaches 'failed' —
                // and sometimes it never does, so waiting for 'failed' alone leaves the
                // transfer dead. Give it a short grace period to self-heal, then force an
                // ICE restart so a network change recovers in place instead of stalling.
                if (!this._iceRestartTimer) {
                    this._iceRestartTimer = setTimeout(() => {
                        this._iceRestartTimer = null;
                        if (this.pc && this.pc.connectionState === 'disconnected') {
                            console.warn('[PeerConnection] Still disconnected — attempting ICE restart');
                            this._tryIceRestart();
                        }
                    }, ICE_RESTART_GRACE_MS);
                }
            } else if (state === 'connected' || state === 'completed') {
                // Recovered on its own (or the restart worked) — cancel any pending retry.
                this._clearIceRestartTimer();
            }
        };

        this.pc.ondatachannel = (event) => {
            this._configureChannel(event.channel);
            this.channels.push(event.channel);
            this.callbacks.onChannel(event.channel, this.channels.length - 1);
        };

        // Browser sleep detection
        this._startSleepDetection();
    }

    // ── Channels ───────────────────────────────────────────────

    /**
     * Create negotiated data channels (both sides call this with the same count).
     * @param {Function} onChannelReady - called with (channel, index) when each channel opens
     * @param {number} [count] - channels to create (default MAX_CHANNELS; secondary
     *        peer connections use fewer — see SECONDARY_PC_CHANNELS)
     */
    createChannels(onChannelReady, count = MAX_CHANNELS) {
        for (let i = 0; i < count; i++) {
            const channel = this.pc.createDataChannel(`transfer-${i}`, {
                ...CHANNEL_CONFIG,
                id: i,
                negotiated: true,
            });
            this._configureChannel(channel);
            this.channels.push(channel);

            channel.onopen = () => {
                onChannelReady(channel, i);
            };
        }
    }

    // ── SDP ────────────────────────────────────────────────────

    /**
     * Create an SDP offer.
     * @param {{ iceRestart?: boolean }} [options]
     * @returns {Promise<RTCSessionDescriptionInit>}
     */
    async createOffer(options = {}) {
        const offer = await this.pc.createOffer(options);
        await this.pc.setLocalDescription(offer);
        return this.pc.localDescription.toJSON();
    }

    /**
     * Create an SDP answer.
     * @returns {Promise<RTCSessionDescriptionInit>}
     */
    async createAnswer() {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return this.pc.localDescription.toJSON();
    }

    /**
     * Set the remote SDP.
     * @param {RTCSessionDescriptionInit} sdp
     */
    async setRemoteDescription(sdp) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }

    /**
     * Add an ICE candidate.
     * @param {RTCIceCandidateInit} candidate
     */
    async addIceCandidate(candidate) {
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn('[PeerConnection] Failed to add ICE candidate:', err);
        }
    }

    // ── ICE Restart ────────────────────────────────────────────

    /**
     * Trigger an ICE restart to recover a degraded connection.
     * Creates a new offer with iceRestart: true and notifies the caller.
     * @returns {Promise<RTCSessionDescriptionInit>}
     */
    async restartIce() {
        if (!this.pc) throw new Error('No peer connection');
        const restartOffer = await this.createOffer({ iceRestart: true });
        if (this.callbacks.onIceRestartRequired) {
            this.callbacks.onIceRestartRequired(restartOffer);
        }
        return restartOffer;
    }

    /** Fire an ICE restart at most once at a time; recovery to 'connected' clears the guard. */
    _tryIceRestart() {
        if (this._iceRestarting) return;
        this._iceRestarting = true;
        this.restartIce()
            .catch((err) => console.error('[PeerConnection] ICE restart failed:', err))
            .finally(() => { this._iceRestarting = false; });
    }

    _clearIceRestartTimer() {
        if (this._iceRestartTimer) {
            clearTimeout(this._iceRestartTimer);
            this._iceRestartTimer = null;
        }
    }

    // ── Stats ──────────────────────────────────────────────────

    /**
     * Get connection statistics.
     *
     * `transport` reflects how the P2P connection is actually routed, derived from
     * the selected ICE candidate pair:
     *   - 'direct'  — host/srflx candidates (true peer-to-peer, no relay)
     *   - 'turn'    — at least one 'relay' candidate (data flows through a TURN server,
     *                 still DTLS-encrypted end-to-end so the TURN server sees only ciphertext)
     *   - null      — not yet established
     *
     * @returns {Promise<{ rtt: number|null, bytesReceived: number, bytesSent: number, transport: 'direct'|'turn'|null } | null>}
     */
    async getStats() {
        if (!this.pc) return null;
        const stats = await this.pc.getStats();
        let rtt = null;
        let bytesReceived = 0;
        let bytesSent = 0;

        // Resolve the selected candidate pair → candidate types to detect TURN relaying.
        const candidates = new Map();
        let selectedPair = null;

        stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                rtt = report.currentRoundTripTime;
                // `selected` (Firefox) or `nominated` (Chrome) marks the active pair.
                if (report.selected || report.nominated) selectedPair = report;
            }
            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                candidates.set(report.id, report.candidateType);
            }
            if (report.type === 'data-channel') {
                bytesReceived += report.bytesReceived || 0;
                bytesSent += report.bytesSent || 0;
            }
        });

        let transport = null;
        if (selectedPair) {
            const localType = candidates.get(selectedPair.localCandidateId);
            const remoteType = candidates.get(selectedPair.remoteCandidateId);
            transport = (localType === 'relay' || remoteType === 'relay') ? 'turn' : 'direct';
        }

        return { rtt, bytesReceived, bytesSent, transport };
    }

    // ── Cleanup ────────────────────────────────────────────────

    /**
     * Close the connection and all channels.
     */
    close() {
        this._stopSleepDetection();
        this._clearIceRestartTimer();

        for (const ch of this.channels) {
            try { ch.close(); } catch { /* ignore */ }
        }
        this.channels = [];

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
    }

    // ── Private ────────────────────────────────────────────────

    _configureChannel(channel) {
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    }

    /**
     * Start browser sleep/wake detection.
     * Uses visibilitychange (tab hidden/shown) and the freeze event (Chrome).
     * On wake, triggers an ICE restart if the connection is degraded.
     */
    _startSleepDetection() {
        this._lastSeen = Date.now();

        // Heartbeat — if the gap between ticks is > 10s, the tab was suspended
        this._sleepDetector = setInterval(() => {
            const now = Date.now();
            const gap = now - this._lastSeen;
            this._lastSeen = now;

            if (gap > 10_000 && this.pc?.connectionState === 'disconnected') {
                console.warn('[PeerConnection] Browser wake detected — attempting ICE restart');
                this.restartIce().catch(() => { /* handled by onConnectionStateChange */ });
            }
        }, 2000);

        // Listen for visibility changes (tab switching)
        if (typeof document !== 'undefined') {
            this._onVisibilityChange = () => {
                if (!document.hidden && this.pc?.connectionState === 'disconnected') {
                    console.warn('[PeerConnection] Tab resumed — attempting ICE restart');
                    this.restartIce().catch(() => { /* noop */ });
                }
            };
            document.addEventListener('visibilitychange', this._onVisibilityChange);

            // Chrome freeze/resume lifecycle events
            this._onResume = () => {
                this.restartIce().catch(() => { /* noop */ });
            };
            document.addEventListener('resume', this._onResume);
        }
    }

    _stopSleepDetection() {
        if (this._sleepDetector) {
            clearInterval(this._sleepDetector);
            this._sleepDetector = null;
        }
        if (typeof document !== 'undefined') {
            if (this._onVisibilityChange) {
                document.removeEventListener('visibilitychange', this._onVisibilityChange);
            }
            if (this._onResume) {
                document.removeEventListener('resume', this._onResume);
            }
        }
    }
}
