import { ChunkManager } from './ChunkManager.js';
import { IntegrityVerifier } from './IntegrityVerifier.js';
import {
    TRANSFER_MSG,
    MAX_IN_FLIGHT,
    MAX_RETRY_COUNT,
} from '@shared/constants.js';

/**
 * Receiver — Receiver-driven pull model for parallel chunk download.
 */
export class Receiver {
    /**
     * @param {object} fileMeta - from sender's getFileMeta()
     * @param {import('../core/ChannelManager.js').ChannelManager} channelManager
     * @param {import('../storage/StorageManager.js').StorageManager} storageManager
     * @param {Function} onProgress - (receivedChunks, totalChunks, speed) => void
     * @param {Function} onComplete - (fileBlob) => void
     * @param {Function} onError - (error) => void
     */
    constructor(fileMeta, channelManager, storageManager, onProgress, onComplete, onError) {
        this.fileMeta = fileMeta;
        this.channelManager = channelManager;
        this.storageManager = storageManager;
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.onError = onError;

        this.verifier = new IntegrityVerifier();
        this.totalChunks = fileMeta.totalChunks;

        /** @type {Set<number>} */
        this.receivedChunks = new Set();
        /** @type {Set<number>} */
        this.inFlight = new Set();
        /** @type {Map<number, number>} chunk index → retry count */
        this.retryCount = new Map();
        /** @type {Map<number, { hash: string, size: number }>} pending hash metadata */
        this._pendingMeta = new Map();

        this._active = false;
        this._startTime = null;
        this._bytesReceived = 0;
    }

    /**
     * Start the receiver — begin requesting chunks.
     */
    async start() {
        this._active = true;
        this._startTime = Date.now();

        // Initialize storage for this file
        await this.storageManager.initFile(this.fileMeta);

        // Listen for incoming data
        this.channelManager.onMessage(async (rawData, channelIndex) => {
            if (!this._active) return;

            try {
                if (typeof rawData === 'string') {
                    const msg = JSON.parse(rawData);
                    if (msg.type === TRANSFER_MSG.CHUNK_DATA) {
                        // Store hash metadata, wait for binary data
                        this._pendingMeta.set(msg.index, { hash: msg.hash, size: msg.size });
                    }
                } else if (rawData instanceof ArrayBuffer) {
                    // Binary chunk data
                    const { index, data } = ChunkManager.unpackChunk(rawData);
                    await this._handleChunkData(index, data);
                }
            } catch (err) {
                console.error('[Receiver] Error handling message:', err);
            }
        });

        // Start requesting chunks
        this._requestNextChunks();
    }

    /**
     * Stop the receiver.
     */
    stop() {
        this._active = false;
    }

    /**
     * Resume with a set of already-received chunk indices.
     * @param {Set<number>} receivedIndices
     */
    resumeWith(receivedIndices) {
        this.receivedChunks = new Set(receivedIndices);
        this._bytesReceived = receivedIndices.size * this.fileMeta.chunkSize;
    }

    /**
     * Get the list of missing chunk indices.
     * @returns {number[]}
     */
    getMissingChunks() {
        const missing = [];
        for (let i = 0; i < this.totalChunks; i++) {
            if (!this.receivedChunks.has(i)) {
                missing.push(i);
            }
        }
        return missing;
    }

    // ── Private ────────────────────────────────────────────────

    async _handleChunkData(index, data) {
        const meta = this._pendingMeta.get(index);
        this._pendingMeta.delete(index);
        this.inFlight.delete(index);

        if (!meta) {
            // No metadata — request again
            this._requestChunk(index);
            return;
        }

        // Verify integrity
        const isValid = await IntegrityVerifier.verifyChunk(data, meta.hash);

        if (!isValid) {
            const retries = this.retryCount.get(index) || 0;
            if (retries < MAX_RETRY_COUNT) {
                this.retryCount.set(index, retries + 1);
                console.warn(`[Receiver] Chunk ${index} integrity failed, retry ${retries + 1}`);
                this._requestChunk(index);
            } else {
                this.onError(new Error(`Chunk ${index} failed integrity check after ${MAX_RETRY_COUNT} retries`));
                this.stop();
            }
            return;
        }

        // Store chunk
        try {
            await this.storageManager.writeChunk(index, data);
        } catch (err) {
            this.onError(err);
            this.stop();
            return;
        }

        this.receivedChunks.add(index);
        this._bytesReceived += data.byteLength;
        this.verifier.recordChunk(index, data);

        // Progress
        const elapsed = (Date.now() - this._startTime) / 1000;
        const speed = elapsed > 0 ? this._bytesReceived / elapsed : 0;
        this.onProgress(this.receivedChunks.size, this.totalChunks, speed);

        // Check if complete
        if (this.receivedChunks.size === this.totalChunks) {
            await this._finalize();
            return;
        }

        // Request more chunks
        this._requestNextChunks();
    }

    _requestNextChunks() {
        if (!this._active) return;

        const missing = this.getMissingChunks();
        const slotsAvailable = MAX_IN_FLIGHT - this.inFlight.size;

        for (let i = 0; i < Math.min(slotsAvailable, missing.length); i++) {
            const chunkIndex = missing[i];
            if (!this.inFlight.has(chunkIndex)) {
                this._requestChunk(chunkIndex);
            }
        }
    }

    _requestChunk(index) {
        this.inFlight.add(index);
        const msg = JSON.stringify({
            type: TRANSFER_MSG.CHUNK_REQUEST,
            index,
        });

        // Send on any available channel
        this.channelManager.sendAny(msg).catch((err) => {
            console.error(`[Receiver] Failed to request chunk ${index}:`, err);
            this.inFlight.delete(index);
        });
    }

    async _finalize() {
        this._active = false;

        try {
            const fileBlob = await this.storageManager.assembleFile();
            this.onComplete(fileBlob);
        } catch (err) {
            this.onError(err);
        }
    }
}
