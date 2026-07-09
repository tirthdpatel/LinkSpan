import {
    TRANSFER_MSG,
    MAX_IN_FLIGHT,
    MAX_IN_FLIGHT_CAP,
    MAX_RETRY_COUNT,
    STALL_TIMEOUT_MS,
} from '@shared/constants.js';
import { chunksToRanges } from '@shared/chunkRanges.js';
import { ChunkManager } from './ChunkManager.js';
import { IntegrityVerifier } from './IntegrityVerifier.js';
import { FileManifest } from './FileManifest.js';
import { CryptoEngine } from '../crypto/CryptoEngine.js';
import { maybeDecompress } from './Compression.js';

/**
 * Receiver — Receiver-driven pull model for parallel chunk download.
 *
 * Key improvements from v1:
 * - Stall detection: if no chunk arrives for STALL_TIMEOUT_MS, re-request in-flight chunks
 * - cancel() / pause() / resume() for user-driven transfer control
 * - Proper out-of-order chunk handling with pending buffer before writing
 * - ResumeManager integration (receivedChunks sourced from ResumeManager, not local Set)
 * - Guards against _requestNextChunks() after _finalize() has been called
 * - Sends CANCEL message to sender on cancel()
 */
export class Receiver {
    /**
     * @param {object} fileMeta
     * @param {import('../core/ChannelManager.js').ChannelManager} channelManager
     * @param {import('../storage/StorageManager.js').StorageManager} storageManager
     * @param {import('../storage/ResumeManager.js').ResumeManager} resumeManager
     * @param {Function} onProgress  - (receivedChunks, totalChunks, speed, chunkIndex) => void
     * @param {Function} onComplete  - (fileBlob) => void
     * @param {Function} onError     - (error) => void
     * @param {Function} [onStalled] - () => void
     * @param {CryptoKey} [cryptoKey] - AES-256-GCM session key. Must match the
     *        sender's; when present, every received chunk is decrypted before
     *        integrity verification and storage.
     */
    constructor(
        fileMeta,
        channelManager,
        storageManager,
        resumeManager,
        onProgress,
        onComplete,
        onError,
        onStalled = null,
        cryptoKey = null
    ) {
        this.cryptoKey = cryptoKey;
        this.fileMeta = fileMeta;
        this.channelManager = channelManager;
        this.storageManager = storageManager;
        this.resumeManager = resumeManager;
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.onError = onError;
        this.onStalled = onStalled;

        this.verifier = new IntegrityVerifier();
        this.totalChunks = fileMeta.totalChunks;

        // Range-list requests are used only when the sender advertised the capability
        // in FILE_META. Against an old sender (no flag) we fall back to per-chunk
        // CHUNK_REQUEST. This receiver always understands the per-chunk response.
        this._supportsRange = fileMeta?.supportsRangeRequest === true;

        /** @type {Set<number>} chunks in-flight (requested but not yet received) */
        this.inFlight = new Set();
        /** @type {Map<number, number>} chunk index → request timestamp (for RTT) */
        this._requestedAt = new Map();
        // Adaptive pull window (bandwidth-delay product). Starts at the fixed
        // MAX_IN_FLIGHT floor and grows toward measured BDP on long fat pipes —
        // a fixed 24×256 KB window caps a 200 ms path at ~30 MB/s of *theoretical*
        // ceiling but strangles multi-connection striping and higher-RTT relays.
        this._window = MAX_IN_FLIGHT;
        /** @type {number|null} EWMA of request→arrival latency in ms */
        this._rttEwma = null;
        /** @type {Map<number, number>} chunk index → retry count */
        this.retryCount = new Map();
        /** @type {Map<number, { hash: string, size: number, compressed: boolean }>} pending hash metadata */
        this._pendingMeta = new Map();
        /**
         * @type {Map<number, ArrayBuffer>} binary chunks that arrived before their metadata.
         * Each chunk is sent as a metadata frame then a binary frame; ordered channels
         * guarantee that order, but so the protocol also survives UNORDERED channels (which
         * remove head-of-line blocking on lossy links), a binary frame that outruns its
         * metadata is buffered here and processed when the metadata lands — instead of being
         * wastefully re-requested.
         */
        this._pendingData = new Map();

        this._active = false;
        this._paused = false;
        this._finalized = false;
        this._startTime = null;
        this._bytesReceived = 0;
        this._lastChunkTime = null;
        this._stallTimer = null;
        this._awaitingManifest = false;
        this._manifestTimer = null;

        // Loss accounting for the diagnostics readout. Every chunk we ask for counts
        // as a request; chunks the stall timer has to ask for again are our observable
        // loss signal (the sender's copy never arrived within STALL_TIMEOUT_MS).
        this._chunkRequests = 0;
        this._retransmits = 0;
    }

