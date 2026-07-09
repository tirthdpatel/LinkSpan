import { Receiver } from './Receiver.js';
import { buildZip } from './ZipBuilder.js';
import { sanitizeRelativePath, sanitizeDirectoryPath } from './PathSanitizer.js';
import {
    TRANSFER_MSG,
    MAX_BATCH_FILES,
    MAX_BATCH_DIRECTORIES,
    MAX_BATCH_BYTES,
} from '@shared/constants.js';

/**
 * BatchReceiver — receives a batch (one or more files / folders) over a single
 * channel, reusing the per-file {@link Receiver} engine, and reconstructs the
 * original directory tree.
 *
 * It is the sole owner of the channel's message handler. Each per-file Receiver is
 * handed a facade whose `onMessage` registers with this coordinator, so chunk
 * traffic is routed to the file currently being received while batch-level control
 * messages (BATCH_META / FILE_META / BATCH_COMPLETE) are handled here.
 *
 * Security: every path that arrives from the (untrusted) sender — in BATCH_META and
 * again in each FILE_META — is re-sanitized here (PathSanitizer) before it is used
 * to key the file map or name a ZIP entry. A crafted sender cannot cause a
 * traversal write. Batch ceilings (file count, directory count, total bytes) are
 * enforced on receipt to bound memory/disk against a hostile sender.
 *
 * Reconstruction:
 *   - a single loose file → handed back as-is (unchanged single-file UX),
 *   - anything else (multiple files and/or any directory) → packaged into one ZIP
 *     that unpacks to the exact tree, including empty directories.
 */
export class BatchReceiver {
    /**
     * @param {object} channelManager - ChannelManager or RelayChannel
     * @param {Promise<CryptoKey|null>} keyPromise - resolves with the session key
     *        once ECDH + SAS confirmation complete (per-file receivers wait on it)
     * @param {object} callbacks
     * @param {Function} [callbacks.onBatchMeta] - (descriptor) => void
     * @param {Function} [callbacks.onFileProgress] - (fileIndex, relPath, received, total, speed) => void
     * @param {Function} [callbacks.onBatchProgress] - (bytesReceived, totalBytes) => void
     * @param {Function} [callbacks.onFileComplete] - (fileIndex, relPath) => void
     * @param {Function} callbacks.onComplete - (blob, name, isArchive) => void
     * @param {Function} callbacks.onError - (err) => void
     * @param {Function} [callbacks.onStalled] - () => void
     * @param {object} [factories]
     * @param {Function} [factories.makeStorage] - () => StorageManager-like
     * @param {Function} [factories.makeResume]  - () => ResumeManager-like
     */
    constructor(channelManager, keyPromise, callbacks, factories = {}) {
        this.cm = channelManager;
        this.keyPromise = keyPromise;
        this.cb = callbacks;
        this.makeStorage = factories.makeStorage;
        this.makeResume = factories.makeResume;
        // Optional download-location support (Feature 5). When getDestination yields
        // a directory handle, the reconstructed tree is written straight to disk
        // (preserving structure) instead of being packaged into a ZIP for download.
        this.getDestination = factories.getDestination || null;
        this.writeTree = factories.writeTree || null;

        this._active = false;
        this._finalized = false;
        this._approved = false;
        /** @type {Function|null} active per-file Receiver handler */
        this._activeHandler = null;
        /** @type {object|null} batch descriptor from BATCH_META */
        this._meta = null;
        /** @type {Map<string, Blob>} relativePath → assembled file blob */
        this._results = new Map();
        this._receivedFiles = 0;
        this._bytesReceived = 0;
        /** @type {Receiver|null} */
        this._activeReceiver = null;
    }

    start() {
        this._active = true;
        this.cm.onMessage((raw) => this._route(raw));
    }

    /** Loss stats of the file currently being received (for diagnostics). */
    getLossStats() {
        return this._activeReceiver?.getLossStats?.() ?? null;
    }

    stop() {
        this._active = false;
        this._activeReceiver?.stop();
    }

    cancel() {
        this._active = false;
        this._activeReceiver?.cancel?.();
        this.cm.sendAny(JSON.stringify({ type: TRANSFER_MSG.CANCEL })).catch(() => {});
    }

