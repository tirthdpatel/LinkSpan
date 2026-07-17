import { ChunkManager } from './ChunkManager.js';
import { IntegrityVerifier } from './IntegrityVerifier.js';
import { FileManifest } from './FileManifest.js';
import { CryptoEngine } from '../crypto/CryptoEngine.js';
import { HashWorkerPool } from '../crypto/HashWorkerPool.js';
import { FECEncoder, adaptiveGroupSize, FEC_DEFAULT_GROUP, fecParityIndex } from './FECEngine.js';
import { maybeCompress, isFileCompressible } from './Compression.js';
import {
    TRANSFER_MSG,
    MAX_RETRY_COUNT,
    SENDER_CONCURRENCY,
    pickChunkSize,
} from '@shared/constants.js';
import { validateRanges, rangesToChunks } from '@shared/chunkRanges.js';

/**
 * Sender — Streams file chunks on demand via DataChannels.
 * Never loads the full file into memory.
 *
 * Key improvements from v1:
 * - Handles CANCEL, PAUSE, RESUME control messages from receiver
 * - Retry with exponential backoff per chunk send failure
 * - Delta-based progress reporting (only emits on actual change)
 * - Channel failure recovery: redistributes load to remaining open channels
 * - Guards against sending after stop()
 */
export class Sender {
    /**
     * @param {File} file
     * @param {import('../core/ChannelManager.js').ChannelManager} channelManager
     * @param {Function} onProgress - (sentChunks, totalChunks, speed) => void
     * @param {Function} [onCancel]  - () => void
     * @param {Function} [onError]   - (error) => void
     * @param {CryptoKey} [cryptoKey] - AES-256-GCM session key. When present, every
     *        chunk is encrypted before it leaves this peer, so neither a relay nor
     *        any intermediary can read file contents.
     * @param {number} [rttMs=0] - handshake-measured RTT in ms. Passed through to
     *        pickChunkSize so high-RTT paths use max chunk size for medium files.
     */
    constructor(file, channelManager, onProgress, onCancel = null, onError = null, cryptoKey = null, rttMs = 0) {
        this.cryptoKey = cryptoKey;
        // Dynamic chunk size (Phase 4.3): scaled to the file and RTT, capped so the
        // framed ciphertext (header + IV + tag) stays within the 256 KB DataChannel
        // limit. On high-RTT paths, medium files use max chunks to reduce round-trips.
        this.chunkManager = new ChunkManager(file, pickChunkSize(file.size, !!cryptoKey, rttMs));
        // Decide once per file whether compression can help. Already-compressed media
        // (video/audio/images/archives) skip deflate entirely — attempting it on every
        // chunk of a large H.264 video is pure wasted CPU that never shrinks the data.
        this._compressChunks = isFileCompressible(file);
        this.channelManager = channelManager;
        this.onProgress = onProgress;
        this.onCancel = onCancel;
        this.onError = onError;
        this.verifier = new IntegrityVerifier();
        // Off-main-thread SHA-256 hashing: spawns 1–2 Web Workers so the main
        // thread event loop stays responsive during high-concurrency chunk serving.
        // Falls back to main-thread crypto.subtle if workers can't be created.
        this._hashPool = new HashWorkerPool(2);
        this.verifier.setWorkerPool(this._hashPool);

        this._sentChunks = 0;
        // On a resumed transfer the receiver already holds some chunks and reports
        // that count via RESUME_PROGRESS. We add it as a baseline so reported
        // progress reflects the whole transfer, not just chunks served this session.
        this._resumeBaseline = 0;
        /** @type {Set<number>} indices already delivered, so NACK retransmits don't double-count */
        this._sentIndices = new Set();
        this._lastReportedChunks = -1;
        this._startTime = null;
        this._bytesSent = 0;
        this._active = false;
        this._paused = false;

        /** @type {Map<number, number>} chunk index → retry count */
        this._retryCount = new Map();

        // ── Push mode state (intercontinental optimization) ──────────────
        // When the receiver advertises supportsPush, the sender proactively pushes
        // chunks instead of waiting for per-chunk requests. This eliminates one
        // RTT per window of data.
        this._pushMode = false;
        /** Next chunk index to push (advances on PUSH_ACK) */
        this._pushCursor = 0;
        /** Push window size (set from receiver's initial window / PUSH_ACK) */
        this._pushWindow = 0;
        /** Resolves when a PUSH_ACK arrives or push mode should advance */
        this._pushWake = null;

        // Loss accounting for the diagnostics readout. A request for an index we
        // already delivered means the receiver never got it (its stall timer
        // re-requested) — that duplicate is our observable loss signal.
        this._chunkSends = 0;   // total successful chunk deliveries (incl. retransmits)
        this._retransmits = 0;  // deliveries that re-sent an already-delivered index

        // FEC encoder: emits XOR parity every N chunks so the receiver can
        // reconstruct a single lost chunk without a retransmission round-trip.
        // Disabled by default — parity is pure wire overhead unless the receiver can
        // decode it, so it is only produced once FEC is negotiated (enableFec, driven
        // by the receiver advertising supportsFec in FILE_META). See FECEngine.js.
        this._fecEncoder = new FECEncoder(FEC_DEFAULT_GROUP);
        this._fecEnabled = false;
    }

