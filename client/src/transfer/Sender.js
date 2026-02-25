import { ChunkManager } from './ChunkManager.js';
import { IntegrityVerifier } from './IntegrityVerifier.js';
import { TRANSFER_MSG, MAX_CHANNELS } from '@shared/constants.js';

/**
 * Sender — Streams file chunks on demand via DataChannels.
 * Never loads the full file into memory.
 */
export class Sender {
    /**
     * @param {File} file
     * @param {import('../core/ChannelManager.js').ChannelManager} channelManager
     * @param {Function} onProgress - (sentChunks, totalChunks, speed) => void
     */
    constructor(file, channelManager, onProgress) {
        this.chunkManager = new ChunkManager(file);
        this.channelManager = channelManager;
        this.onProgress = onProgress;
        this.verifier = new IntegrityVerifier();
        this._sentChunks = 0;
        this._startTime = null;
        this._bytesSent = 0;
        this._active = false;
    }

    /**
     * Get file metadata to send to receiver (over control channel).
     */
    getFileMeta() {
        return this.chunkManager.getFileMeta();
    }

    /**
     * Start listening for chunk requests from the receiver.
     * The receiver drives the transfer by requesting specific chunks.
     */
    start() {
        this._active = true;
        this._startTime = Date.now();

        this.channelManager.onMessage(async (rawData, channelIndex) => {
            if (!this._active) return;

            try {
                // Parse control messages (JSON strings)
                let msg;
                if (typeof rawData === 'string') {
                    msg = JSON.parse(rawData);
                } else if (rawData instanceof ArrayBuffer && rawData.byteLength < 1024) {
                    // Small messages might be control messages
                    try {
                        const text = new TextDecoder().decode(rawData);
                        msg = JSON.parse(text);
                    } catch {
                        return; // Not a control message
                    }
                } else {
                    return;
                }

                if (msg.type === TRANSFER_MSG.CHUNK_REQUEST) {
                    await this._handleChunkRequest(msg.index, channelIndex);
                }
            } catch (err) {
                console.error('[Sender] Error handling message:', err);
            }
        });
    }

    /**
     * Stop the sender.
     */
    stop() {
        this._active = false;
    }

    /**
     * Handle a chunk request from the receiver.
     */
    async _handleChunkRequest(index, channelIndex) {
        try {
            const data = await this.chunkManager.getChunk(index);
            const hash = await this.verifier.recordChunk(index, data);

            // Send hash first (as JSON control message)
            const hashMsg = JSON.stringify({
                type: TRANSFER_MSG.CHUNK_DATA,
                index,
                hash,
                size: data.byteLength,
            });
            await this.channelManager.send(channelIndex, hashMsg);

            // Send binary chunk data
            const packed = ChunkManager.packChunk(index, data);
            await this.channelManager.send(channelIndex, packed);

            this._sentChunks++;
            this._bytesSent += data.byteLength;

            // Report progress
            const elapsed = (Date.now() - this._startTime) / 1000;
            const speed = elapsed > 0 ? this._bytesSent / elapsed : 0;
            this.onProgress(this._sentChunks, this.chunkManager.totalChunks, speed);
        } catch (err) {
            console.error(`[Sender] Failed to send chunk ${index}:`, err);
        }
    }
}
