import { Sender } from './Sender.js';
import {
    TRANSFER_MSG,
    TRANSFER_TYPE,
    RECEIVE_APPROVAL_TIMEOUT_MS,
} from '@shared/constants.js';

/** Derive the transfer type for the approval summary from a batch descriptor. */
function deriveTransferType(batch) {
    const hasDirs = (batch.directories?.length ?? 0) > 0;
    const fileCount = batch.totalFiles ?? 0;
    if (hasDirs && fileCount > 0) return TRANSFER_TYPE.MIXED;
    if (hasDirs) return TRANSFER_TYPE.FOLDER;
    return TRANSFER_TYPE.FILES;
}

/**
 * BatchSender — orchestrates sending a batch (one or more files and/or folders)
 * over a single channel, reusing the existing per-file {@link Sender} engine.
 *
 * Why a coordinator: the per-file Sender owns the channel's message handler (it
 * listens for CHUNK_REQUEST etc.). To send many files over one channel we let the
 * BatchSender own the *real* channel handler and hand each Sender a thin facade
 * whose `onMessage` registers with the coordinator instead. The coordinator then:
 *   - sends a BATCH_META preamble describing the whole batch,
 *   - streams each file strictly sequentially (FILE_META → chunk pull → MANIFEST),
 *   - waits for the receiver's per-file FILE_COMPLETE ack before starting the next
 *     file (this is the fix for the old bug where the sender blasted every
 *     FILE_META at once and only the last file was actually served),
 *   - emits a BATCH_COMPLETE when done.
 *
 * The wire protocol per file is unchanged, so encryption, resume, chunking and
 * whole-file manifest verification all keep working untouched — this layer sits
 * strictly above them.
 */
export class BatchSender {
    /**
     * @param {{ files: {file: File, relativePath: string, size: number}[], directories: string[], totalFiles: number, totalBytes: number, name: string }} batch
     * @param {object} channelManager - ChannelManager or RelayChannel
     * @param {CryptoKey|null} cryptoKey
     * @param {object} callbacks
     * @param {Function} callbacks.onFileProgress - (fileIndex, sent, total, speed, file) => void
     * @param {Function} callbacks.onBatchProgress - (bytesSent, totalBytes) => void
     * @param {Function} callbacks.onComplete - () => void
     * @param {Function} callbacks.onError - (err) => void
     * @param {Function} [callbacks.onCancel] - () => void
     * @param {Function} [callbacks.onAwaitingApproval] - () => void, fired once the
     *        offer (BATCH_META) is sent and the sender is blocked on the receiver's
     *        accept/reject decision.
     * @param {Function} [callbacks.onRejected] - () => void, receiver declined.
     * @param {object} [options]
     * @param {{ deviceId: string, deviceName: string }} [options.identity] - this
     *        device's announced identity, shown in the receiver's approval prompt.
     * @param {string} [options.transferType] - one of TRANSFER_TYPE (auto-derived
     *        from the batch when omitted; callers sending text pass TEXT explicitly).
     * @param {string} [options.textFormat] - for TEXT transfers, the TEXT_FORMAT.
     */
    constructor(batch, channelManager, cryptoKey, callbacks, options = {}) {
        this.batch = batch;
        this.cm = channelManager;
        this.cryptoKey = cryptoKey;
        this.cb = callbacks;
        this.batchId = _randomId();
        this.identity = options.identity || null;
        this.transferType = options.transferType || deriveTransferType(batch);
        this.textFormat = options.textFormat || null;

        this._active = false;
        this._cancelled = false;
        /** @type {Function|null} the active per-file Sender's message handler */
        this._activeHandler = null;
        /** @type {{ resolve: Function, reject: Function, fileId: string }|null} */
        this._fileGate = null;
        this._completedBytes = 0;
        /** @type {Sender|null} */
        this._activeSender = null;
        /** @type {{ resolve: Function, reject: Function }|null} approval gate */
        this._approvalGate = null;
        this._approvalTimer = null;
    }

    /** Begin the batch. Resolves when every file is delivered and acked. */
    async start() {
        this._active = true;
        this.cm.onMessage((raw) => this._route(raw));

        // Announce the batch up front so the receiver can render an accurate
        // approval summary (sender identity, type, file/folder count, total size)
        // and size its buffers. No file data is requested or sent until the receiver
        // explicitly accepts — see the approval gate below.
        await this.cm.sendAny(JSON.stringify({
            type: TRANSFER_MSG.BATCH_META,
            batchId: this.batchId,
            name: this.batch.name,
            totalFiles: this.batch.totalFiles,
            totalBytes: this.batch.totalBytes,
            fileCount: this.batch.totalFiles,
            folderCount: this.batch.directories.length,
            transferType: this.transferType,
            textFormat: this.textFormat,
            senderDeviceId: this.identity?.deviceId ?? null,
            senderName: this.identity?.deviceName ?? null,
            senderDeviceType: this.identity?.deviceType ?? null,
            senderPlatform: this.identity?.platform ?? null,
            directories: this.batch.directories,
            files: this.batch.files.map((f) => ({ relativePath: f.relativePath, size: f.size })),
        }));

        // ── Receive-confirmation gate (Feature 4) ──────────────────────
        // Block until the receiver accepts. A silent/absent peer can't pin the
        // offer open indefinitely: it expires after RECEIVE_APPROVAL_TIMEOUT_MS.
        try {
            this.cb.onAwaitingApproval?.();
            await this._awaitApproval();
        } catch (err) {
            this._active = false;
            this._clearApprovalTimer();
            if (this._cancelled) return;
            if (err?.rejected) { this.cb.onRejected?.(); return; }
            this.cb.onError?.(err);
            return;
        }
        if (!this._active || this._cancelled) return;

        try {
            for (let i = 0; i < this.batch.files.length; i++) {
                if (!this._active || this._cancelled) return;
                await this._sendFile(i);
                this._completedBytes += this.batch.files[i].size;
                this.cb.onBatchProgress?.(this._completedBytes, this.batch.totalBytes);
            }

            await this.cm.sendAny(JSON.stringify({
                type: TRANSFER_MSG.BATCH_COMPLETE,
                batchId: this.batchId,
            })).catch(() => { /* receiver already finalized */ });

            this._active = false;
            this.cb.onComplete?.();
        } catch (err) {
            this._active = false;
            if (!this._cancelled) this.cb.onError?.(err);
        }
    }