    /**
     * Turn FEC parity generation on. Called by BatchSender when the peer negotiated
     * FEC support. Until this is called the sender emits no parity frames.
     */
    enableFec() {
        this._fecEnabled = true;
    }

    // ── Public API ─────────────────────────────────────────────

    /**
     * Loss stats for diagnostics: fraction of chunk deliveries that were
     * retransmits of an already-delivered index (i.e. the receiver lost them).
     * @returns {{ sends: number, retransmits: number, lossRate: number }}
     */
    getLossStats() {
        const sends = this._chunkSends;
        return {
            sends,
            retransmits: this._retransmits,
            lossRate: sends > 0 ? this._retransmits / sends : 0,
        };
    }

    /**
     * Get file metadata to send to receiver.
     */
    getFileMeta() {
        return this.chunkManager.getFileMeta();
    }

    /**
     * Start listening for chunk requests from the receiver.
     */
    start() {
        this._active = true;
        this._paused = false;
        this._startTime = Date.now();

        this.channelManager.onMessage(async (rawData) => {
            if (!this._active) return;

            try {
                let msg;
                if (typeof rawData === 'string') {
                    msg = JSON.parse(rawData);
                } else if (rawData instanceof ArrayBuffer && rawData.byteLength < 1024) {
                    try {
                        const text = new TextDecoder().decode(rawData);
                        msg = JSON.parse(text);
                    } catch {
                        return;
                    }
                } else {
                    return;
                }

                switch (msg.type) {
                    case TRANSFER_MSG.CHUNK_REQUEST:
                        if (!this._paused) {
                            await this._handleChunkRequest(msg.index);
                        }
                        break;

                    case TRANSFER_MSG.CHUNK_REQUEST_RANGE:
                        if (!this._paused) {
                            await this._handleChunkRequestRange(msg.ranges);
                        }
                        break;

                    case TRANSFER_MSG.CHUNK_NACK:
                        // Receiver rejected a chunk — re-send immediately (priority)
                        await this._handleChunkRequest(msg.index, true);
                        break;

                    case TRANSFER_MSG.MANIFEST_REQUEST:
                        await this._sendManifest();
                        break;

                    case TRANSFER_MSG.CANCEL:
                        console.log('[Sender] Transfer cancelled by receiver.');
                        this._active = false;
                        if (this.onCancel) this.onCancel();
                        break;

                    case TRANSFER_MSG.PAUSE:
                        this._paused = true;
                        break;

                    case TRANSFER_MSG.RESUME_PROGRESS:
                        // Receiver already holds `received` chunks from a prior session;
                        // baseline our reported progress so the UI doesn't restart at 0%.
                        this._resumeBaseline = Math.min(
                            Number(msg.received) || 0,
                            this.chunkManager.totalChunks,
                        );
                        break;

                    case TRANSFER_MSG.RESUME: {
                        this._paused = false;
                        // Send ACK so receiver knows we're ready
                        const ackMsg = JSON.stringify({ type: TRANSFER_MSG.RESUME_ACK });
                        this.channelManager.sendAny(ackMsg).catch(() => { /* noop */ });
                        break;
                    }

                    case TRANSFER_MSG.PUSH_ACK: {
                        // Receiver confirmed receipt up to highestContiguous — advance
                        // the push window so the push loop sends the next batch.
                        const hc = Number(msg.highestContiguous);
                        if (Number.isFinite(hc) && hc >= 0) {
                            // Advance cursor: next push starts after highest confirmed
                            this._pushCursor = Math.max(this._pushCursor, hc + 1);
                            // Wake the push loop if it's sleeping
                            if (this._pushWake) {
                                this._pushWake();
                                this._pushWake = null;
                            }
                        }
                        break;
                    }

                    default:
                        break;
                }
            } catch (err) {
                console.error('[Sender] Error handling message:', err);
            }
        });
    }

