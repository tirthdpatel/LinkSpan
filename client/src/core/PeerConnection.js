import {
    MAX_CHANNELS,
    CHANNEL_CONFIG,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
} from '@shared/constants.js';

/**
 * PeerConnection — Wraps RTCPeerConnection with ICE config and multi-channel setup.
 */
export class PeerConnection {
    /**
     * @param {{ onIceCandidate: Function, onChannel: Function, onConnectionStateChange: Function }} callbacks
     */
    constructor(callbacks) {
        this.callbacks = callbacks;
        /** @type {RTCPeerConnection | null} */
        this.pc = null;
        /** @type {RTCDataChannel[]} */
        this.channels = [];
        this._iceServers = this._getIceServers();
    }

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
            this.callbacks.onConnectionStateChange(this.pc.connectionState);
        };

        this.pc.ondatachannel = (event) => {
            this._configureChannel(event.channel);
            this.channels.push(event.channel);
            this.callbacks.onChannel(event.channel, this.channels.length - 1);
        };
    }

    /**
     * Create 7 data channels (sender-side).
     * @param {Function} onChannelReady - called with (channel, index) when each channel opens
     */
    createChannels(onChannelReady) {
        for (let i = 0; i < MAX_CHANNELS; i++) {
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

    /**
     * Create an SDP offer.
     * @returns {Promise<RTCSessionDescriptionInit>}
     */
    async createOffer() {
        const offer = await this.pc.createOffer();
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

    /**
     * Get connection statistics.
     */
    async getStats() {
        if (!this.pc) return null;
        const stats = await this.pc.getStats();
        let rtt = null;
        let bytesReceived = 0;
        let bytesSent = 0;

        stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                rtt = report.currentRoundTripTime;
            }
            if (report.type === 'data-channel') {
                bytesReceived += report.bytesReceived || 0;
                bytesSent += report.bytesSent || 0;
            }
        });

        return { rtt, bytesReceived, bytesSent };
    }

    /**
     * Close the connection.
     */
    close() {
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

    _getIceServers() {
        const servers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];

        // Add Metered TURN servers if configured
        const turnDomain = import.meta.env.VITE_TURN_DOMAIN || 'global.relay.metered.ca';
        const turnUser = import.meta.env.VITE_TURN_USERNAME;
        const turnCred = import.meta.env.VITE_TURN_CREDENTIAL;

        if (turnUser && turnCred) {
            servers.push(
                { urls: `turn:${turnDomain}:80`, username: turnUser, credential: turnCred },
                { urls: `turn:${turnDomain}:443`, username: turnUser, credential: turnCred },
                { urls: `turns:${turnDomain}:443`, username: turnUser, credential: turnCred }
            );
        }

        return servers;
    }
}