    /** Loss stats of the file currently being sent (for diagnostics). */
    getLossStats() {
        return this._activeSender?.getLossStats?.() ?? null;
    }

    stop() {
        this._active = false;
        this._clearApprovalTimer();
        this._activeSender?.stop();
        if (this._approvalGate) {
            const gate = this._approvalGate;
            this._approvalGate = null;
            gate.reject(new Error('Batch stopped'));
        }
        if (this._fileGate) {
            this._fileGate.reject(new Error('Batch stopped'));
            this._fileGate = null;
        }
    }

    /** Resolve when the receiver accepts; reject on decline or expiry. */
    _awaitApproval() {
        return new Promise((resolve, reject) => {
            this._approvalGate = { resolve, reject };
            this._approvalTimer = setTimeout(() => {
                if (!this._approvalGate) return;
                this._approvalGate = null;
                this._approvalTimer = null;
                reject(new Error('The receiver did not respond to the transfer request in time.'));
            }, RECEIVE_APPROVAL_TIMEOUT_MS);
        });
    }

    _clearApprovalTimer() {
        if (this._approvalTimer) { clearTimeout(this._approvalTimer); this._approvalTimer = null; }
    }

    // ── Per-file send ──────────────────────────────────────────────
    _sendFile(index) {
        const entry = this.batch.files[index];
        const facade = this._makeFacade();

        const sender = new Sender(
            entry.file,
            facade,
            (sent, total, speed) => {
                this.cb.onFileProgress?.(index, sent, total, speed, entry);
                const fraction = total > 0 ? sent / total : 0;
                this.cb.onBatchProgress?.(
                    this._completedBytes + fraction * entry.size,
                    this.batch.totalBytes
                );
            },
            () => { /* per-file cancel handled at batch level */ },
            (err) => {
                if (this._fileGate) {
                    const gate = this._fileGate;
                    this._fileGate = null;
                    gate.reject(err);
                }
            },
            this.cryptoKey
        );
        this._activeSender = sender;

        const meta = sender.getFileMeta();
        const fileId = meta.fileId;

        return new Promise((resolve, reject) => {
            this._fileGate = { resolve, reject, fileId };

            // FILE_META carries the sanitized relativePath + batch context so the
            // receiver can place the file in the reconstructed tree.
            this.cm.send(0, JSON.stringify({
                type: TRANSFER_MSG.FILE_META,
                ...meta,
                relativePath: entry.relativePath,
                batchId: this.batchId,
                fileIndex: index,
                isLast: index === this.batch.files.length - 1,
                // Capability advert: this sender understands CHUNK_REQUEST_RANGE, so a
                // range-capable receiver may coalesce pulls. Old receivers ignore it
                // and use per-chunk CHUNK_REQUEST (which this sender still serves).
                supportsRangeRequest: true,
            })).then(() => {
                sender.start();
            }).catch(reject);
        }).finally(() => {
            sender.stop();
            this._activeSender = null;
            this._activeHandler = null;
        });
    }

    _makeFacade() {
        const realCm = this.cm;
        return {
            onMessage: (h) => { this._activeHandler = h; },
            send: (idx, data) => realCm.send(idx, data),
            sendAny: (data) => realCm.sendAny(data),
            getChannelStats: () => realCm.getChannelStats(),
            resetStats: () => realCm.resetStats?.(),
        };
    }

    // ── Channel routing ────────────────────────────────────────────
    _route(raw) {
        if (typeof raw === 'string') {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            if (msg.type === TRANSFER_MSG.RECEIVE_ACCEPT) {
                if (this._approvalGate) {
                    const gate = this._approvalGate;
                    this._approvalGate = null;
                    this._clearApprovalTimer();
                    gate.resolve();
                }
                return;
            }
            if (msg.type === TRANSFER_MSG.RECEIVE_REJECT) {
                if (this._approvalGate) {
                    const gate = this._approvalGate;
                    this._approvalGate = null;
                    this._clearApprovalTimer();
                    const err = new Error('The receiver declined the transfer.');
                    err.rejected = true;
                    gate.reject(err);
                }
                return;
            }
            if (msg.type === TRANSFER_MSG.FILE_COMPLETE) {
                // Receiver finished and verified one file → advance the batch.
                if (this._fileGate && (!msg.fileId || msg.fileId === this._fileGate.fileId)) {
                    const gate = this._fileGate;
                    this._fileGate = null;
                    gate.resolve();
                }
                return;
            }
            if (msg.type === TRANSFER_MSG.CANCEL) {
                this._cancelled = true;
                this._active = false;
                this._activeSender?.stop();
                if (this._fileGate) {
                    const gate = this._fileGate;
                    this._fileGate = null;
                    gate.reject(new Error('Transfer cancelled by receiver'));
                }
                this.cb.onCancel?.();
                return;
            }
        }
        // Everything else (CHUNK_REQUEST / NACK / MANIFEST_REQUEST / PAUSE / RESUME
        // and any binary) belongs to the active per-file Sender.
        this._activeHandler?.(raw);
    }
}

function _randomId() {
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