    // ── Routing ────────────────────────────────────────────────────
    async _route(raw) {
        if (!this._active) return;
        if (typeof raw === 'string') {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            switch (msg.type) {
                case TRANSFER_MSG.BATCH_META:
                    this._handleBatchMeta(msg);
                    return;
                case TRANSFER_MSG.FILE_META:
                    await this._startFile(msg);
                    return;
                case TRANSFER_MSG.BATCH_COMPLETE:
                    this._maybeFinalize();
                    return;
                default:
                    this._activeHandler?.(raw);
                    return;
            }
        }
        // Binary chunk → active per-file receiver.
        this._activeHandler?.(raw);
    }

    _handleBatchMeta(msg) {
        try {
            const totalFiles = Number(msg.totalFiles) || 0;
            const totalBytes = Number(msg.totalBytes) || 0;
            const rawDirs = Array.isArray(msg.directories) ? msg.directories : [];
            const rawFiles = Array.isArray(msg.files) ? msg.files : [];

            if (totalFiles > MAX_BATCH_FILES) throw new Error('Batch exceeds file limit');
            if (rawDirs.length > MAX_BATCH_DIRECTORIES) throw new Error('Batch exceeds directory limit');
            if (totalBytes > MAX_BATCH_BYTES) throw new Error('Batch exceeds size limit');

            const directories = rawDirs.map((d) => sanitizeDirectoryPath(d)).filter(Boolean);
            const files = rawFiles.map((f) => ({
                relativePath: sanitizeRelativePath(f.relativePath),
                size: Number(f.size) || 0,
            }));

            this._meta = {
                batchId: msg.batchId,
                name: typeof msg.name === 'string' ? msg.name : 'transfer',
                totalFiles,
                totalBytes,
                fileCount: Number(msg.fileCount) || totalFiles,
                folderCount: Number(msg.folderCount) || directories.length,
                transferType: typeof msg.transferType === 'string' ? msg.transferType : null,
                textFormat: typeof msg.textFormat === 'string' ? msg.textFormat : null,
                senderName: sanitizeLabel(msg.senderName) || 'Unknown sender',
                senderDeviceId: typeof msg.senderDeviceId === 'string' ? msg.senderDeviceId : null,
                senderDeviceType: sanitizeLabel(msg.senderDeviceType) || null,
                senderPlatform: sanitizeLabel(msg.senderPlatform) || null,
                directories,
                files,
            };
            this.cb.onBatchMeta?.(this._meta);

            // ── Receive-confirmation gate (Feature 4) ──────────────────
            // Ask the user (or an auto-approval policy) to accept before any file
            // data is requested. No CHUNK_REQUEST is ever sent until we accept.
            this._requestApproval(this._meta);
        } catch (err) {
            this._fail(err);
        }
    }

    /**
     * Resolve the approval decision and notify the sender. Delegates to the
     * `requestApproval(meta) -> Promise<{accept, remember}>` callback when provided
     * (the UI surfaces a prompt and may consult remembered-device policy); falls
     * back to auto-accept when no policy is wired (e.g. headless/test use).
     */
    async _requestApproval(meta) {
        let decision = { accept: true, remember: false };
        if (typeof this.cb.requestApproval === 'function') {
            try {
                decision = (await this.cb.requestApproval(meta)) || { accept: false };
            } catch {
                decision = { accept: false };
            }
        }
        if (this._finalized || !this._active) return;

        if (!decision.accept) {
            this.cm.sendAny(JSON.stringify({ type: TRANSFER_MSG.RECEIVE_REJECT })).catch(() => {});
            this._approved = false;
            this._finalized = true;
            this._active = false;
            this.cb.onRejected?.(meta);
            return;
        }

        this._approved = true;
        this.cb.onApproved?.(meta, decision);
        await this.cm.sendAny(JSON.stringify({ type: TRANSFER_MSG.RECEIVE_ACCEPT })).catch(() => {});

        // A batch of only empty directories has no files to wait for.
        if (meta.totalFiles === 0) this._maybeFinalize();
    }

