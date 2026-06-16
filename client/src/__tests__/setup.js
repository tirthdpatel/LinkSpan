/**
 * setup.js — Global test setup for Vitest client tests.
 *
 * Polyfills required for testing crypto and storage in the Node environment:
 *   - `crypto` global (Web Crypto API via Node 18's globalThis.crypto)
 *   - `indexedDB` (a real in-memory implementation via fake-indexeddb, so storage
 *     code paths — compound keys, key ranges, upgrades — are exercised faithfully)
 */

import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import 'fake-indexeddb/auto';

// ── Web Crypto ────────────────────────────────────────────────────────────────
// Node 18 exposes it as globalThis.crypto. ESM module scope also sees globalThis,
// so bare `crypto` in source files will work once we set globalThis.crypto.

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

// ── Blob / File ───────────────────────────────────────────────────────────────
// Node 18 keeps Blob/File in node:buffer (not yet on the global object), so source
// code using `new File(...)` / `blob.slice().arrayBuffer()` works in the Node env.
if (typeof globalThis.Blob === 'undefined') {
    globalThis.Blob = NodeBlob;
}
if (typeof globalThis.File === 'undefined') {
    globalThis.File = NodeFile;
}

// ── localStorage ──────────────────────────────────────────────────────────────
// The Node test env has no localStorage; provide a minimal in-memory implementation
// so preference flags (history + telemetry opt-in) round-trip faithfully. An empty
// store returns null from getItem — identical to the previous "absent" behavior — so
// existing defaults are unchanged.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(String(k)); },
        clear: () => { store.clear(); },
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };
}

// ── btoa / atob ───────────────────────────────────────────────────────────────
// Node 18 does have btoa/atob globally, but just in case:
if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = (b) => Buffer.from(b, 'binary').toString('base64');
    globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}// IndexedDB is provided by `fake-indexeddb/auto` (imported above), which installs a
// spec-compliant in-memory indexedDB + IDBKeyRange on globalThis.
