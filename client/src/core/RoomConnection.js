/**
 * RoomConnection — manages the WebRTC mesh for an N-peer room.
 *
 * It keeps one PeerConnection per *other* member (reusing the existing PeerConnection /
 * ChannelManager / CryptoEngine building blocks) and drives the targeted N-peer signaling
 * (offer/answer/ice carry a `to` peer id, routed by the server's RoomManager). Glare is
 * avoided deterministically: of any two peers, the one with the lexicographically smaller
 * id is the offerer.
 *
 * For the SWARM topology, file bytes are pulled across these peer connections by
 * SwarmScheduler; RoomConnection only owns connectivity + the per-peer data channel and the
 * room-key distribution (the owner generates one symmetric room key and wraps it to each
 * authenticated peer, so a chunk received from any peer — not just the origin — decrypts).
 *
 * Transport is injected (`send` for signaling, `createPeer` for the PeerConnection factory)
 * so the connection/roster choreography is unit-testable without real WebRTC.
 */
import { SWARM_MSG } from '@shared/constants.js';

export class RoomConnection {
    /**
     * @param {object} opts
     * @param {string} opts.selfId               this peer's id (from ROOM_CREATED)
     * @param {string} opts.token                room member token (attached to signaling)
     * @param {(msg: object) => void} opts.send   send a signaling message to the server
     * @param {(remoteId: string, o: { initiator: boolean }) => object} opts.createPeer
     *        Factory returning a PeerConnection-like object.
     * @param {(remoteId: string, channel: object) => void} [opts.onPeerChannelOpen]
     * @param {(remoteId: string, state: string) => void} [opts.onPeerStateChange]
     * @param {(peers: object[], topology: string) => void} [opts.onRoster]
     */
    constructor({ selfId, token, send, createPeer, onPeerChannelOpen, onPeerStateChange, onRoster }) {
        this.selfId = selfId;
        this.token = token;
        this._send = send;
        this._createPeer = createPeer;
        this._onPeerChannelOpen = onPeerChannelOpen || (() => {});
        this._onPeerStateChange = onPeerStateChange || (() => {});
        this._onRoster = onRoster || (() => {});

        /** @type {Map<string, object>} remoteId → PeerConnection */
        this.peers = new Map();
        this.topology = 'direct';
        this.roster = [];
    }

    /** Should `this` peer be the offerer toward `remoteId`? (deterministic glare avoidance) */
    _isInitiator(remoteId) {
        return this.selfId < remoteId;
    }

    /** Handle a ROOM_ROSTER update: connect to any new members we should initiate toward. */
    handleRoster({ peers = [], topology }) {
        this.roster = peers;
        if (topology) this.topology = topology;
        for (const { peerId } of peers) {
            if (peerId === this.selfId) continue;
            if (!this.peers.has(peerId) && this._isInitiator(peerId)) {
                this._connect(peerId, true);
            }
        }
        // Drop connections to peers no longer present.
        const present = new Set(peers.map((p) => p.peerId));
        for (const id of [...this.peers.keys()]) {
            if (!present.has(id)) this.handlePeerLeft({ peerId: id });
        }
        this._onRoster(peers, this.topology);
    }

    handlePeerLeft({ peerId }) {
        const peer = this.peers.get(peerId);
        if (peer) { try { peer.close(); } catch { /* ignore */ } this.peers.delete(peerId); }
    }

    /** Incoming targeted signaling from another peer (server set `from`). */
    async handleSignal({ type, from, payload }) {
        if (!from) return;
        if (type === 'offer') {
            const peer = this._connect(from, false);
            await peer.setRemoteDescription(payload);
            const answer = await peer.createAnswer();
            this._signal('answer', from, answer);
        } else if (type === 'answer') {
            await this.peers.get(from)?.setRemoteDescription(payload);
        } else if (type === 'ice-candidate') {
            await this.peers.get(from)?.addIceCandidate(payload);
        }
    }

    /** Create (or fetch) the PeerConnection toward a remote peer and wire its callbacks. */
    _connect(remoteId, initiator) {
        let peer = this.peers.get(remoteId);
        if (peer) return peer;

        peer = this._createPeer(remoteId, { initiator });
        this.peers.set(remoteId, peer);

        // The factory is expected to expose the PeerConnection callback surface. We pass our
        // own handlers via the factory; here we additionally drive offer creation if initiator.
        if (initiator) {
            Promise.resolve()
                .then(() => peer.createOffer())
                .then((offer) => this._signal('offer', remoteId, offer))
                .catch((err) => console.error('[RoomConnection] offer failed:', err));
        }
        return peer;
    }

    _signal(type, to, payload) {
        this._send({ type, to, token: this.token, payload });
    }

    // ── Swarm coordination passthroughs (server tracks availability) ──
    announce(fileId, totalChunks, origin = false) {
        this._send({ type: SWARM_MSG.ANNOUNCE, token: this.token, fileId, totalChunks, origin });
    }
    haveChunks(fileId, indices) {
        this._send({ type: SWARM_MSG.HAVE, token: this.token, fileId, indices });
    }
    needChunk(fileId, index) {
        this._send({ type: SWARM_MSG.NEED, token: this.token, fileId, index });
    }

    /** Number of currently-tracked peer connections. */
    get peerCount() { return this.peers.size; }

    close() {
        for (const peer of this.peers.values()) { try { peer.close(); } catch { /* ignore */ } }
        this.peers.clear();
    }
}