    /**
     * Enable push mode and start the proactive push loop. Called by BatchSender
     * when the receiver advertises supportsPush in FILE_META/BATCH_META.
     * @param {number} window - initial push window (from receiver's initial window)
     */
    startPush(window) {
        this._pushMode = true;
        this._pushCursor = 0;
        this._pushWindow = Math.max(window, 24);
        this._runPushLoop();
    }

    /**
     * Push loop: proactively sends chunks [cursor, cursor+window) without waiting
     * for per-chunk requests. When the window is exhausted, sleeps until a PUSH_ACK
     * advances the cursor. Retransmission requests (CHUNK_REQUEST) are handled by
     * the message handler above, independently of this loop.
     */
    async _runPushLoop() {
        const total = this.chunkManager.totalChunks;

        while (this._active && !this._paused && this._pushCursor < total) {
            // Push up to window-size chunks
            const windowEnd = Math.min(this._pushCursor + this._pushWindow, total);
            const indices = [];
            for (let i = this._pushCursor; i < windowEnd; i++) {
                indices.push(i);
            }

            if (indices.length === 0) break;

            // Serve with bounded concurrency (reuse the same pattern as range requests)
            let cursor = 0;
            const worker = async () => {
                while (this._active && !this._paused) {
                    const ci = cursor++;
                    if (ci >= indices.length) return;
                    await this._handleChunkRequest(indices[ci]);
                }
            };
            const workers = [];
            for (let w = 0; w < Math.min(SENDER_CONCURRENCY, indices.length); w++) {
                workers.push(worker());
            }
            await Promise.all(workers);

            if (!this._active || this._paused) break;

            // If we've sent everything, we're done
            if (windowEnd >= total) break;

            // Wait for a PUSH_ACK to advance the cursor before pushing more.
            // The receiver sends PUSH_ACK periodically with { highestContiguous },
            // which the message handler above uses to advance _pushCursor.
            if (this._pushCursor < windowEnd) {
                // Cursor hasn't advanced yet — sleep until PUSH_ACK wakes us
                await new Promise((resolve) => {
                    this._pushWake = resolve;
                });
            }
        }
    }

