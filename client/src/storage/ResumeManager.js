import { get, set, del } from 'idb-keyval';

/**
 * ResumeManager — Tracks transfer state for session-scoped resume capability.
 */
export class ResumeManager {
    constructor() {
        /** @type {Map<string, ResumeState>} fileId → state */
        this._states = new Map();
    }

    /**
     * Initialize resume state for a file.
     * @param {string} fileId
     * @param {number} totalChunks
     */
    async init(fileId, totalChunks) {
        const existing = await this._loadState(fileId);
        if (existing && existing.totalChunks === totalChunks) {
            this._states.set(fileId, existing);
            return existing;
        }

        const state = {
            fileId,
            totalChunks,
            receivedChunks: [],
            timestamp: Date.now(),
        };
        this._states.set(fileId, state);
        await this._saveState(fileId, state);
        return state;
    }

    /**
     * Mark a chunk as received.
     * @param {string} fileId
     * @param {number} chunkIndex
     */
    async markChunkReceived(fileId, chunkIndex) {
        const state = this._states.get(fileId);
        if (!state) return;

        if (!state.receivedChunks.includes(chunkIndex)) {
            state.receivedChunks.push(chunkIndex);
            state.timestamp = Date.now();

            // Persist every 50 chunks to balance performance and safety
            if (state.receivedChunks.length % 50 === 0) {
                await this._saveState(fileId, state);
            }
        }
    }

    /**
     * Get the set of received chunk indices.
     * @param {string} fileId
     * @returns {Set<number>}
     */
    getReceivedChunks(fileId) {
        const state = this._states.get(fileId);
        return state ? new Set(state.receivedChunks) : new Set();
    }

    /**
     * Get missing chunk indices.
     * @param {string} fileId
     * @returns {number[]}
     */
    getMissingChunks(fileId) {
        const state = this._states.get(fileId);
        if (!state) return [];

        const received = new Set(state.receivedChunks);
        const missing = [];
        for (let i = 0; i < state.totalChunks; i++) {
            if (!received.has(i)) missing.push(i);
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
        return state.receivedChunks.length === state.totalChunks;
    }

    /**
     * Get progress percentage.
     * @param {string} fileId
     * @returns {number}
     */
    getProgress(fileId) {
        const state = this._states.get(fileId);
        if (!state || state.totalChunks === 0) return 0;
        return (state.receivedChunks.length / state.totalChunks) * 100;
    }

    /**
     * Clear a file's resume state.
     * @param {string} fileId
     */
    async clear(fileId) {
        this._states.delete(fileId);
        try {
            await del(`linkspan-resume-${fileId}`);
        } catch { /* noop */ }
    }

    /**
     * Clear all resume states.
     */
    async clearAll() {
        for (const fileId of this._states.keys()) {
            await this.clear(fileId);
        }
    }

    // ── Persistence ────────────────────────────────────────────

    async _saveState(fileId, state) {
        try {
            await set(`linkspan-resume-${fileId}`, state);
        } catch (err) {
            console.warn('[ResumeManager] Failed to persist state:', err.message);
        }
    }

    async _loadState(fileId) {
        try {
            return await get(`linkspan-resume-${fileId}`);
        } catch {
            return null;
        }
    }
}