    // ── Public API ─────────────────────────────────────────────

    /**
     * Loss stats for diagnostics: fraction of chunk requests we had to re-issue
     * because the sender's copy never arrived within the stall timeout.
     * @returns {{ requests: number, retransmits: number, lossRate: number }}
     */
    getLossStats() {
        const requests = this._chunkRequests;
        return {
            requests,
            retransmits: this._retransmits,
            lossRate: requests > 0 ? this._retransmits / requests : 0,
        };
    }

    /**
     * Start the receiver — initialize storage and begin requesting chunks.
     */
    async start() {
        this._active = true;
        this._paused = false;
        this._finalized = false;
        this._startTime = Date.now();
        this._lastChunkTime = Date.now();

        // Initialize ResumeManager state for this file
        await this.resumeManager.init(this.fileMeta.fileId, this.totalChunks);

        // Initialize storage for this file
        await this.storageManager.initFile(this.fileMeta);

        // On a resume, seed the sender's progress display before we start pulling.
        // The ledger init above may have recovered already-received chunks; tell the
        // sender how many we hold so its UI doesn't restart from 0. Skipped for a
        // fresh transfer (received === 0) where there's nothing to seed.
        const received = this.totalChunks - this.getMissingChunks().length;
        if (received > 0) {
            await this.channelManager.sendAny(JSON.stringify({
                type: TRANSFER_MSG.RESUME_PROGRESS,
                fileId: this.fileMeta.fileId,
                received,
            })).catch(() => { /* sender may not support it / be gone */ });
        }

        // Listen for incoming data
        this.channelManager.onMessage(async (rawData) => {
            if (!this._active) return;

            try {
                if (typeof rawData === 'string') {
                    const msg = JSON.parse(rawData);
                    if (msg.type === TRANSFER_MSG.CHUNK_DATA) {
                        this._pendingMeta.set(msg.index, { hash: msg.hash, size: msg.size, compressed: msg.compressed });
                        // If the binary frame already arrived (unordered channel), process it now.
                        const early = this._pendingData.get(msg.index);
                        if (early !== undefined) {
                            this._pendingData.delete(msg.index);
                            await this._handleChunkData(msg.index, early);
                        }
                    } else if (msg.type === TRANSFER_MSG.RESUME_ACK) {
                        // Sender acknowledged resume — restart requesting from missing chunks
                        this._requestNextChunks();
                    } else if (msg.type === TRANSFER_MSG.MANIFEST) {
                        await this._verifyManifestAndFinalize(msg.rootHash);
                    }
                } else if (rawData instanceof ArrayBuffer) {
                    const { index, data } = ChunkManager.unpackChunk(rawData);
                    if (this._pendingMeta.has(index)) {
                        await this._handleChunkData(index, data);
                    } else {
                        // Metadata hasn't landed yet — hold the binary until it does.
                        this._pendingData.set(index, data);
                    }
                }
            } catch (err) {
                console.error('[Receiver] Error handling message:', err);
            }
        });

        // Start stall detection
        this._startStallTimer();

        // Begin requesting chunks
        this._requestNextChunks();
    }

    /**
     * Stop the receiver entirely.
     */
    stop() {
        this._active = false;
        this._clearStallTimer();
        if (this._manifestTimer) { clearInterval(this._manifestTimer); this._manifestTimer = null; }
    }

    /**
     * Cancel the transfer — stop and notify sender.
     *
     * Note: the ResumeManager ledger is intentionally NOT cleared here. Already-received
     * chunks are kept so a retry resumes from where it left off; the ledger is only
     * cleared in _finalize() on verified, successful completion.
     */
    cancel() {
        this._active = false;
        this._clearStallTimer();

        // Notify sender to stop
        const cancelMsg = JSON.stringify({ type: TRANSFER_MSG.CANCEL });
        this.channelManager.sendAny(cancelMsg).catch(() => { /* sender may be gone */ });
    }

    /**
     * Pause the transfer (stop requesting new chunks).
     */
    pause() {
        this._paused = true;
        this._clearStallTimer();

        // Persist the ledger at this deliberate checkpoint so a crash while paused
        // doesn't lose progress accumulated since the last debounced flush.
        this.resumeManager.flush?.(this.fileMeta.fileId).catch(() => { /* best-effort */ });

        const pauseMsg = JSON.stringify({ type: TRANSFER_MSG.PAUSE });
        this.channelManager.sendAny(pauseMsg).catch(() => { /* noop */ });
    }

