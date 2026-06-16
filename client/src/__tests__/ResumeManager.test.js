/**
 * ResumeManager.test.js — Unit tests for the chunked-transfer resume manager.
 *
 * The ResumeManager uses a Uint8Array bitset for O(1) chunk tracking.
 * We mock IndexedDB entirely and test only the in-memory logic.
 *
 * Tests:
 *   - Bitset accuracy for large chunk counts
 *   - markChunkReceived / hasChunk
 *   - getMissingChunks
 *   - exportState / importState round-trip
 *   - isComplete
 *   - Multi-file independence
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── IDB Mock ─────────────────────────────────────────────────────────────────
// The ResumeManager opens IDB on construction. We mock it so tests don't need
// a real browser or Node IDB polyfill.

vi.mock('../storage/ResumeManager.js', async (importOriginal) => {
    const actual = await importOriginal();

    // Patch _openDb to resolve immediately with a minimal fake IDB
    const OriginalClass = actual.ResumeManager;
    class MockResumeManager extends OriginalClass {
        constructor() {
            super();
            // Override the db-ready promise to resolve immediately
            this._db = null; // tests use in-memory state only
            this._dbReady = Promise.resolve();
        }

        // Stub persistence — in-memory only
        async _saveState(_fileId, _state) { /* no-op */ }
        async _loadState(_fileId) { return null; }
        async _deleteState(_fileId) { /* no-op */ }
        _openDb() { return Promise.resolve(null); }
    }

    return { ...actual, ResumeManager: MockResumeManager };
});

const { ResumeManager } = await import('../storage/ResumeManager.js');

