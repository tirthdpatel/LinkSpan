import { MSG, SEND_HIGH_WATER_MARK } from '@shared/constants.js';

/**
 * RelayChannel — Drop-in replacement for ChannelManager when WebRTC is unavailable.
 *
 * Implements the same interface as ChannelManager:
 *   - send(channelIndex, data)
 *   - sendAny(data)
 *   - onMessage(handler)
 *   - onFirstMessage(handler) / offFirstMessage()
 *   - isConnected()
 *   - getReadyCount()
 *   - getChannelStats()
 *   - resetStats()
 *   - closeAll()
 *
 * Data is tunneled through the SignalingClient WebSocket using MSG.RELAY_CHUNK messages.
 * The server forwards chunks to the other peer.
 *
 * Protocol:
 *   All frames — both text control messages and binary chunk data — are sent as JSON
 *   through the normal SignalingClient._sendPrivileged() path.
 *
 *   Binary ArrayBuffers are base64-encoded and embedded in the JSON payload as:
 *     { type: 'relay-chunk', channelIndex, isText: false, b64: '<base64>', size: <bytes> }
 *
 *   Text control messages are sent as:
 *     { type: 'relay-chunk', channelIndex, isText: true, payload: '<string>' }
 *
 *   This avoids the two-frame race condition where a JSON metadata header and a
 *   subsequent raw binary WebSocket frame race against each other and may be
 *   interleaved with signaling messages, corrupting the relay stream.
 *
 * Token round-trip: every relay chunk includes the session token (via _sendPrivileged),
 * which the server validates before forwarding. This prevents relay injection attacks.
 */
export class RelayChannel {
    /**
     * @param {import('./SignalingClient.js').SignalingClient} signalingClient
     */
    constructor(signalingClient) {
        this._signaling = signalingClient;
        this._onMessage = null;
        this._onFirstMessage = null;
        this._connected = false;
        this._stats = { bytes: 0, timestamp: Date.now() };
        /** @type {(() => void) | null} */
        this._removeChunkListener = null;
    }

    // ── Lifecycle ──────────────────────────────────────────────

