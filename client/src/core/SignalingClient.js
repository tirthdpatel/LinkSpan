import {
    MSG,
    ERR,
} from '@shared/constants.js';

/**
 * SignalingClient — WebSocket connection to the LinkSpan signaling server.
 * Handles session creation, joining, and WebRTC signal relay.
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
        this._maxReconnectAttempts = 5;
        this._reconnectDelay = 1000;
        this._shouldReconnect = true;
    }

    /**
     * Connect to the signaling server.
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.serverUrl);

                this.ws.onopen = () => {
                    this._reconnectAttempts = 0;
                    this._emit('connected');
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleMessage(data);
                    } catch {
                        console.error('[SignalingClient] Invalid message received');
                    }
                };

                this.ws.onclose = () => {
                    this._emit('disconnected');
                    if (this._shouldReconnect) {
                        this._attemptReconnect();
                    }
                };

                this.ws.onerror = (err) => {
                    this._emit('error', err);
                    reject(err);
                };
            } catch (err) {
                reject(err);
            }
        });
    }

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

    /**
     * Send an SDP offer.
     * @param {RTCSessionDescriptionInit} offer
     */
    sendOffer(offer) {
        this._send({ type: MSG.OFFER, payload: offer });
    }

    /**
     * Send an SDP answer.
     * @param {RTCSessionDescriptionInit} answer
     */
    sendAnswer(answer) {
        this._send({ type: MSG.ANSWER, payload: answer });
    }

    /**
     * Send an ICE candidate.
     * @param {RTCIceCandidateInit} candidate
     */
    sendIceCandidate(candidate) {
        this._send({ type: MSG.ICE_CANDIDATE, payload: candidate });
    }

    /**
     * Disconnect from the server.
     */
    disconnect() {
        this._shouldReconnect = false;
        if (this.ws) {
            this._send({ type: MSG.DISCONNECT });
            this.ws.close();
            this.ws = null;
        }
    }

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

    // ── Private Methods ────────────────────────────────────────

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _handleMessage(data) {
        switch (data.type) {
            case MSG.SESSION_CREATED:
                this._emit('session-created', data);
                break;
            case MSG.PEER_JOINED:
                this._emit('peer-joined', data);
                break;
            case MSG.OFFER:
                this._emit('offer', data.payload);
                break;
            case MSG.ANSWER:
                this._emit('answer', data.payload);
                break;
            case MSG.ICE_CANDIDATE:
                this._emit('ice-candidate', data.payload);
                break;
            case MSG.SESSION_ERROR:
                this._emit('error', data.error);
                break;
            case MSG.SESSION_CLOSED:
                this._emit('session-closed', data);
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

    _attemptReconnect() {
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            this._emit('reconnect-failed');
            return;
        }

        this._reconnectAttempts++;
        const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);

        setTimeout(() => {
            this._emit('reconnecting', this._reconnectAttempts);
            this.connect().catch(() => {
                // Will trigger onclose → _attemptReconnect
            });
        }, delay);
    }
}