describe('ResumeManager', () => {
    let mgr;

    beforeEach(async () => {
        mgr = new ResumeManager();
        await mgr._dbReady; // wait for init
    });

    // ── Initialization ─────────────────────────────────────────────────────

    test('init creates an all-zero bitset', async () => {
        const state = await mgr.init('file-1', 100);
        for (let i = 0; i < 100; i++) {
            expect(mgr.hasChunk('file-1', i)).toBe(false);
        }
        expect(state.totalChunks).toBe(100);
        expect(state.receivedCount).toBe(0);
    });

    // ── markChunkReceived / hasChunk ───────────────────────────────────────

    test('markChunkReceived sets the correct bit', async () => {
        await mgr.init('file-2', 10);
        mgr.markChunkReceived('file-2', 3);
        expect(mgr.hasChunk('file-2', 3)).toBe(true);
        expect(mgr.hasChunk('file-2', 2)).toBe(false);
        expect(mgr.hasChunk('file-2', 4)).toBe(false);
    });

    test('multiple chunks can be marked independently', async () => {
        await mgr.init('file-3', 64);
        const toMark = [0, 7, 15, 31, 63];
        for (const i of toMark) mgr.markChunkReceived('file-3', i);
        for (const i of toMark) expect(mgr.hasChunk('file-3', i)).toBe(true);
        // Others should be false
        for (let i = 0; i < 64; i++) {
            if (!toMark.includes(i)) {
                expect(mgr.hasChunk('file-3', i)).toBe(false);
            }
        }
    });

    // ── Bitset accuracy for large chunk counts ────────────────────────────

    test('bitset accurate for 200,000 chunks (large file scenario)', async () => {
        const TOTAL = 200_000;
        await mgr.init('big-file', TOTAL);

        // Mark every 1000th chunk
        for (let i = 0; i < TOTAL; i += 1000) {
            mgr.markChunkReceived('big-file', i);
        }

        // Verify marked chunks
        for (let i = 0; i < TOTAL; i += 1000) {
            expect(mgr.hasChunk('big-file', i)).toBe(true);
        }

        // Verify a few unmarked
        for (let i = 1; i < 10; i++) {
            expect(mgr.hasChunk('big-file', i)).toBe(false);
        }
    });

    // ── getReceivedChunks (count) ─────────────────────────────────────────

    test('getReceivedChunks returns correct count after marking', async () => {
        await mgr.init('count-file', 50);
        mgr.markChunkReceived('count-file', 0);
        mgr.markChunkReceived('count-file', 10);
        mgr.markChunkReceived('count-file', 49);

        const state = mgr._states.get('count-file');
        expect(state.receivedCount).toBe(3);
    });

    test('marking same chunk twice does not increase count', async () => {
        await mgr.init('dupe-file', 10);
        mgr.markChunkReceived('dupe-file', 5);
        mgr.markChunkReceived('dupe-file', 5);
        const state = mgr._states.get('dupe-file');
        expect(state.receivedCount).toBe(1);
    });

    // ── isComplete ────────────────────────────────────────────────────────

    test('isComplete returns false when chunks remain', async () => {
        await mgr.init('complete-file', 5);
        for (let i = 0; i < 4; i++) mgr.markChunkReceived('complete-file', i);
        expect(mgr.isComplete('complete-file')).toBe(false);
    });

    test('isComplete returns true when all chunks received', async () => {
        await mgr.init('complete-file-2', 5);
        for (let i = 0; i < 5; i++) mgr.markChunkReceived('complete-file-2', i);
        expect(mgr.isComplete('complete-file-2')).toBe(true);
    });

    // ── getMissingChunks ──────────────────────────────────────────────────

    test('getMissingChunks returns all unset indices', async () => {
        await mgr.init('missing-file', 8);
        mgr.markChunkReceived('missing-file', 0);
        mgr.markChunkReceived('missing-file', 3);
        mgr.markChunkReceived('missing-file', 7);

        const missing = mgr.getMissingChunks('missing-file');
        expect(missing).toEqual([1, 2, 4, 5, 6]);
    });

    // ── Multi-file independence ───────────────────────────────────────────

    test('marking a chunk in file-A does not affect file-B', async () => {
        await mgr.init('file-A', 10);
        await mgr.init('file-B', 10);

        mgr.markChunkReceived('file-A', 5);

        expect(mgr.hasChunk('file-A', 5)).toBe(true);
        expect(mgr.hasChunk('file-B', 5)).toBe(false);
    });

    // ── exportState / importState round-trip ──────────────────────────────

    test('exportState → importState round-trip preserves bitset', async () => {
        await mgr.init('export-file', 64);
        const marked = [0, 8, 15, 32, 63];
        for (const i of marked) mgr.markChunkReceived('export-file', i);

        const exported = mgr.exportState('export-file');
        expect(exported).toBeInstanceOf(Uint8Array);

        const mgr2 = new ResumeManager();
        await mgr2._dbReady;
        mgr2.importState('export-file', 64, exported);

        for (const i of marked) {
            expect(mgr2.hasChunk('export-file', i)).toBe(true);
        }
        const state2 = mgr2._states.get('export-file');
        expect(state2.receivedCount).toBe(marked.length);
    });

    // ── clear ─────────────────────────────────────────────────────────────

    test('clear resets state for that file', async () => {
        await mgr.init('clear-file', 10);
        mgr.markChunkReceived('clear-file', 5);
        await mgr.clear('clear-file');

        // After clear, state should be gone or reset
        const state = mgr._states.get('clear-file');
        expect(state == null || state.receivedCount === 0).toBe(true);
    });

    // ── persistence checkpoints (Phase 3.1 atomic-resume hardening) ─────────

    test('flush() persists immediately and clears the pending debounce', async () => {
        await mgr.init('flush-file', 10);
        const spy = vi.spyOn(mgr, '_saveState');

        mgr.markChunkReceived('flush-file', 0); // schedules a debounced persist
        expect(mgr._flushTimers.has('flush-file')).toBe(true);

        await mgr.flush('flush-file');

        expect(spy).toHaveBeenCalledTimes(1);
        expect(mgr._flushTimers.has('flush-file')).toBe(false);
        expect(mgr._pendingSince.has('flush-file')).toBe(false);
    });

    test('a sustained chunk burst still persists within the max-wait ceiling', async () => {
        vi.useFakeTimers();
        try {
            const burstMgr = new ResumeManager();
            await burstMgr._dbReady;
            await burstMgr.init('burst', 5000);
            const spy = vi.spyOn(burstMgr, '_saveState');

            // Mark a chunk every 10ms (faster than the 16ms debounce) for ~2s.
            // Without a ceiling the debounce would reset forever and never fire;
            // the max-wait forces periodic flushes.
            for (let i = 0; i < 200; i++) {
                burstMgr.markChunkReceived('burst', i);
                await vi.advanceTimersByTimeAsync(10);
            }

            expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