    /**
     * Activate relay mode — request server to enable relay for this session.
     * The server responds with MSG.RELAY_READY, which resolves this promise.
     * @returns {Promise<void>}
     */
    activate() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('[RelayChannel] Relay activation timeout (5s)'));
            }, 5000);

            const onRelayReady = () => {
                clearTimeout(timeout);
                cleanup();
                this._connected = true;
                this._startListening();
                resolve();
            };

            const onError = (err) => {
                clearTimeout(timeout);
                cleanup();
                reject(new Error(err?.message || 'Relay activation failed'));
            };

            const cleanup = () => {
                this._signaling.off('relay-ready', onRelayReady);
                this._signaling.off('error', onError);
            };

            this._signaling.on('relay-ready', onRelayReady);
            this._signaling.on('error', onError);

            // Send relay request — includes HMAC token via _sendPrivileged
            this._signaling.sendRelayRequest();
        });
    }

    // ── ChannelManager-compatible API ──────────────────────────

    /**
     * Send data on a specific (virtual) channel.
     *
     * Binary ArrayBuffers are base64-encoded and sent as JSON — this keeps all
     * relay traffic in the normal signaling message path with full token
     * validation, and avoids the two-frame race condition of the previous design.
     *
     * @param {number} channelIndex
     * @param {ArrayBuffer | string} data
     * @returns {Promise<void>}
     */
    async send(channelIndex, data) {
        if (!this._connected) throw new Error('RelayChannel not connected');

        // Backpressure: the relay path has no per-channel drain event, so gate on the
        // WebSocket's own send buffer. With the larger receiver pull-window a burst of
        // chunks would otherwise pile base64 frames into ws.bufferedAmount unbounded;
        // yield until the socket has drained below the high-water mark before queuing
        // more. Binary frames are ~33% larger once base64-encoded, which this accounts
        // for naturally by measuring the actual buffered bytes.
        await this._awaitWsDrain();

        if (typeof data === 'string') {
            // Text control message (FILE_META, CHUNK_REQUEST, etc.)
            this._signaling.sendRelayChunk(channelIndex, data, true);
            this._stats.bytes += data.length;
        } else {
            // Binary chunk — base64-encode into JSON payload
            const b64 = _arrayBufferToBase64(data);
            this._signaling.sendRelayChunk(channelIndex, b64, false, data.byteLength);
            this._stats.bytes += data.byteLength;
        }
    }

    /**
     * Resolve once the WebSocket send buffer has drained below the high-water mark.
     * The browser WebSocket has no drain event, so poll bufferedAmount on a short
     * timer. Bails immediately if the socket is missing or no longer open so a send
     * never hangs on a dead connection (the caller's send will then throw/no-op).
     * @returns {Promise<void>}
     */
    _awaitWsDrain() {
        const ws = this._signaling.getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
        if (ws.bufferedAmount <= SEND_HIGH_WATER_MARK) return Promise.resolve();
        return new Promise((resolve) => {
            const poll = setInterval(() => {
                const sock = this._signaling.getWebSocket();
                if (!sock || sock.readyState !== WebSocket.OPEN ||
                    sock.bufferedAmount <= SEND_HIGH_WATER_MARK) {
                    clearInterval(poll);
                    resolve();
                }
            }, 20);
        });
    }

    /**
     * Send data on any available (virtual) channel.
     * @param {ArrayBuffer | string} data
     * @returns {Promise<number>} channel index used (always 0 for relay)
     */
    async sendAny(data) {
        await this.send(0, data);
        return 0;
    }

    /**
     * Set the primary message handler.
     * @param {Function} handler - (data, channelIndex) => void
     */
    onMessage(handler) {
        this._onMessage = handler;
    }

    /**
     * Register a one-time interceptor (used by useConnection for FILE_META detection).
     * @param {Function} handler
     */
    onFirstMessage(handler) {
        this._onFirstMessage = handler;
    }

    /**
     * Remove the one-time interceptor.
     */
    offFirstMessage() {
        this._onFirstMessage = null;
    }

    /** @returns {boolean} */
    isConnected() {
        const ws = this._signaling.getWebSocket();
        return this._connected && ws !== null && ws.readyState === WebSocket.OPEN;
    }

    /** @returns {number} always 1 (single virtual channel) */
    getReadyCount() {
        return this._connected ? 1 : 0;
    }

    /** @returns {Array} */
    getChannelStats() {
        const elapsed = (Date.now() - this._stats.timestamp) / 1000;
        return [{
            index: 0,
            state: this._connected ? 'open' : 'closed',
            bufferedAmount: 0,
            throughput: elapsed > 0 ? this._stats.bytes / elapsed : 0,
            relay: true,
        }];
    }

    /** Reset throughput counters. */
    resetStats() {
        this._stats = { bytes: 0, timestamp: Date.now() };
    }

    /** Close the relay and remove listeners. */
    closeAll() {
        this._connected = false;
        if (this._removeChunkListener) {
            this._removeChunkListener();
            this._removeChunkListener = null;
        }
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Start listening for relay-chunk events from SignalingClient.
     *
     * All relay chunks arrive as JSON via the SignalingClient event system.
     * Binary chunks are delivered as base64 strings in msg.b64 and decoded here.
     * No raw WebSocket frame listener is attached — this avoids competing with
     * the SignalingClient's own message handler.
     */
    _startListening() {
        const onRelayChunk = (msg) => {
            try {
                if (msg.isText) {
                    // Text control message (FILE_META, CHUNK_REQUEST, etc.)
                    const data = msg.payload;
                    if (this._onFirstMessage) {
                        this._onFirstMessage(data, msg.channelIndex);
                    }
                    if (this._onMessage) {
                        this._onMessage(data, msg.channelIndex);
                    }
                } else {
                    // Binary chunk — decode base64 back to ArrayBuffer
                    const buffer = _base64ToArrayBuffer(msg.b64 ?? '');
                    if (this._onFirstMessage) {
                        this._onFirstMessage(buffer, msg.channelIndex);
                    }
                    if (this._onMessage) {
                        this._onMessage(buffer, msg.channelIndex);
                    }
                }
            } catch (err) {
                console.error('[RelayChannel] relay-chunk handler error:', err);
            }
        };

        this._signaling.on('relay-chunk', onRelayChunk);

        this._removeChunkListener = () => {
            this._signaling.off('relay-chunk', onRelayChunk);
        };
    }
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert a base64 string back to an ArrayBuffer.
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
function _base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