    /**
     * Stop the sender.
     */
    stop() {
        this._active = false;
        this._hashPool?.terminate();
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Compute the whole-file manifest root over all plaintext chunk hashes and
     * send it to the receiver for final verification.
     *
     * The root MUST cover every chunk of the file, not just the chunks served this
     * session. On a resumed transfer the receiver only re-requests the missing gaps,
     * so the verifier would be missing hashes for the chunks transferred in a prior
     * session — `getOrderedHashes` would leave those slots empty and the root would
     * never match the receiver's whole-file recomputation. So we fill any gap by
     * reading the chunk straight from the source file and hashing it (the hash is over
     * plaintext, exactly as `recordChunk`/`getChunk` do during serving). Chunks already
     * hashed this session are reused, so a normal (non-resumed) transfer reads nothing
     * extra.
     */
    async _sendManifest() {
        const ordered = await this._buildWholeFileHashes(this.chunkManager.totalChunks);
        const { rootHash } = await FileManifest.buildFromHashes(ordered);
        const msg = JSON.stringify({
            type: TRANSFER_MSG.MANIFEST,
            rootHash,
            totalChunks: this.chunkManager.totalChunks,
        });
        await this.channelManager.sendAny(msg).catch(() => { /* receiver may be gone */ });
    }

    /**
     * Build the complete ordered plaintext-hash list for the whole file, reusing any
     * hashes recorded while serving and filling gaps from the source file.
     * @param {number} totalChunks
     * @returns {Promise<string[]>}
     */
    async _buildWholeFileHashes(totalChunks) {
        const ordered = new Array(totalChunks);
        for (let i = 0; i < totalChunks; i++) {
            let hash = this.verifier.getChunkHash(i);
            if (!hash) {
                // Not served this session (resumed transfer) — hash it from the source.
                const data = await this.chunkManager.getChunk(i);
                hash = await this.verifier.recordChunk(i, data);
            }
            ordered[i] = hash;
        }
        return ordered;
    }

    /**
     * Handle a coalesced range-list request from the receiver. Every range is
     * validated against the real chunk count BEFORE any expansion — negative /
     * zero-count / out-of-bounds / overlapping ranges are rejected outright (a
     * hostile or buggy receiver can't make us expand garbage or do duplicate work) —
     * then the normalized ranges are expanded and each chunk is served exactly as a
     * per-chunk CHUNK_REQUEST would be.
     * @param {{start: number, count: number}[]} ranges
     */
    async _handleChunkRequestRange(ranges) {
        if (!this._active) return;

        let normalized;
        try {
            normalized = validateRanges(ranges, this.chunkManager.totalChunks);
        } catch (err) {
            console.error('[Sender] Rejecting invalid chunk range request:', err.message);
            return; // ignore the bad frame; receiver will re-request / stall-recover
        }

        // Serve the requested chunks with bounded concurrency rather than strictly
        // one-at-a-time. The old serial loop left the CPU idle during each chunk's
        // async read/hash/encrypt and the data channels idle during each other's
        // sends; SENDER_CONCURRENCY workers pull from a shared cursor so several
        // chunks are prepared and in flight across the channels at once. Per-chunk
        // ordering (hash frame then binary, on the same channel) is unchanged, and
        // ChannelManager.send still applies per-channel backpressure, so this bounds
        // memory while keeping the link saturated.
        const indices = rangesToChunks(normalized);
        let cursor = 0;
        const worker = async () => {
            while (this._active && !this._paused) {
                const i = cursor++;
                if (i >= indices.length) return;
                await this._handleChunkRequest(indices[i]);
            }
        };
        const workers = [];
        for (let w = 0; w < Math.min(SENDER_CONCURRENCY, indices.length); w++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    /**
     * Handle a chunk request from the receiver.
     * @param {number} index
     * @param {boolean} [isRetransmit] - true if this is a NACK retry
     */
    async _handleChunkRequest(index, isRetransmit = false) {
        if (!this._active) return;

        const retries = this._retryCount.get(index) || 0;
        if (!isRetransmit && retries >= MAX_RETRY_COUNT) {
            console.error(`[Sender] Chunk ${index} exceeded max retries`);
            if (this.onError) {
                this.onError(new Error(`Chunk ${index} could not be sent after ${MAX_RETRY_COUNT} attempts`));
            }
            this.stop();
            return;
        }

        try {
            const data = await this.chunkManager.getChunk(index);
            // Hash is computed over plaintext so the receiver verifies the decrypted
            // bytes — this keeps per-chunk and whole-file hash semantics intact.
            const hash = await this.verifier.recordChunk(index, data);

            // Compress the plaintext before encryption (only if it actually shrinks;
            // maybeCompress returns the original bytes with compressed=false otherwise).
            // Compressing inside the ciphertext keeps the hash/verification semantics
            // over the original plaintext. Skipped wholesale for already-compressed
            // files so we don't deflate-and-discard every chunk of e.g. a video.
            const { data: payloadPlain, compressed } = this._compressChunks
                ? await maybeCompress(data)
                : { data, compressed: false };

            // Encrypt before it leaves this peer (no-op if no session key).
            const payload = this.cryptoKey
                ? await CryptoEngine.encryptChunk(this.cryptoKey, payloadPlain)
                : payloadPlain;

            // Find the best channel for this chunk
            const channelIndex = this._pickBestChannel();
            if (channelIndex === -1) {
                // No open channels — schedule retry with backoff
                await this._retryWithBackoff(index, retries);
                return;
            }

            // Send hash metadata (JSON control message). size = plaintext size;
            // `compressed` tells the receiver whether to inflate before verifying.
            const hashMsg = JSON.stringify({
                type: TRANSFER_MSG.CHUNK_DATA,
                index,
                hash,
                size: data.byteLength,
                compressed,
            });
            await this.channelManager.send(channelIndex, hashMsg);

            // Send binary chunk data (ciphertext when encrypting)
            const packed = ChunkManager.packChunk(index, payload);
            await this.channelManager.send(channelIndex, packed);

            // Reset retry count on success
            this._retryCount.delete(index);

            // Count unique chunks only — a NACK retransmit re-sends an index we
            // already delivered, so without this guard _sentChunks would exceed
            // totalChunks (progress > 100%, negative ETA) on any lossy link.
            this._bytesSent += data.byteLength;
            this._chunkSends++;
            if (this._sentIndices.has(index)) {
                this._retransmits++; // re-sending a delivered index → receiver lost it
            } else {
                this._sentIndices.add(index);
                this._sentChunks = this._sentIndices.size;
            }

            // Delta-based progress reporting (only emit on change)
            if (this._sentChunks !== this._lastReportedChunks) {
                this._lastReportedChunks = this._sentChunks;
                const elapsed = (Date.now() - this._startTime) / 1000;
                const speed = elapsed > 0 ? this._bytesSent / elapsed : 0;
                // Report progress against the whole transfer: chunks the receiver
                // already had (resume baseline) plus chunks served this session.
                const reported = Math.min(
                    this._resumeBaseline + this._sentChunks,
                    this.chunkManager.totalChunks,
                );
                this.onProgress(reported, this.chunkManager.totalChunks, speed);
            }

            // FEC: feed the payload (ciphertext) to the encoder. When a group
            // completes, emit the parity so the receiver can reconstruct a single
            // lost chunk without a retransmission round-trip.
            if (this._fecEnabled && !isRetransmit) {
                // Adapt group size based on observed loss rate
                const lossRate = this._chunkSends > 20
                    ? this._retransmits / this._chunkSends : 0;
                this._fecEncoder.setGroupSize(adaptiveGroupSize(lossRate));

                const parity = this._fecEncoder.addChunk(index, payload);
                if (parity) {
                    await this._sendFecParity(parity);
                }
            }
        } catch (err) {
            console.error(`[Sender] Failed to send chunk ${index}:`, err.message);
            this._retryCount.set(index, retries + 1);
            await this._retryWithBackoff(index, retries + 1);
        }
    }

    /**
     * Retry sending a chunk with exponential backoff.
     * @param {number} index
     * @param {number} attempt
     */
    async _retryWithBackoff(index, attempt) {
        if (!this._active) return;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this._active) {
            await this._handleChunkRequest(index, true);
        }
    }

    /**
     * Pick the channel with the lowest buffered amount (best for sending).
     * Returns -1 if no channels are open.
     * @returns {number}
     */
    _pickBestChannel() {
        const stats = this.channelManager.getChannelStats();
        let best = -1;
        let lowestBuffer = Infinity;

        for (const stat of stats) {
            if (stat.state === 'open' && stat.bufferedAmount < lowestBuffer) {
                lowestBuffer = stat.bufferedAmount;
                best = stat.index;
            }
        }

        return best;
    }

    /**
     * Send FEC parity data for a completed group.
     * @param {{ groupId: number, groupStart: number, groupSize: number, parityData: ArrayBuffer }} parity
     */
    async _sendFecParity(parity) {
        if (!this._active) return;
        try {
            const meta = JSON.stringify({
                type: TRANSFER_MSG.FEC_PARITY,
                groupId: parity.groupId,
                groupStart: parity.groupStart,
                groupSize: parity.groupSize,
                paritySize: parity.parityData.byteLength,
                // Exact ciphertext length of each chunk in the group — lets the receiver
                // trim a reconstructed (zero-padded) chunk before GCM decryption.
                chunkLengths: parity.chunkLengths,
            });
            await this.channelManager.sendAny(meta);
            // Send the binary parity data reusing ChunkManager's chunk framing, under a
            // high synthetic index (top of the u32 range) so the receiver can tell parity
            // frames from data chunks — the header index is unsigned, so a plain negative
            // value would wrap into the valid chunk-index range. See FECEngine.
            const packed = ChunkManager.packChunk(fecParityIndex(parity.groupId), parity.parityData);
            await this.channelManager.sendAny(packed);
        } catch {
            // FEC is best-effort — a failure to send parity is not fatal.
            // The receiver falls back to retransmission for lost chunks.
        }
    }
}
