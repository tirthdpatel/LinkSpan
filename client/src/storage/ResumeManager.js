import { DB_VERSION, RESUME_FLUSH_DEBOUNCE_MS, RESUME_FLUSH_MAX_WAIT_MS } from '@shared/constants.js';

/**
 * ResumeManager — Tracks transfer state for cross-session resume capability.
 *
 * Key improvements over v1:
 * - Uses a Uint8Array bitset for O(1) chunk lookup and compact storage
 *   (a 200,000-chunk transfer needs 25 KB vs ~1.6 MB with an array)
 * - Debounced flush (16 ms) — every chunk write is persisted without blocking
 * - Stable IndexedDB version (DB_VERSION constant — never Date.now())
 * - recoverFromStorage() — rebuilds state after browser restart
 */
export class ResumeManager {
    constructor() {
        /** @type {Map<string, ResumeState>} fileId → state */
        this._states = new Map();
        /** @type {Map<string, ReturnType<typeof setTimeout>>} fileId → debounce timer */
        this._flushTimers = new Map();
        /** @type {Map<string, number>} fileId → timestamp of the oldest un-persisted change */
        this._pendingSince = new Map();
        /** @type {IDBDatabase | null} */
        this._db = null;
        this._dbReady = this._openDb();
    }

    // ── Public API ─────────────────────────────────────────────

    /**
     * Initialize resume state for a file.
     * @param {string} fileId
     * @param {number} totalChunks
     * @returns {Promise<ResumeState>}
     */
    async init(fileId, totalChunks) {
        await this._dbReady;
        const existing = await this._loadState(fileId);

        if (existing && existing.totalChunks === totalChunks) {
            // Rebuild the in-memory bitset from persisted data
            const state = {
                fileId,
                totalChunks,
                bitset: new Uint8Array(existing.bitset),
                receivedCount: existing.receivedCount,
                timestamp: existing.timestamp,
            };
            this._states.set(fileId, state);
            return state;
        }

        // Fresh state
        const state = {
            fileId,
            totalChunks,
            bitset: new Uint8Array(Math.ceil(totalChunks / 8)),
            receivedCount: 0,
            timestamp: Date.now(),
        };
        this._states.set(fileId, state);
        await this._saveState(fileId, state);
        return state;
    }

    /**
     * Mark a chunk as received.
     * Uses a bitset for O(1) lookup. Triggers a debounced persist.
     * @param {string} fileId
     * @param {number} chunkIndex
     */
    markChunkReceived(fileId, chunkIndex) {
        const state = this._states.get(fileId);
        if (!state) return;

        const byteIndex = chunkIndex >> 3;
        const bitIndex = chunkIndex & 7;
        const alreadySet = (state.bitset[byteIndex] >> bitIndex) & 1;

        if (!alreadySet) {
            state.bitset[byteIndex] |= 1 << bitIndex;
            state.receivedCount++;
            state.timestamp = Date.now();
            this._schedulePersist(fileId);
        }
    }

    /**
     * Check if a specific chunk has been received.
     * @param {string} fileId
     * @param {number} chunkIndex
     * @returns {boolean}
     */
    hasChunk(fileId, chunkIndex) {
        const state = this._states.get(fileId);
        if (!state) return false;
        const byteIndex = chunkIndex >> 3;
        const bitIndex = chunkIndex & 7;
        return ((state.bitset[byteIndex] >> bitIndex) & 1) === 1;
    }

    /**
     * Get the set of received chunk indices.
     * @param {string} fileId
     * @returns {Set<number>}
     */
    getReceivedChunks(fileId) {
        const state = this._states.get(fileId);
        if (!state) return new Set();

        const received = new Set();
        for (let i = 0; i < state.totalChunks; i++) {
            if (this.hasChunk(fileId, i)) {
                received.add(i);
            }
        }
        return received;
    }

    /**
     * Get missing chunk indices.
     * @param {string} fileId
     * @returns {number[]}
     */
    getMissingChunks(fileId) {
        const state = this._states.get(fileId);
        if (!state) return [];

        const missing = [];
        for (let i = 0; i < state.totalChunks; i++) {
            if (!this.hasChunk(fileId, i)) {
                missing.push(i);
            }
        }
        return missing;
    }

    /**
     * Check if a transfer is complete.
     * @param {string} fileId
     * @returns {boolean}
     */
    isComplete(fileId) {
        const state = this._states.get(fileId);
        if (!state) return false;
        return state.receivedCount === state.totalChunks;
    }

    /**
     * Get progress percentage.
     * @param {string} fileId
     * @returns {number}
     */
    getProgress(fileId) {
        const state = this._states.get(fileId);
        if (!state || state.totalChunks === 0) return 0;
        return (state.receivedCount / state.totalChunks) * 100;
    }

    /**
     * Export state as a compact Uint8Array bitset.
     * Used to send receiver's state to the re-joining sender.
     * @param {string} fileId
     * @returns {Uint8Array | null}
     */
    exportState(fileId) {
        const state = this._states.get(fileId);
        return state ? state.bitset.slice() : null;
    }

