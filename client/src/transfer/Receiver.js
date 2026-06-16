import {
    TRANSFER_MSG,
    MAX_IN_FLIGHT,
    MAX_RETRY_COUNT,
    STALL_TIMEOUT_MS,
} from '@shared/constants.js';
import { chunksToRanges } from '@shared/chunkRanges.js';
import { ChunkManager } from './ChunkManager.js';
import { IntegrityVerifier } from './IntegrityVerifier.js';
import { FileManifest } from './FileManifest.js';
import { CryptoEngine } from '../crypto/CryptoEngine.js';

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
        /** @type {Map<number, number>} chunk index → retry count */
        this.retryCount = new Map();
        /** @type {Map<number, { hash: string, size: number }>} pending hash metadata */
        this._pendingMeta = new Map();

        this._active = false;
        this._paused = false;
        this._finalized = false;
        this._startTime = null;
        this._bytesReceived = 0;
        this._lastChunkTime = null;
        this._stallTimer = null;
        this._awaitingManifest = false;
        this._manifestTimer = null;
    }

    // ── Public API ─────────────────────────────────────────────

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

        // Listen for incoming data
        this.channelManager.onMessage(async (rawData) => {
            if (!this._active) return;

            try {
                if (typeof rawData === 'string') {
                    const msg = JSON.parse(rawData);
                    if (msg.type === TRANSFER_MSG.CHUNK_DATA) {
                        // Store hash metadata, binary data comes next
                        this._pendingMeta.set(msg.index, { hash: msg.hash, size: msg.size });
                    } else if (msg.type === TRANSFER_MSG.RESUME_ACK) {
                        // Sender acknowledged resume — restart requesting from missing chunks
                        this._requestNextChunks();
                    } else if (msg.type === TRANSFER_MSG.MANIFEST) {
                        await this._verifyManifestAndFinalize(msg.rootHash);
                    }
                } else if (rawData instanceof ArrayBuffer) {
                    const { index, data } = ChunkManager.unpackChunk(rawData);
                    await this._handleChunkData(index, data);
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
        let plaintext;
        try {
            plaintext = this.cryptoKey
                ? await CryptoEngine.decryptChunk(this.cryptoKey, data)
                : data;
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
        // Awaited: the recorded hash feeds the whole-file manifest root, which must
        // be complete before we request/verify the manifest on the last chunk.
        await this.verifier.recordChunk(index, plaintext);

        this._bytesReceived += plaintext.byteLength;

        // Report progress — pass actual chunk index for accurate resume tracking
        const received = this.resumeManager.getProgress(this.fileMeta.fileId) / 100 * this.totalChunks;
        const elapsed = (Date.now() - this._startTime) / 1000;
        const speed = elapsed > 0 ? this._bytesReceived / elapsed : 0;
        this.onProgress(Math.round(received), this.totalChunks, speed, index);

        // All chunks present — request the whole-file manifest and verify before
        // declaring success. We do NOT finalize on chunk count alone.
        if (this.resumeManager.isComplete(this.fileMeta.fileId)) {
            this._requestManifest();
            return;
        }

        // Request more chunks if not paused
        if (!this._paused) {
            this._requestNextChunks();
        }
    }

    _requestNextChunks() {
        if (!this._active || this._paused || this._finalized) return;

        const missing = this.getMissingChunks();
        const slotsAvailable = MAX_IN_FLIGHT - this.inFlight.size;
        if (slotsAvailable <= 0) return;

        // Select the window of not-yet-in-flight chunks to request now. MAX_IN_FLIGHT
        // remains the cap on the EXPANDED chunk count regardless of how the request is
        // framed (sparse post-reload gaps just produce more, shorter ranges).
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
        const msg = JSON.stringify({
            type: TRANSFER_MSG.CHUNK_REQUEST,
            index,
        });

        this.channelManager.sendAny(msg).catch((err) => {
            console.error(`[Receiver] Failed to request chunk ${index}:`, err);
            this.inFlight.delete(index);
        });
    }

    /**
     * Request a set of chunks as a coalesced range-list in a single control frame.
     * The set may be sparse (e.g. resume gaps) → multiple ranges; contiguous → one.
     * @param {number[]} indices
     */
    _requestChunkRange(indices) {
        const ranges = chunksToRanges(indices);
        for (const index of indices) this.inFlight.add(index);

        const msg = JSON.stringify({
            type: TRANSFER_MSG.CHUNK_REQUEST_RANGE,
            ranges,
        });

        this.channelManager.sendAny(msg).catch((err) => {
            console.error('[Receiver] Failed to request chunk range:', err);
            for (const index of indices) this.inFlight.delete(index);
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
                const actualRoot = await this._computeRootFromBlob(fileBlob);
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