    /**
     * Resume the transfer after a pause.
     */
    resume() {
        if (!this._active || this._finalized) return;
        this._paused = false;
        this._lastChunkTime = Date.now();
        this._startStallTimer();

        const resumeMsg = JSON.stringify({ type: TRANSFER_MSG.RESUME });
        this.channelManager.sendAny(resumeMsg).catch(() => { /* noop */ });

        this._requestNextChunks();
    }

    /**
     * Resume with already-received chunk state (from ResumeManager).
     * Called after a reconnect to restore progress.
     * @param {string} fileId
     */
    async resumeFromStorage(fileId) {
        const state = await this.resumeManager.recoverFromStorage(fileId);
        if (state) {
            this._bytesReceived = state.receivedCount * this.fileMeta.chunkSize;
        }
    }

    /**
     * Get the list of missing chunk indices (delegates to ResumeManager).
     * @returns {number[]}
     */
    getMissingChunks() {
        return this.resumeManager.getMissingChunks(this.fileMeta.fileId);
    }

    // ── Private ────────────────────────────────────────────────

    async _handleChunkData(index, data) {
        // Guard: don't process chunks after finalization or cancel
        if (!this._active || this._finalized) return;

        const meta = this._pendingMeta.get(index);
        this._pendingMeta.delete(index);
        this.inFlight.delete(index);

        // RTT sample: request → arrival (includes sender queuing, which is the
        // effective pipe latency the window has to cover).
        const requestedAt = this._requestedAt.get(index);
        this._requestedAt.delete(index);
        if (requestedAt) {
            const sample = Date.now() - requestedAt;
            this._rttEwma = this._rttEwma === null
                ? sample
                : 0.8 * this._rttEwma + 0.2 * sample;
        }

        // Reset stall timer on any chunk received
        this._lastChunkTime = Date.now();
        this._resetStallTimer();

        if (!meta) {
            // No metadata arrived yet — re-request this chunk
            this._requestChunk(index);
            return;
        }

        // Duplicate chunk guard (ResumeManager is the source of truth)
        if (this.resumeManager.hasChunk(this.fileMeta.fileId, index)) {
            // Already have this chunk — skip without error
            this._requestNextChunks();
            return;
        }

        // Decrypt (no-op if no session key). A GCM auth failure throws — treat it
        // exactly like a hash mismatch (tampered/corrupted chunk → retry).
        // Then decompress (no-op unless the sender flagged this chunk compressed);
        // both size and hash are committed over the PLAINTEXT, so we must undo the
        // wire compression before verifying. A decompress failure (corrupt deflate
        // stream) is treated the same as a decrypt failure → integrity check fails
        // → chunk is re-requested.
        let plaintext;
        try {
            plaintext = this.cryptoKey
                ? await CryptoEngine.decryptChunk(this.cryptoKey, data)
                : data;
            plaintext = await maybeDecompress(plaintext, meta.compressed);
        } catch {
            plaintext = null;
        }

        // Verify integrity against the plaintext hash committed by the sender.
        const isValid = plaintext !== null && await IntegrityVerifier.verifyChunk(plaintext, meta.hash);
        if (!isValid) {
            const retries = this.retryCount.get(index) || 0;
            if (retries < MAX_RETRY_COUNT) {
                this.retryCount.set(index, retries + 1);
                console.warn(`[Receiver] Chunk ${index} integrity failed, retry ${retries + 1}`);
                this._requestChunk(index);
            } else {
                this.onError(
                    new Error(`Chunk ${index} failed integrity check after ${MAX_RETRY_COUNT} retries`)
                );
                this.stop();
            }
            return;
        }

        // Write decrypted chunk to storage
        try {
            await this.storageManager.writeChunk(index, plaintext);
        } catch (err) {
            this.onError(err);
            this.stop();
            return;
        }

        // Mark as received in ResumeManager (persisted via debounce)
        this.resumeManager.markChunkReceived(this.fileMeta.fileId, index);
        // Record the hash for the whole-file manifest root. verifyChunk above already
        // proved meta.hash IS the plaintext's hash, so store it directly instead of
        // hashing the chunk a second time (one SHA-256 per chunk saved on the hot path).
        this.verifier.recordChunkHash(index, meta.hash);

        this._bytesReceived += plaintext.byteLength;

        // Report progress — pass actual chunk index for accurate resume tracking
        const received = this.resumeManager.getProgress(this.fileMeta.fileId) / 100 * this.totalChunks;
        const elapsed = (Date.now() - this._startTime) / 1000;
        const speed = elapsed > 0 ? this._bytesReceived / elapsed : 0;
        this._updateWindow(speed);
        this.onProgress(Math.round(received), this.totalChunks, speed, index);

        // All chunks present — verify before declaring success. We do NOT finalize on
        // chunk count alone.
        if (this.resumeManager.isComplete(this.fileMeta.fileId)) {
            // Fast path for single-chunk files (the common "small file" case): the
            // whole-file manifest root over one chunk is just a function of that
            // chunk's hash, which the sender already committed in CHUNK_DATA and we
            // already verified against the decrypted bytes above. There is no
            // reordering or missing-chunk substitution to catch, so the manifest
            // request/response adds a full round-trip of latency with no extra
            // assurance. Skip it and finalize immediately. Multi-chunk files still
            // verify the Merkle root.
            if (this.totalChunks <= 1) {
                this._finalize(null);
            } else {
                this._requestManifest();
            }
            return;
        }

        // Request more chunks if not paused
        if (!this._paused) {
            this._requestNextChunks();
        }
    }

