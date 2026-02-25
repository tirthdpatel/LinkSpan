import {
    MAX_CHANNELS,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
} from '@shared/constants.js';

/**
 * ChannelManager — Manages 7 parallel RTCDataChannels with backpressure control.
 */
export class ChannelManager {
    constructor() {
        /** @type {RTCDataChannel[]} */
        this.channels = [];
        /** @type {boolean[]} */
        this.ready = [];
        /** @type {Function[]} */
        this._drainCallbacks = [];
        /** @type {{ bytes: number, timestamp: number }[]} */
        this.stats = [];
        this._onMessage = null;
    }

    /**
     * Register all channels.
     * @param {RTCDataChannel[]} channels
     */
    setChannels(channels) {
        this.channels = channels;
        this.ready = channels.map(() => false);
        this.stats = channels.map(() => ({ bytes: 0, timestamp: Date.now() }));

        channels.forEach((ch, i) => {
            ch.onopen = () => {
                this.ready[i] = true;
            };

            ch.onclose = () => {
                this.ready[i] = false;
            };

            ch.onmessage = (event) => {
                this.stats[i].bytes += event.data.byteLength || event.data.length || 0;
                if (this._onMessage) {
                    this._onMessage(event.data, i);
                }
            };

            ch.onbufferedamountlow = () => {
                this._flushDrainQueue(i);
            };
        });
    }

    /**
     * Set the message handler.
     * @param {Function} handler - (data: ArrayBuffer | string, channelIndex: number) => void
     */
    onMessage(handler) {
        this._onMessage = handler;
    }

    /**
     * Send data on a specific channel with backpressure.
     * @param {number} channelIndex
     * @param {ArrayBuffer | string} data
     * @returns {Promise<void>}
     */
    async send(channelIndex, data) {
        const ch = this.channels[channelIndex];
        if (!ch || ch.readyState !== 'open') {
            throw new Error(`Channel ${channelIndex} is not open`);
        }

        // Backpressure: wait if buffer is full
        if (ch.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD * 4) {
            await this._waitForDrain(channelIndex);
        }

        ch.send(data);
    }

    /**
     * Send data on the next available channel (round-robin with backpressure awareness).
     * @param {ArrayBuffer | string} data
     * @returns {Promise<number>} - channel index used
     */
    async sendAny(data) {
        const idx = this._pickChannel();
        await this.send(idx, data);
        return idx;
    }

    /**
     * Check if at least one channel is open.
     */
    isConnected() {
        return this.channels.some((ch) => ch.readyState === 'open');
    }

    /**
     * Get all channels' ready state.
     */
    getReadyCount() {
        return this.channels.filter((ch) => ch.readyState === 'open').length;
    }

    /**
     * Get per-channel throughput stats.
     */
    getChannelStats() {
        const now = Date.now();
        return this.channels.map((ch, i) => {
            const elapsed = (now - this.stats[i].timestamp) / 1000;
            const throughput = elapsed > 0 ? this.stats[i].bytes / elapsed : 0;
            return {
                index: i,
                state: ch.readyState,
                bufferedAmount: ch.bufferedAmount,
                throughput, // bytes/sec since last reset
            };
        });
    }

    /**
     * Reset throughput counters.
     */
    resetStats() {
        const now = Date.now();
        this.stats = this.stats.map(() => ({ bytes: 0, timestamp: now }));
    }

    /**
     * Close all channels.
     */
    closeAll() {
        for (const ch of this.channels) {
            try { ch.close(); } catch { /* noop */ }
        }
        this.channels = [];
        this.ready = [];
    }

    // ── Private ────────────────────────────────────────────────

    _roundRobinIndex = 0;

    _pickChannel() {
        // Pick the open channel with the lowest bufferedAmount
        let best = -1;
        let lowestBuffer = Infinity;

        for (let i = 0; i < this.channels.length; i++) {
            const ch = this.channels[i];
            if (ch.readyState === 'open' && ch.bufferedAmount < lowestBuffer) {
                lowestBuffer = ch.bufferedAmount;
                best = i;
            }
        }

        if (best === -1) {
            // Fall back to round-robin on any open channel
            for (let attempt = 0; attempt < this.channels.length; attempt++) {
                const idx = (this._roundRobinIndex + attempt) % this.channels.length;
                if (this.channels[idx].readyState === 'open') {
                    this._roundRobinIndex = (idx + 1) % this.channels.length;
                    return idx;
                }
            }
            throw new Error('No open channels available');
        }

        return best;
    }

    _waitForDrain(channelIndex) {
        return new Promise((resolve) => {
            this._drainCallbacks.push({ channelIndex, resolve });
        });
    }

    _flushDrainQueue(channelIndex) {
        const waiting = this._drainCallbacks.filter(
            (cb) => cb.channelIndex === channelIndex
        );
        this._drainCallbacks = this._drainCallbacks.filter(
            (cb) => cb.channelIndex !== channelIndex
        );
        waiting.forEach((cb) => cb.resolve());
    }
}
