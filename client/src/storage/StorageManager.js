/**
 * StorageManager — Tiered storage: File System Access API → OPFS → IndexedDB.
 * Handles chunk storage and final file assembly without loading full file into RAM.
 */
export class StorageManager {
    constructor() {
        /** @type {'fsapi' | 'opfs' | 'idb'} */
        this.mode = this._detectMode();
        this._fileMeta = null;

        // File System Access API
        /** @type {FileSystemWritableFileStream | null} */
        this._writableStream = null;
        /** @type {FileSystemFileHandle | null} */
        this._fileHandle = null;

        // OPFS
        /** @type {FileSystemFileHandle | null} */
        this._opfsHandle = null;

        // IndexedDB
        /** @type {IDBDatabase | null} */
        this._db = null;
        this._dbName = 'linkspan-chunks';

        /** @type {Map<number, boolean>} */
        this._writtenChunks = new Map();
    }

    /**
     * Initialize storage for a file transfer.
     * @param {object} fileMeta
     */
    async initFile(fileMeta) {
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
     * @returns {Promise<Blob>}
     */
    async assembleFile() {
        if (this.mode === 'fsapi') {
            // File already written sequentially — close the stream
            if (this._writableStream) {
                await this._writableStream.close();
                this._writableStream = null;
            }
            // Return a blob from the file handle
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
     * Clean up storage.
     */
    async cleanup() {
        if (this._writableStream) {
            try { await this._writableStream.close(); } catch { /* noop */ }
        }
        if (this.mode === 'idb' && this._db) {
            this._db.close();
        }
        this._writtenChunks.clear();
    }

    /**
     * Get the current storage mode.
     */
    getMode() {
        return this.mode;
    }

    // ── File System Access API ───────────────────────────────────

    async _initFSAPI(fileMeta) {
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
            // User cancelled or API not available — fall back
            console.warn('[StorageManager] FSAPI init failed, falling back:', err.message);
            this.mode = 'opfs';
            await this._initOPFS(fileMeta);
        }
    }

    async _writeFSAPI(index, data) {
        if (!this._writableStream) throw new Error('No writable stream');
        const offset = index * this._fileMeta.chunkSize;
        await this._writableStream.seek(offset);
        await this._writableStream.write(data);
    }

    // ── OPFS (Origin Private File System) ────────────────────────

    async _initOPFS(fileMeta) {
        try {
            const root = await navigator.storage.getDirectory();
            this._opfsHandle = await root.getFileHandle(
                `linkspan-${fileMeta.fileId}`,
                { create: true }
            );
        } catch (err) {
            console.warn('[StorageManager] OPFS init failed, falling back to IDB:', err.message);
            this.mode = 'idb';
            await this._initIDB(fileMeta);
        }
    }

    async _writeOPFS(index, data) {
        if (!this._opfsHandle) throw new Error('No OPFS handle');
        const writable = await this._opfsHandle.createWritable({ keepExistingData: true });
        const offset = index * this._fileMeta.chunkSize;
        await writable.seek(offset);
        await writable.write(data);
        await writable.close();
    }

    async _assembleOPFS() {
        if (!this._opfsHandle) throw new Error('No OPFS handle');
        const file = await this._opfsHandle.getFile();
        // Clean up OPFS file after reading
        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(`linkspan-${this._fileMeta.fileId}`);
        } catch { /* noop */ }
        return file;
    }

    // ── IndexedDB ────────────────────────────────────────────────

    _initIDB(fileMeta) {
        return new Promise((resolve, reject) => {
            const storeName = `file-${fileMeta.fileId}`;
            const request = indexedDB.open(this._dbName, Date.now());

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath: 'index' });
                }
            };

            request.onsuccess = (event) => {
                this._db = event.target.result;
                this._storeName = storeName;
                resolve();
            };

            request.onerror = (event) => {
                reject(new Error('IndexedDB init failed: ' + event.target.error));
            };
        });
    }

    _writeIDB(index, data) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._storeName, 'readwrite');
            const store = tx.objectStore(this._storeName);
            store.put({ index, data });
            tx.oncomplete = resolve;
            tx.onerror = (e) => reject(new Error('IDB write failed: ' + e.target.error));
        });
    }

    _assembleIDB() {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._storeName, 'readonly');
            const store = tx.objectStore(this._storeName);
            const chunks = [];

            const cursor = store.openCursor();
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

                    // Clean up
                    try {
                        indexedDB.deleteDatabase(this._dbName);
                    } catch { /* noop */ }

                    resolve(blob);
                }
            };

            cursor.onerror = (e) => reject(new Error('IDB read failed: ' + e.target.error));
        });
    }

    // ── Detection ────────────────────────────────────────────────

    _detectMode() {
        // Check File System Access API
        if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
            return 'fsapi';
        }

        // Check OPFS
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
            return 'opfs';
        }

        // Fallback to IndexedDB
        return 'idb';
    }
}