    async _startFile(meta) {
        if (this._finalized || !this._approved) return;
        let relativePath;
        try {
            // Re-sanitize the per-file path independently of BATCH_META.
            relativePath = sanitizeRelativePath(meta.relativePath ?? meta.fileName);
        } catch (err) {
            this._fail(err);
            return;
        }

        const cryptoKey = await this.keyPromise;
        if (!this._active || this._finalized) return;

        const storage = this.makeStorage();
        const resume = this.makeResume();
        const fileIndex = Number(meta.fileIndex) || 0;
        const facade = this._makeFacade();

        const receiver = new Receiver(
            meta,
            facade,
            storage,
            resume,
            (received, total, speed) => {
                this.cb.onFileProgress?.(fileIndex, relativePath, received, total, speed);
                const fileBytes = total > 0 ? (received / total) * (meta.fileSize || 0) : 0;
                this.cb.onBatchProgress?.(this._bytesReceived + fileBytes, this._meta?.totalBytes ?? 0);
            },
            async (blob) => {
                // File verified & assembled.
                this._results.set(relativePath, blob);
                this._receivedFiles += 1;
                this._bytesReceived += meta.fileSize || blob.size;
                this._activeHandler = null;
                this._activeReceiver = null;
                this.cb.onFileComplete?.(fileIndex, relativePath);

                // Ack so the sender advances to the next file.
                this.cm.sendAny(JSON.stringify({
                    type: TRANSFER_MSG.FILE_COMPLETE,
                    fileId: meta.fileId,
                })).catch(() => {});

                this._maybeFinalize();
            },
            (err) => this._fail(err),
            () => this.cb.onStalled?.(),
            cryptoKey
        );
        this._activeReceiver = receiver;

        await receiver.start();
    }

    _makeFacade() {
        const realCm = this.cm;
        return {
            onMessage: (h) => { this._activeHandler = h; },
            sendAny: (data) => realCm.sendAny(data),
            send: (idx, data) => realCm.send(idx, data),
            getChannelStats: () => realCm.getChannelStats(),
            resetStats: () => realCm.resetStats?.(),
        };
    }

    // ── Finalization ───────────────────────────────────────────────
    _maybeFinalize() {
        if (this._finalized || !this._meta) return;
        if (this._receivedFiles < this._meta.totalFiles) return;
        this._finalized = true;
        this._active = false;
        this._reconstruct().catch((err) => this._fail(err));
    }

    async _reconstruct() {
        const { files, directories, name } = this._meta;

        // ── Download-location path (Feature 5) ─────────────────────────
        // If a destination directory was chosen, write the exact tree to disk
        // (structure + relative paths + filenames preserved). Falls back to the
        // ZIP/download path on any error so a transfer is never lost.
        if (this.getDestination && this.writeTree) {
            try {
                const dirHandle = await this.getDestination();
                if (dirHandle) {
                    const entries = this._buildEntries(directories);
                    const stats = await this.writeTree(dirHandle, entries);
                    this.cb.onComplete(null, name, false, {
                        writtenToDisk: true,
                        location: dirHandle.name || 'selected folder',
                        files: stats?.files ?? files.length,
                        directories: stats?.directories ?? directories.length,
                    });
                    return;
                }
            } catch (err) {
                console.warn('[BatchReceiver] Direct-to-disk write failed, falling back to download:', err?.message);
            }
        }

        // Single loose file → return it directly (unchanged single-file experience).
        if (files.length === 1 && directories.length === 0) {
            const [only] = files;
            const blob = this._results.get(only.relativePath);
            const fileName = only.relativePath.split('/').pop();
            this.cb.onComplete(blob, fileName, false);
            return;
        }

        // Otherwise package the whole tree (including empty directories) into a ZIP.
        const entries = this._buildEntries(directories);
        const zipBlob = await buildZip(entries);
        const archiveName = `${sanitizeArchiveName(name)}.zip`;
        this.cb.onComplete(zipBlob, archiveName, true);
    }

    /** Build the ordered entry list (empty dirs + sorted files) for write/zip. */
    _buildEntries(directories) {
        const entries = [];
        for (const dir of directories) entries.push({ name: dir, dir: true });
        const sorted = [...this._results.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        for (const [relPath, blob] of sorted) entries.push({ name: relPath, blob });
        return entries;
    }

    _fail(err) {
        if (this._finalized) return;
        this._finalized = true;
        this._active = false;
        this._activeReceiver?.stop();
        this.cb.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
}

/** Clamp an untrusted display label (sender name) for safe rendering. */
function sanitizeLabel(value) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

/** Make a safe, friendly archive filename from a batch label. */
function sanitizeArchiveName(name) {
    const cleaned = String(name || 'linkspan')
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return cleaned || 'linkspan';
}