    /**
     * Import a bitset state (e.g. received from sender after reconnect).
     * @param {string} fileId
     * @param {number} totalChunks
     * @param {Uint8Array} bitset
     */
    importState(fileId, totalChunks, bitset) {
        let receivedCount = 0;
        for (let i = 0; i < totalChunks; i++) {
            const byteIndex = i >> 3;
            const bitIndex = i & 7;
            if ((bitset[byteIndex] >> bitIndex) & 1) receivedCount++;
        }

        const state = {
            fileId,
            totalChunks,
            bitset: new Uint8Array(bitset),
            receivedCount,
            timestamp: Date.now(),
        };
        this._states.set(fileId, state);
        this._schedulePersist(fileId);
    }

    /**
     * Attempt to recover resume state from IndexedDB after a browser restart.
     * Call this before init() to detect an interrupted transfer.
     * @param {string} fileId
     * @returns {Promise<ResumeState | null>}
     */
    async recoverFromStorage(fileId) {
        await this._dbReady;
        const persisted = await this._loadState(fileId);
        if (!persisted) return null;

        const state = {
            fileId,
            totalChunks: persisted.totalChunks,
            bitset: new Uint8Array(persisted.bitset),
            receivedCount: persisted.receivedCount,
            timestamp: persisted.timestamp,
        };
        this._states.set(fileId, state);
        return state;
    }

    /**
     * Clear resume state for a completed or cancelled transfer.
     * @param {string} fileId
     */
    async clear(fileId) {
        // Cancel any pending flush
        const timer = this._flushTimers.get(fileId);
        if (timer) {
            clearTimeout(timer);
            this._flushTimers.delete(fileId);
        }

        this._states.delete(fileId);
        await this._dbReady;
        await this._deleteState(fileId);
    }

    /**
     * Remove resume states older than 7 days.
     */
    async cleanupExpired() {
        await this._dbReady;
        const db = this._db;
        if (!db) return;

        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

        return new Promise((resolve) => {
            const tx = db.transaction('resume', 'readwrite');
            const store = tx.objectStore('resume');
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.timestamp < cutoff) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };

            tx.oncomplete = resolve;
            tx.onerror = resolve; // best-effort
        });
    }

    /**
     * Persist the current ledger immediately (bypassing the debounce). Call on
     * pause/cancel or page-hide so the ledger is durable at known checkpoints.
     * @param {string} fileId
     */
    async flush(fileId) {
        const timer = this._flushTimers.get(fileId);
        if (timer) clearTimeout(timer);
        this._flushTimers.delete(fileId);
        this._pendingSince.delete(fileId);
        await this._dbReady;
        const state = this._states.get(fileId);
        if (state) await this._saveState(fileId, state);
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Schedule a debounced persist (16ms) with a hard ceiling: under a sustained
     * burst the 16ms timer keeps getting pushed back, so we also force a flush once
     * the oldest un-persisted change is older than RESUME_FLUSH_MAX_WAIT_MS. This
     * bounds how far the durable ledger can trail storage — and therefore the
     * worst-case re-download after a crash.
     */
    _schedulePersist(fileId) {
        const now = Date.now();
        if (!this._pendingSince.has(fileId)) this._pendingSince.set(fileId, now);

        const existing = this._flushTimers.get(fileId);
        if (existing) clearTimeout(existing);

        const waited = now - this._pendingSince.get(fileId);
        const delay = Math.max(0, Math.min(RESUME_FLUSH_DEBOUNCE_MS, RESUME_FLUSH_MAX_WAIT_MS - waited));

        const timer = setTimeout(() => this._persistNow(fileId), delay);
        this._flushTimers.set(fileId, timer);
    }

    async _persistNow(fileId) {
        this._flushTimers.delete(fileId);
        this._pendingSince.delete(fileId);
        const state = this._states.get(fileId);
        if (state) {
            await this._saveState(fileId, state);
        }
    }

    /**
     * Open the IndexedDB resume database with stable version.
     */
    _openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('linkspan-resume', DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;

                // v1→v3: create the 'resume' object store if missing
                if (oldVersion < 3) {
                    if (!db.objectStoreNames.contains('resume')) {
                        db.createObjectStore('resume', { keyPath: 'fileId' });
                    }
                }
            };

            request.onsuccess = (event) => {
                this._db = event.target.result;
                resolve(this._db);
            };

            request.onerror = () => {
                console.warn('[ResumeManager] IndexedDB unavailable — resume disabled');
                resolve(null); // degrade gracefully
            };
        });
    }

    async _saveState(fileId, state) {
        if (!this._db) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this._db.transaction('resume', 'readwrite');
                const store = tx.objectStore('resume');
                store.put({
                    fileId,
                    totalChunks: state.totalChunks,
                    bitset: state.bitset.buffer,
                    receivedCount: state.receivedCount,
                    timestamp: state.timestamp,
                });
                tx.oncomplete = resolve;
                tx.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn('[ResumeManager] Failed to persist state:', err.message);
        }
    }

    async _loadState(fileId) {
        if (!this._db) return null;
        try {
            return await new Promise((resolve, reject) => {
                const tx = this._db.transaction('resume', 'readonly');
                const store = tx.objectStore('resume');
                const request = store.get(fileId);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = (e) => reject(e.target.error);
            });
        } catch {
            return null;
        }
    }

    async _deleteState(fileId) {
        if (!this._db) return;
        try {
            await new Promise((resolve) => {
                const tx = this._db.transaction('resume', 'readwrite');
                const store = tx.objectStore('resume');
                store.delete(fileId);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch { /* best-effort */ }
    }
}
