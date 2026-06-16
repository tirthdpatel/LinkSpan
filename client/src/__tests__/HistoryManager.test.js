import { describe, test, expect, beforeEach } from 'vitest';
import { HistoryManager } from '../storage/HistoryManager.js';

// fake-indexeddb (setup.js) gives a real in-memory IDB; localStorage is provided by
// the Node env via a tiny shim below so the privacy toggle persists within a test.
beforeEach(async () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
    };
    // fake-indexeddb is shared across tests in this file — empty the store each test
    // (deleteDatabase would block on the still-open connections from prior tests).
    await new HistoryManager().clear();
});

function rec(over = {}) {
    return {
        direction: 'send',
        transferType: 'files',
        name: 'report.pdf',
        fileNames: ['report.pdf'],
        fileCount: 1,
        totalBytes: 1024,
        durationMs: 2000,
        state: 'success',
        ...over,
    };
}

describe('HistoryManager (Feature 6)', () => {
    test('records and lists transfers newest-first', async () => {
        const h = new HistoryManager();
        await h.add(rec({ name: 'a.txt', timestamp: 1000 }));
        await h.add(rec({ name: 'b.txt', timestamp: 2000 }));
        const rows = await h.list();
        expect(rows.map((r) => r.name)).toEqual(['b.txt', 'a.txt']);
        expect(await h.count()).toBe(2);
    });

    test('filters by direction and state, and searches names', async () => {
        const h = new HistoryManager();
        await h.add(rec({ name: 'sent-ok', direction: 'send', state: 'success' }));
        await h.add(rec({ name: 'recv-fail', direction: 'receive', state: 'failed', fileNames: ['photo.jpg'] }));
        await h.add(rec({ name: 'recv-ok', direction: 'receive', state: 'success' }));

        expect((await h.list({ direction: 'receive' })).length).toBe(2);
        expect((await h.list({ state: 'failed' })).map((r) => r.name)).toEqual(['recv-fail']);
        // Search matches across name + file names.
        expect((await h.list({ search: 'photo' })).map((r) => r.name)).toEqual(['recv-fail']);
    });

    test('sorts by size and name', async () => {
        const h = new HistoryManager();
        await h.add(rec({ name: 'big', totalBytes: 9000 }));
        await h.add(rec({ name: 'small', totalBytes: 10 }));
        expect((await h.list({ sortBy: 'size', order: 'desc' })).map((r) => r.name)).toEqual(['big', 'small']);
        expect((await h.list({ sortBy: 'name', order: 'asc' })).map((r) => r.name)).toEqual(['big', 'small']);
    });

    test('delete one and clear all', async () => {
        const h = new HistoryManager();
        const id = await h.add(rec({ name: 'x' }));
        await h.add(rec({ name: 'y' }));
        await h.delete(id);
        expect((await h.list()).map((r) => r.name)).toEqual(['y']);
        await h.clear();
        expect(await h.count()).toBe(0);
    });

    test('export produces parseable JSON with all records', async () => {
        const h = new HistoryManager();
        await h.add(rec({ name: 'one' }));
        const json = await h.export();
        const parsed = JSON.parse(json);
        expect(parsed.kind).toBe('transfer-history');
        expect(parsed.records.length).toBe(1);
        expect(parsed.records[0].name).toBe('one');
    });

    test('privacy toggle disables new recording without deleting existing', async () => {
        const h = new HistoryManager();
        await h.add(rec({ name: 'kept' }));
        h.setEnabled(false);
        expect(h.isEnabled()).toBe(false);
        const id = await h.add(rec({ name: 'dropped' }));
        expect(id).toBeNull();
        expect((await h.list()).map((r) => r.name)).toEqual(['kept']);
        // Re-enabling resumes recording.
        h.setEnabled(true);
        await h.add(rec({ name: 'again' }));
        expect((await h.list()).length).toBe(2);
    });
});
