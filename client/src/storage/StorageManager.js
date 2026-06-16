import { DB_VERSION, MAX_INMEMORY_ASSEMBLY_BYTES } from '@shared/constants.js';

// OPFS blob names created during THIS page session. Used so the stale-entry sweep (run at
// each transfer's init) never deletes a file the current session still needs — e.g. earlier
// files in a multi-file batch whose bytes are read later when the batch ZIP is assembled.
// Entries left over from a *prior* page load (a crashed/closed tab) are not in this set and
// get reclaimed. Module-scoped so it spans every StorageManager in one page session.
const _sessionOpfsNames = new Set();

/**
 * StorageManager — Tiered storage: File System Access API → OPFS → IndexedDB.
 * Handles chunk storage and final file assembly without loading full file into RAM.
 *
 * Key fixes from v1:
 * - Stable IndexedDB version (DB_VERSION constant, never Date.now())
 * - OPFS: writable stream opened once per file and reused across all chunks
 *   (was: opened & closed on every chunk — catastrophic perf regression)
 * - Corruption check: verifies written chunk count before assembly
 * - Proper IDB store name derivation without dynamic schema versioning
 */
export class StorageManager {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.allowFsApi=true] - when false, never use the File System
     *   Access API (which prompts a "Save As" dialog per file). Batch/folder receives
     *   set this false so files assemble to in-memory/OPFS blobs and the user is
     *   prompted at most once for the whole archive.
     */
    constructor(opts = {}) {
        const allowFsApi = opts.allowFsApi !== false;
        /** @type {'fsapi' | 'opfs' | 'idb'} */
        this.mode = this._detectMode(allowFsApi);
        this._fileMeta = null;

        // File System Access API
        /** @type {FileSystemWritableFileStream | null} */
        this._writableStream = null;
        /** @type {FileSystemFileHandle | null} */
        this._fileHandle = null;

        // OPFS — stream is kept open for the duration of the transfer
        /** @type {FileSystemSyncAccessHandle | null} (used in worker) or writable */
        this._opfsHandle = null;
        /** @type {FileSystemWritableFileStream | null} */
        this._opfsWritable = null;

        // IndexedDB
        /** @type {IDBDatabase | null} */
        this._db = null;
        this._dbName = 'linkspan-chunks';
        this._storeName = null;

        /** @type {Map<number, boolean>} */
        this._writtenChunks = new Map();
    }

    // ── Public API ─────────────────────────────────────────────

    /**
     * Initialize storage for a file transfer.
     * @param {object} fileMeta
     */
    async initFile(fileMeta) {
        // Fail fast on a transfer this browser cannot assemble. The OPFS/IDB paths build
        // the finished file as one in-memory Blob, so a multi-GB receive without the
        // streaming File System Access API would OOM the tab mid-transfer. Refusing up
        // front (before any bytes are pulled) gives the user an actionable error instead
        // of a crash. The FSAPI path streams to disk and is exempt.
        // Only the IndexedDB fallback still assembles the whole file in memory. The FSAPI
        // path streams to disk, and OPFS now returns a disk-backed File (see _assembleOPFS),
        // so both handle files larger than RAM. IDB is reached only on browsers lacking both
        // APIs; guard it so such a transfer fails fast with a clear message instead of OOMing.
        const size = Number(fileMeta?.fileSize);
        if (this.mode === 'idb' && Number.isFinite(size) && size > MAX_INMEMORY_ASSEMBLY_BYTES) {
            const gb = (n) => (n / (1024 * 1024 * 1024)).toFixed(1);
            throw new Error(
                `File too large for this browser (${gb(size)} GB > ${gb(MAX_INMEMORY_ASSEMBLY_BYTES)} GB limit). ` +
                'Use a Chromium-based browser (Chrome/Edge), which streams the download directly to disk.'
            );
        }

        this._fileMeta = fileMeta;
        this._writtenChunks.clear();

        if (this.mode === 'fsapi') {
            await this._initFSAPI(fileMeta);
        } else if (this.mode === 'opfs') {
            await this._initOPFS(fileMeta);
        } else {
            await this._initIDB(fileMeta);
        }
    }

    /**
     * Write a chunk to storage.
     * @param {number} index
     * @param {ArrayBuffer} data
     */
    async writeChunk(index, data) {
        if (this.mode === 'fsapi') {
            await this._writeFSAPI(index, data);
        } else if (this.mode === 'opfs') {
            await this._writeOPFS(index, data);
        } else {
            await this._writeIDB(index, data);
        }
        this._writtenChunks.set(index, true);
    }

    /**
     * Assemble the final file from stored chunks.
     * Verifies chunk count before assembly to catch corruption.
     * @returns {Promise<Blob>}
     */
    async assembleFile() {
        const expected = this._fileMeta?.totalChunks;
        if (expected && this._writtenChunks.size !== expected) {
            throw new Error(
                `Corruption detected: expected ${expected} chunks, have ${this._writtenChunks.size}`
            );
        }

        if (this.mode === 'fsapi') {
            if (this._writableStream) {
                await this._writableStream.close();
                this._writableStream = null;
            }
            if (this._fileHandle) {
                const file = await this._fileHandle.getFile();
                return file;
            }
            throw new Error('No file handle available');
        } else if (this.mode === 'opfs') {
            return this._assembleOPFS();
        } else {
            return this._assembleIDB();
        }
    }

    /**
     * Get set of written chunk indices (for resume).
     * @returns {Set<number>}
     */
    getWrittenChunks() {
        return new Set(this._writtenChunks.keys());
    }

    /**
     * Get the current storage mode.
     * @returns {'fsapi' | 'opfs' | 'idb'}
     */
    getMode() {
        return this.mode;
    }

    /**
     * Clean up storage handles. Call after transfer completes or is cancelled.
     */
    async cleanup() {
        if (this._writableStream) {
            try { await this._writableStream.close(); } catch { /* noop */ }
            this._writableStream = null;
        }
        if (this._opfsWritable) {
            try { await this._opfsWritable.close(); } catch { /* noop */ }
            this._opfsWritable = null;
        }
        if (this.mode === 'idb' && this._db) {
            this._db.close();
            this._db = null;
        }
        this._writtenChunks.clear();
    }

    // ── File System Access API ───────────────────────────────────

    async _initFSAPI(fileMeta) {
        this._fsapiWriteChain = Promise.resolve();
        try {
            this._fileHandle = await window.showSaveFilePicker({
                suggestedName: fileMeta.fileName,
                types: [
                    {
                        description: 'All Files',
                        accept: { 'application/octet-stream': [] },
                    },
                ],
            });
            this._writableStream = await this._fileHandle.createWritable();
        } catch (err) {
            console.warn('[StorageManager] FSAPI init failed, falling back to OPFS:', err.message);
            this.mode = 'opfs';
            await this._initOPFS(fileMeta);
        }
    }

    async _writeFSAPI(index, data) {
        if (!this._writableStream) throw new Error('No FSAPI writable stream');
        const offset = index * this._fileMeta.chunkSize;
        // Same parallel-channel race as _writeOPFS: serialize + write at an explicit
        // position so concurrent chunks don't interleave the shared cursor.
        this._fsapiWriteChain = (this._fsapiWriteChain || Promise.resolve()).then(() =>
            this._writableStream.write({ type: 'write', position: offset, data })
        );
        return this._fsapiWriteChain;
    }

    // ── OPFS (Origin Private File System) ────────────────────────
    // Fix: open ONE writable stream for the whole transfer and reuse it.
    // v1 opened + closed a new stream per chunk — O(n) stream opens for n chunks.

    async _initOPFS(fileMeta) {
        this._opfsWriteChain = Promise.resolve();
        try {
            const root = await navigator.storage.getDirectory();
            // Register this file's name BEFORE sweeping, then reclaim only stale entries from
            // prior page loads — never anything from this session (e.g. earlier batch files).
            _sessionOpfsNames.add(`linkspan-${fileMeta.fileId}`);
            await StorageManager._sweepStaleOPFS(root);
            this._opfsHandle = await root.getFileHandle(
                `linkspan-${fileMeta.fileId}`,
                { create: true }
            );
            // Open a single writable for the entire transfer
            this._opfsWritable = await this._opfsHandle.createWritable({ keepExistingData: true });
        } catch (err) {
            console.warn('[StorageManager] OPFS init failed, falling back to IDB:', err.message);
            this.mode = 'idb';
            await this._initIDB(fileMeta);
        }
    }

    async _writeOPFS(index, data) {
        if (!this._opfsWritable) throw new Error('No OPFS writable stream');
        const offset = index * this._fileMeta.chunkSize;
        // The transfer runs MAX_CHANNELS parallel channels, all calling this on the
        // single shared writable. A seek()+write() pair is not atomic, so concurrent
        // chunks interleave the stream's one implicit cursor and land at the wrong
        // offset → a corrupt file that fails whole-file manifest verification. Serialize
        // the writes on a per-instance chain and use an explicit position so each chunk
        // is written at its true offset regardless of ordering. (Stream stays open and
        // is reused for all chunks; closed in _assembleOPFS.)
        this._opfsWriteChain = (this._opfsWriteChain || Promise.resolve()).then(() =>
            this._opfsWritable.write({ type: 'write', position: offset, data })
        );
        return this._opfsWriteChain;
    }

    async _assembleOPFS() {
        // Close the writable before reading.
        if (this._opfsWritable) {
            await this._opfsWritable.close();
            this._opfsWritable = null;
        }
        if (!this._opfsHandle) throw new Error('No OPFS file handle');

        // Return the DISK-BACKED file directly — do NOT read it into memory. The whole-file
        // manifest verification (slice-by-slice), the batch ZIP builder, and the download all
        // read this blob lazily, so keeping it on disk is what lets the receiver handle files
        // larger than RAM. The previous path called file.arrayBuffer(), materializing the
        // entire file (and throwing RangeError past ~2 GB).
        //
        // Deliberately NOT deleting the OPFS entry here: the returned blob is read AFTER this
        // returns (verification, ZIP composition, the in-flight download via createObjectURL),
        // and a File whose backing entry was removed throws NotFoundError on read — the race
        // that previously forced the in-memory copy. Stale entries are instead reclaimed at
        // the NEXT transfer's init (_sweepStaleOPFS), which never touches this session's files,
        // so every file in a multi-file batch stays readable until its ZIP is assembled.
        return this._opfsHandle.getFile();
    }

    /**
     * Reclaim OPFS blobs left over from a PRIOR page session (e.g. a tab that crashed or
     * closed mid-transfer). Never removes entries created in the current session — those may
     * still be read (an earlier batch file feeding the ZIP, or an in-flight download).
     * @param {FileSystemDirectoryHandle} root
     */
    static async _sweepStaleOPFS(root) {
        try {
            const stale = [];
            for await (const name of root.keys()) {
                if (name.startsWith('linkspan-') && !_sessionOpfsNames.has(name)) stale.push(name);
            }
            for (const name of stale) {
                await root.removeEntry(name).catch(() => { /* best-effort */ });
            }
        } catch { /* OPFS iteration unsupported / unavailable — best-effort */ }
    }

    // ── IndexedDB ────────────────────────────────────────────────
    // Single object store `chunks` keyed by the compound [fileId, index]. The old
    // design used one store *per file* (`chunks-${fileId}`), which can only be
    // created inside onupgradeneeded — so a new file whose store didn't exist fell
    // into an "idb-fallback" mode where writes silently no-op'd (marking chunks as
    // written while storing nothing) and assembly then failed. A fixed store keyed
    // by fileId avoids dynamic store creation entirely.

    _storeNameConst = 'chunks';

    _initIDB(/* fileMeta */) {
        this._storeName = this._storeNameConst;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this._dbName, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this._storeNameConst)) {
                    db.createObjectStore(this._storeNameConst, { keyPath: ['fileId', 'index'] });
                }
            };

            request.onsuccess = (event) => {
                this._db = event.target.result;
                if (!this._db.objectStoreNames.contains(this._storeNameConst)) {
                    // Should not happen now (the store is created on upgrade). Fail
                    // loudly rather than silently dropping writes (the old bug).
                    this._db.close();
                    this._db = null;
                    reject(new Error('IndexedDB "chunks" store missing after open'));
                    return;
                }
                resolve();
            };

            request.onerror = (event) => {
                reject(new Error('IndexedDB init failed: ' + event.target.error));
            };
        });
    }

    _writeIDB(index, data) {
        if (!this._db) return Promise.reject(new Error('IndexedDB not initialized'));
        const fileId = this._fileMeta.fileId;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._storeName, 'readwrite');
            tx.objectStore(this._storeName).put({ fileId, index, data });
            tx.oncomplete = resolve;
            tx.onerror = (e) => reject(new Error('IDB write failed: ' + e.target.error));
        });
    }

    // Range covering every [fileId, index] for one file: a length-1 key sorts before
    // any length-2 key with the same first element, and an array sorts after every
    // number, so [fileId] … [fileId, []] brackets all of this file's chunks.
    _fileKeyRange() {
        const fileId = this._fileMeta.fileId;
        return IDBKeyRange.bound([fileId], [fileId, []]);
    }

    _assembleIDB() {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._storeName, 'readonly');
            const store = tx.objectStore(this._storeName);
            const chunks = [];

            const cursor = store.openCursor(this._fileKeyRange());
            cursor.onsuccess = (event) => {
                const result = event.target.result;
                if (result) {
                    chunks.push({ index: result.value.index, data: result.value.data });
                    result.continue();
                } else {
                    // Sort by index and assemble
                    chunks.sort((a, b) => a.index - b.index);
                    const parts = chunks.map((c) => c.data);
                    const blob = new Blob(parts, {
                        type: this._fileMeta.fileType || 'application/octet-stream',
                    });

                    // Clean up only this file's chunks (best-effort)
                    this._cleanupIDBStore().catch(() => { /* noop */ });

                    resolve(blob);
                }
            };

            cursor.onerror = (e) => reject(new Error('IDB read failed: ' + e.target.error));
        });
    }

    async _cleanupIDBStore() {
        if (!this._db || !this._fileMeta) return;
        try {
            await new Promise((resolve) => {
                const tx = this._db.transaction(this._storeName, 'readwrite');
                // Delete only this file's chunks — never clear() the whole store
                // (that would wipe other in-flight transfers' data).
                tx.objectStore(this._storeName).delete(this._fileKeyRange());
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch { /* best-effort */ }
    }

    // ── Detection ────────────────────────────────────────────────

    _detectMode(allowFsApi = true) {
        if (allowFsApi && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
            return 'fsapi';
        }
        if (
            typeof navigator !== 'undefined' &&
            navigator.storage &&
            typeof navigator.storage.getDirectory === 'function'
        ) {
            return 'opfs';
        }
        return 'idb';
    }
}
