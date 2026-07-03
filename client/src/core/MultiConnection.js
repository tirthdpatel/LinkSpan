import { EXTRA_PEER_CONNECTIONS, SECONDARY_PC_CHANNELS } from '@shared/constants.js';
import { PeerConnection } from './PeerConnection.js';

/**
 * MultiConnection — secondary RTCPeerConnections for multi-connection striping.
 *
 * All data channels on one RTCPeerConnection share a single SCTP association and
 * therefore ONE congestion window, so on high-RTT paths the primary connection caps
 * throughput regardless of channel count. Each secondary connection opened here gets
 * its own congestion window; its channels are appended to the shared ChannelManager,
 * where the existing lowest-bufferedAmount channel picking stripes chunks across every
 * association automatically (the sender keeps each chunk's meta+binary pair on one
 * channel, so pairing survives striping).
 *
 * Signaling: secondaries are multiplexed over the SAME session by carrying a
 * `pcIndex` (1-based) field INSIDE the SDP/ICE payloads. The signaling server relays
 * payloads opaquely and its validators ignore extra fields, so no server changes are
 * needed. Compatibility is negotiated in-band: the receiver advertises support by
 * echoing `multiConn: <n>` in its answer payload; the sender opens secondaries only
 * after seeing it. Old peers never see a pcIndex-tagged message.
 *
 * Secondaries are strictly opportunistic: a secondary that fails to connect (or dies
 * mid-transfer) only removes capacity — the transfer continues on the remaining
 * connections, and in-flight chunks are recovered by the receiver's stall/re-request
 * logic. Nothing here touches transfer state or triggers relay fallback.
 */
export class MultiConnection {
    /**
     * @param {object} opts
     * @param {import('./SignalingClient.js').SignalingClient} opts.signaling
     * @param {import('./ChannelManager.js').ChannelManager} opts.channelManager
     * @param {RTCIceServer[]} [opts.iceServers]
     */
    constructor({ signaling, channelManager, iceServers }) {
        this._signaling = signaling;
        this._channelManager = channelManager;
        this._iceServers = iceServers;
        /** @type {Map<number, PeerConnection>} pcIndex → secondary connection */
        this._pcs = new Map();
        /** @type {Map<number, RTCIceCandidateInit[]>} candidates that arrived early */
        this._pendingCandidates = new Map();
        this._closed = false;
    }

    /** How many secondaries to open given what the remote advertised. */
    static negotiatedCount(remoteAdvertised) {
        const n = Number.isInteger(remoteAdvertised) ? remoteAdvertised : 0;
        return Math.max(0, Math.min(n, EXTRA_PEER_CONNECTIONS));
    }

    /** Is this SDP/ICE payload addressed to a secondary connection? */
    static isSecondaryPayload(payload) {
        return payload != null && typeof payload === 'object' && payload.pcIndex != null;
    }

    /**
     * Sender side: open `count` secondary connections and send a pcIndex-tagged offer
     * for each. Failures are logged and skipped — the transfer already runs on the
     * primary.
     * @param {number} count
     */
    async openSecondaries(count) {
        for (let pcIndex = 1; pcIndex <= count; pcIndex++) {
            if (this._closed || this._pcs.has(pcIndex)) continue;
            try {
                const peer = this._createPeer(pcIndex);
                const offer = await peer.createOffer();
                this._signaling.sendOffer({ ...offer, pcIndex });
            } catch (err) {
                console.warn(`[MultiConnection] Failed to open secondary ${pcIndex}:`, err.message);
            }
        }
    }

    /**
     * Receiver side: an offer arrived for a secondary (initial negotiation, or an ICE
     * restart re-offer for one that already exists).
     * @param {{ type: 'offer', sdp: string, pcIndex: number }} payload
     */
    async handleOffer(payload) {
        const pcIndex = payload.pcIndex;
        if (this._closed || !this._validIndex(pcIndex)) return;
        try {
            let peer = this._pcs.get(pcIndex);
            if (!peer) peer = this._createPeer(pcIndex);
            await peer.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            await this._flushCandidates(pcIndex, peer);
            const answer = await peer.createAnswer();
            this._signaling.sendAnswer({ ...answer, pcIndex });
        } catch (err) {
            console.warn(`[MultiConnection] Secondary ${pcIndex} offer handling failed:`, err.message);
        }
    }

    /**
     * Sender side: the answer for a secondary arrived.
     * @param {{ type: 'answer', sdp: string, pcIndex: number }} payload
     */
    async handleAnswer(payload) {
        const peer = this._pcs.get(payload.pcIndex);
        if (this._closed || !peer) return;
        try {
            await peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
            await this._flushCandidates(payload.pcIndex, peer);
        } catch (err) {
            console.warn(`[MultiConnection] Secondary ${payload.pcIndex} answer failed:`, err.message);
        }
    }

    /**
     * Either side: an ICE candidate tagged for a secondary. Buffered until the
     * connection exists and has a remote description (trickle candidates can beat
     * the SDP over the relay).
     * @param {RTCIceCandidateInit & { pcIndex: number }} payload
     */
    async handleCandidate(payload) {
        const { pcIndex, ...candidate } = payload;
        if (this._closed || !this._validIndex(pcIndex)) return;
        const peer = this._pcs.get(pcIndex);
        if (!peer || !peer.pc?.remoteDescription) {
            const queue = this._pendingCandidates.get(pcIndex) || [];
            queue.push(candidate);
            this._pendingCandidates.set(pcIndex, queue);
            return;
        }
        await peer.addIceCandidate(candidate);
    }

    /** Close every secondary connection. Idempotent. */
    close() {
        this._closed = true;
        for (const peer of this._pcs.values()) {
            try { peer.close(); } catch { /* noop */ }
        }
        this._pcs.clear();
        this._pendingCandidates.clear();
    }

    // ── Private ────────────────────────────────────────────────

    _validIndex(pcIndex) {
        return Number.isInteger(pcIndex) && pcIndex >= 1 && pcIndex <= EXTRA_PEER_CONNECTIONS;
    }

    _createPeer(pcIndex) {
        const peer = new PeerConnection({
            onIceCandidate: (candidate) => this._signaling.sendIceCandidate({ ...candidate, pcIndex }),
            onChannel: () => { /* negotiated channels never fire ondatachannel */ },
            onConnectionStateChange: () => { /* opportunistic — no state transitions */ },
            // PeerConnection auto-restarts ICE on 'failed'; route the restart offer
            // back through signaling with our tag so the peer renegotiates this PC.
            onIceRestartRequired: (offer) => this._signaling.sendOffer({ ...offer, pcIndex }),
        }, this._iceServers);
        peer.init();
        // Negotiated channels: both sides create the same count with matching ids.
        peer.createChannels(() => {}, SECONDARY_PC_CHANNELS);
        this._channelManager.addChannels(peer.channels);
        this._pcs.set(pcIndex, peer);
        return peer;
    }

    async _flushCandidates(pcIndex, peer) {
        const queued = this._pendingCandidates.get(pcIndex);
        if (!queued) return;
        this._pendingCandidates.delete(pcIndex);
        for (const candidate of queued) {
            await peer.addIceCandidate(candidate);
        }
    }
}
