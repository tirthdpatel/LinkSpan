import {
    MSG,
    SWARM_MSG,
} from '@shared/constants.js';

/**
 * SignalingClient — WebSocket connection to the LinkSpan signaling server.
 *
 * Token round-trip:
 *   1. Server issues a signed HMAC token in SESSION_CREATED response.
 *   2. Client stores it in this._sessionToken.
 *   3. Client includes the token in every privileged message:
 *      OFFER, ANSWER, ICE_CANDIDATE, RELAY_REQUEST, RELAY_CHUNK.
 *   4. Server verifies the token before relaying each privileged message.
 *
 * Without this round-trip, any peer that knows a sessionId (or guesses one)
 * could inject offer/answer/ICE messages into sessions they don't belong to.
 */
export class SignalingClient {
    /**
     * @param {string} serverUrl - WebSocket URL of the signaling server
     */
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        /** @type {WebSocket | null} */
        this.ws = null;
        this.handlers = {};
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 7;
        this._baseDelay = 1000;
        this._shouldReconnect = true;
        /** @type {string | null} HMAC-signed session token — preserved across reconnects */
        this._sessionToken = null;
        /** @type {string | null} session ID — preserved for re-join */
        this._sessionId = null;
    }

    // ── Connection ─────────────────────────────────────────────

    /**
     * Connect to the signaling server.
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.serverUrl);

                this.ws.onopen = () => {
                    // Reset reconnect counter only after successful open
                    const wasReconnect = this._reconnectAttempts > 0;
                    this._reconnectAttempts = 0;
                    if (wasReconnect) {
                        this._emit('reconnected');
                    }
                    this._emit('connected');
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleMessage(data);
                    } catch {
                        console.error('[SignalingClient] Failed to parse message');
                    }
                };

                this.ws.onclose = () => {
                    this._emit('disconnected');
                    if (this._shouldReconnect) {
                        this._attemptReconnect();
                    }
                };

                this.ws.onerror = (err) => {
                    this._emit('error', { message: 'WebSocket connection error' });
                    reject(err);
                };
            } catch (err) {
                reject(err);
            }
        });
    }

    // ── Session ────────────────────────────────────────────────

    /**
     * Create a new session.
     */
    createSession() {
        this._send({ type: MSG.CREATE_SESSION });
    }

    /**
     * Join a session with a pairing code.
     * @param {string} pairingCode
     */
    joinSession(pairingCode) {
        this._send({ type: MSG.JOIN_SESSION, pairingCode });
    }

    // ── SDP / ICE — all include session token ──────────────────

    /**
     * Send an SDP offer.
     * Token is included so the server can verify this peer's identity before relaying.
     * @param {RTCSessionDescriptionInit} offer
     */
    sendOffer(offer) {
        this._sendPrivileged({ type: MSG.OFFER, payload: offer });
    }

    /**
     * Send an SDP answer.
     * @param {RTCSessionDescriptionInit} answer
     */
    sendAnswer(answer) {
        this._sendPrivileged({ type: MSG.ANSWER, payload: answer });
    }

    /**
     * Send an ICE candidate.
     * @param {RTCIceCandidateInit} candidate
     */
    sendIceCandidate(candidate) {
        this._sendPrivileged({ type: MSG.ICE_CANDIDATE, payload: candidate });
    }

    /**
     * Request an ICE restart.
     * @param {RTCSessionDescriptionInit} restartOffer - offer with iceRestart: true
     */
    sendIceRestartOffer(restartOffer) {
        this._sendPrivileged({ type: MSG.OFFER, payload: restartOffer, iceRestart: true });
    }

    // ── Relay ──────────────────────────────────────────────────

    /**
     * Request the server to activate relay mode for this session.
     * Token is required — relay activation is a privileged operation.
     */
    sendRelayRequest() {
        this._sendPrivileged({ type: MSG.RELAY_REQUEST });
    }

    /**
     * Send a relay chunk through the signaling WebSocket.
     *
     * Text control messages use the `payload` field.
     * Binary chunks are base64-encoded by RelayChannel and arrive here as a
     * string in `b64Payload`. The server forwards the full JSON to the peer,
     * where RelayChannel._startListening decodes msg.b64 back to ArrayBuffer.
     *
     * @param {number} channelIndex
     * @param {string | null} payload   - text payload (isText=true) OR base64 string (isText=false)
     * @param {boolean} isText
     * @param {number} [size]           - original byte length (informational)
     */
    sendRelayChunk(channelIndex, payload, isText, size) {
        this._sendPrivileged({
            type: MSG.RELAY_CHUNK,
            channelIndex,
            isText,
            ...(isText  ? { payload } : { b64: payload, size }),
        });
    }

    // ── Lifecycle ──────────────────────────────────────────────

    /**
     * Disconnect intentionally — suppress automatic reconnect.
     */
    disconnect() {
        this._shouldReconnect = false;
        if (this.ws) {
            this._send({ type: MSG.DISCONNECT });
            this.ws.close();
            this.ws = null;
        }
    }

    // ── Group rooms (N-peer) ───────────────────────────────────
    /** Create a room; the server replies with ROOM_CREATED (roomId, joinCode, token). */
    createRoom(name) {
        this._send({ type: MSG.CREATE_ROOM, ...(name ? { name } : {}) });
    }

    /** Join a room by its 6-digit code. */
    joinRoom(joinCode, name) {
        this._send({ type: MSG.JOIN_ROOM, joinCode, ...(name ? { name } : {}) });
    }

    /** Leave the current room. */
    leaveRoom() {
        this._send({ type: MSG.LEAVE_ROOM });
    }

    /** Send a raw room/swarm message (token is included by the caller, e.g. RoomConnection). */
    sendRoom(msg) {
        this._send(msg);
    }

    /** The room member token from ROOM_CREATED (null until in a room). */
    getRoomToken() {
        return this._roomToken || null;
    }

    // ── Events ─────────────────────────────────────────────────

    /**
     * Register an event handler.
     * @param {string} event
     * @param {Function} handler
     */
    on(event, handler) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(handler);
    }

    /**
     * Remove an event handler.
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        if (this.handlers[event]) {
            this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
        }
    }

    /**
     * Get the stored session token (for use by RelayChannel).
     * @returns {string | null}
     */
    getToken() {
        return this._sessionToken;
    }

    /**
     * Get the stored session ID.
     * @returns {string | null}
     */
    getSessionId() {
        return this._sessionId;
    }

    /**
     * Get the raw WebSocket (for use by RelayChannel).
     * @returns {WebSocket | null}
     */
    getWebSocket() {
        return this.ws;
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Send a regular (non-privileged) message.
     */
    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    /**
     * Send a privileged message with the HMAC session token attached.
     * The server will verify this token before relaying the message.
     *
     * If no token is stored yet (e.g. session not created), the message
     * is sent without a token — the server will reject it with UNAUTHORIZED.
     * This is intentional: privileged actions before session creation are invalid.
     */
    _sendPrivileged(data) {
        if (!this._sessionToken) {
            console.warn('[SignalingClient] Sending privileged message without a session token:', data.type);
        }
        this._send({ ...data, token: this._sessionToken });
    }

    _handleMessage(data) {
        switch (data.type) {
            case MSG.SESSION_CREATED:
                // Store token and session ID — preserved across reconnects
                // These are echoed back on every privileged outbound message
                if (data.token) this._sessionToken = data.token;
                if (data.sessionId) this._sessionId = data.sessionId;
                this._emit('session-created', data);
                break;
            case MSG.PEER_JOINED:
                this._emit('peer-joined', data);
                break;
            case MSG.OFFER:
                // N-peer room signaling carries `from`; 2-peer session signaling does not.
                if (data.from) this._emit('room-signal', { ...data, type: 'offer' });
                else this._emit('offer', data.payload);
                break;
            case MSG.ANSWER:
                if (data.from) this._emit('room-signal', { ...data, type: 'answer' });
                else this._emit('answer', data.payload);
                break;
            case MSG.ICE_CANDIDATE:
                if (data.from) this._emit('room-signal', { ...data, type: 'ice-candidate' });
                else this._emit('ice-candidate', data.payload);
                break;
            case MSG.ROOM_CREATED:
                if (data.token) this._roomToken = data.token;
                this._emit('room-created', data);
                break;
            case MSG.ROOM_ROSTER:
                this._emit('room-roster', data);
                break;
            case MSG.ROOM_PEER_JOINED:
                this._emit('room-peer-joined', data);
                break;
            case MSG.ROOM_PEER_LEFT:
                this._emit('room-peer-left', data);
                break;
            case SWARM_MSG.ANNOUNCE:
            case SWARM_MSG.HAVE:
            case SWARM_MSG.PEERS:
                this._emit(data.type, data);
                break;
            case MSG.SESSION_ERROR:
                this._emit('error', data.error);
                break;
            case MSG.SESSION_CLOSED:
                this._emit('session-closed', data);
                break;
            case MSG.RELAY_READY:
                this._emit('relay-ready', data);
                break;
            case MSG.RELAY_CHUNK:
                this._emit('relay-chunk', data);
                break;
            default:
                console.warn('[SignalingClient] Unknown message type:', data.type);
        }
    }

    _emit(event, ...args) {
        const handlers = this.handlers[event];
        if (handlers) {
            handlers.forEach((h) => h(...args));
        }
    }

    /**
     * Attempt reconnect with exponential backoff + jitter.
     * Jitter prevents thundering herd when the server restarts.
     */
    _attemptReconnect() {
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            this._emit('reconnect-failed');
            return;
        }

        this._reconnectAttempts++;
        const exponential = this._baseDelay * Math.pow(2, this._reconnectAttempts - 1);
        const jitter = Math.random() * 1000;
        const delay = Math.min(exponential + jitter, 30_000);

        setTimeout(() => {
            this._emit('reconnecting', this._reconnectAttempts);
            this.connect().catch(() => {
                // onclose → _attemptReconnect chain continues naturally
            });
        }, delay);
    }
}