    /**
     * Adapt the pull window to the measured bandwidth-delay product. Keeping
     * ~1.5×BDP of chunks requested-but-unarrived is what keeps the pipe full as
     * RTT and capacity vary (multi-connection striping raises capacity; TURN or
     * cross-continent paths raise RTT). Clamped to [MAX_IN_FLIGHT, MAX_IN_FLIGHT_CAP]
     * so a noisy sample can never stall (floor) or blow up memory (cap).
     * @param {number} bytesPerSec current observed throughput
     */
    _updateWindow(bytesPerSec) {
        if (!this._rttEwma || !bytesPerSec) return;
        const bdpChunks = (bytesPerSec * (this._rttEwma / 1000)) / this.fileMeta.chunkSize;
        this._window = Math.min(
            MAX_IN_FLIGHT_CAP,
            Math.max(MAX_IN_FLIGHT, Math.ceil(bdpChunks * 1.5))
        );
    }

    _requestNextChunks() {
        if (!this._active || this._paused || this._finalized) return;

        const missing = this.getMissingChunks();
        const slotsAvailable = this._window - this.inFlight.size;
        if (slotsAvailable <= 0) return;

        // Select the window of not-yet-in-flight chunks to request now. The adaptive
        // window remains the cap on the EXPANDED chunk count regardless of how the
        // request is framed (sparse post-reload gaps just produce more, shorter ranges).
        const toRequest = [];
        for (let i = 0; i < missing.length && toRequest.length < slotsAvailable; i++) {
            if (!this.inFlight.has(missing[i])) toRequest.push(missing[i]);
        }
        if (toRequest.length === 0) return;

        if (this._supportsRange) {
            this._requestChunkRange(toRequest);
        } else {
            for (const index of toRequest) this._requestChunk(index);
        }
    }

    _requestChunk(index) {
        this.inFlight.add(index);
        this._requestedAt.set(index, Date.now());
        this._chunkRequests++;
        const msg = JSON.stringify({
            type: TRANSFER_MSG.CHUNK_REQUEST,
            index,
        });

        this.channelManager.sendAny(msg).catch((err) => {
            console.error(`[Receiver] Failed to request chunk ${index}:`, err);
            this.inFlight.delete(index);
            this._requestedAt.delete(index);
        });
    }

    /**
     * Request a set of chunks as a coalesced range-list in a single control frame.
     * The set may be sparse (e.g. resume gaps) → multiple ranges; contiguous → one.
     * @param {number[]} indices
     */
    _requestChunkRange(indices) {
        const ranges = chunksToRanges(indices);
        const now = Date.now();
        for (const index of indices) {
            this.inFlight.add(index);
            this._requestedAt.set(index, now);
        }
        this._chunkRequests += indices.length;

        const msg = JSON.stringify({
            type: TRANSFER_MSG.CHUNK_REQUEST_RANGE,
            ranges,
        });

        this.channelManager.sendAny(msg).catch((err) => {
            console.error('[Receiver] Failed to request chunk range:', err);
            for (const index of indices) {
                this.inFlight.delete(index);
                this._requestedAt.delete(index);
            }
        });
    }

    /**
     * Request the whole-file manifest root from the sender (idempotent).
     */
    _requestManifest() {
        if (this._finalized || this._awaitingManifest) return;
        this._awaitingManifest = true;
        this._clearStallTimer();

        const msg = JSON.stringify({ type: TRANSFER_MSG.MANIFEST_REQUEST });
        this.channelManager.sendAny(msg).catch(() => { /* retried by timeout */ });

        // Re-request if the manifest doesn't arrive (e.g. dropped on the wire).
        this._manifestTimer = setInterval(() => {
            if (this._finalized) { clearInterval(this._manifestTimer); return; }
            this.channelManager.sendAny(msg).catch(() => {});
        }, STALL_TIMEOUT_MS);
    }

    /**
     * Receive the sender's manifest root and finalize with whole-file verification.
     * @param {string} senderRoot
     */
    async _verifyManifestAndFinalize(senderRoot) {
        if (this._finalized) return;
        if (this._manifestTimer) { clearInterval(this._manifestTimer); this._manifestTimer = null; }
        await this._finalize(senderRoot);
    }

    /**
     * Compute the whole-file manifest root from the FINAL assembled file (re-chunked
     * and re-hashed). Computing from storage — rather than the in-memory per-chunk
     * hashes — makes verification correct even after a resume, where chunks received
     * in a prior session were never hashed in this process.
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    async _computeRootFromBlob(blob) {
        const chunkSize = this.fileMeta.chunkSize;
        const total = Math.ceil(blob.size / chunkSize) || 0;
        const hashes = [];
        for (let i = 0; i < total; i++) {
            const slice = blob.slice(i * chunkSize, Math.min((i + 1) * chunkSize, blob.size));
            hashes.push(await IntegrityVerifier.hash(await slice.arrayBuffer()));
        }
        const { rootHash } = await FileManifest.buildFromHashes(hashes);
        return rootHash;
    }

    /**
     * Compute the whole-file root for verification. Prefer the per-chunk hashes already
     * recorded this session (verified against the sender as each chunk landed): they give
     * the identical root without re-reading the whole file from storage. For a multi-GB
     * file that re-read is a second full pass over disk — slow, and it reopens the window
     * where an OPFS/disk-backed blob read can throw NotFoundError and lose a completed
     * transfer. Only when hashes are missing (a resumed transfer whose earlier chunks were
     * hashed in a prior process) do we fall back to re-reading the assembled blob.
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    async _computeRoot(blob) {
        const ordered = this.verifier.getOrderedHashes(this.totalChunks);
        if (ordered.length === this.totalChunks && ordered.every((h) => h)) {
            const { rootHash } = await FileManifest.buildFromHashes(ordered);
            return rootHash;
        }
        return this._computeRootFromBlob(blob);
    }

    /**
     * Assemble the file, verify the whole-file manifest root, and only then hand the
     * blob to the caller. A root mismatch (missing/reordered/substituted data) fails
     * loudly rather than delivering a corrupt file.
     * @param {string|null} expectedRoot - sender's committed root (null = skip, legacy)
     */
    async _finalize(expectedRoot = null) {
        if (this._finalized) return; // guard against double-finalize
        this._finalized = true;
        this._active = false;
        this._clearStallTimer();
        if (this._manifestTimer) { clearInterval(this._manifestTimer); this._manifestTimer = null; }

        try {
            const fileBlob = await this.storageManager.assembleFile();

            if (expectedRoot) {
                const actualRoot = await this._computeRoot(fileBlob);
                if (actualRoot !== expectedRoot) {
                    this.onError(new Error('Whole-file verification failed: manifest root mismatch'));
                    return;
                }
            }

            // Clear resume state only on a verified, successful completion
            await this.resumeManager.clear(this.fileMeta.fileId);
            this.onComplete(fileBlob);
        } catch (err) {
            this.onError(err);
        }
    }

    // ── Stall Detection ────────────────────────────────────────

    _startStallTimer() {
        this._clearStallTimer();
        this._stallTimer = setInterval(() => this._checkForStall(), 2000);
    }

    _resetStallTimer() {
        // Reset is handled by updating _lastChunkTime; the interval keeps running
        this._lastChunkTime = Date.now();
    }

    _clearStallTimer() {
        if (this._stallTimer) {
            clearInterval(this._stallTimer);
            this._stallTimer = null;
        }
    }

    _checkForStall() {
        if (!this._active || this._paused || this._finalized) return;
        if (this.inFlight.size === 0) return; // nothing in-flight — normal

        const timeSinceLastChunk = Date.now() - (this._lastChunkTime || Date.now());
        if (timeSinceLastChunk > STALL_TIMEOUT_MS) {
            console.warn('[Receiver] Transfer stalled — re-requesting in-flight chunks');

            // Re-request all in-flight chunks
            const stalledChunks = Array.from(this.inFlight);
            this._retransmits += stalledChunks.length;
            this.inFlight.clear();
            for (const idx of stalledChunks) {
                this._requestChunk(idx);
            }

            this._lastChunkTime = Date.now();

            if (this.onStalled) {
                this.onStalled();
            }
        }
    }
}
