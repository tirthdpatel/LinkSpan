/**
 * RememberedDevices — the local trusted-device store and contact list
 * (Features 4, 10, 11, 12).
 *
 * Backed by IndexedDB so it survives reloads. Keyed by the sender's DeviceIdentity
 * id. Each record carries a friendly name, the device type + platform announced in
 * BATCH_META (Feature 12), a favorite flag, an optional user note, and first/last
 * seen timestamps. Users can trust (remember), rename, favorite, search and remove
 * devices — this powers both the auto-approve gate (Feature 4) and the contact list
 * UI (Feature 11).
 *
 * This is a UX convenience, NOT a security boundary: a device id is spoofable, so
 * remembering only short-circuits the manual approval click — it never bypasses the
 * per-session SAS/MITM verification, which still runs every connection. The user can
 * revoke any remembered device at any time.
 *
 * The store is self-bounding via a max-entries cap (favorites are never evicted) so a
 * hostile/looping peer can't grow it without bound. The schema is forward-looking:
 * records are flat documents, so a future account/sync layer can adopt them directly.
 */

const DB_NAME = 'linkspan-devices';
// v2: added device type/platform/favorite/note fields + a `favorite` index for the
// contact list. Field additions are backward-compatible (old records read fine).
const DB_VERSION = 2;
const STORE = 'remembered';
const MAX_ENTRIES = 500;

function openDb() {
    return new Promise((resolve, reject) => {
        let request;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
            reject(err);
            return;
        }
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const upgradeTx = event.target.transaction;
            let store;
            if (!db.objectStoreNames.contains(STORE)) {
                store = db.createObjectStore(STORE, { keyPath: 'deviceId' });
                store.createIndex('lastSeen', 'lastSeen', { unique: false });
            } else {
                store = upgradeTx.objectStore(STORE);
            }
            if (!store.indexNames.contains('favorite')) {
                store.createIndex('favorite', 'favorite', { unique: false });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error || new Error('IndexedDB open failed'));
    });
}

function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
            result = fn(store);
        } catch (err) {
            reject(err);
            return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    });
}

export class RememberedDevices {
    /** @param {IDBDatabase} [db] - injectable for tests; otherwise opened lazily */
    constructor(db = null) {
        this._db = db;
    }

    async _ensure() {
        if (!this._db) this._db = await openDb();
        return this._db;
    }

    /**
     * Is this sender device remembered for auto-approval?
     * @param {string} deviceId
     * @returns {Promise<boolean>}
     */
    async isRemembered(deviceId) {
        if (!deviceId) return false;
        const db = await this._ensure();
        const rec = await tx(db, 'readonly', (store) => promisify(store.get(deviceId)));
        return Boolean(await rec);
    }

    /**
     * Remember/trust a device (idempotent; refreshes name + metadata + lastSeen).
     * Enforces the MAX_ENTRIES cap by evicting the oldest-seen non-favorite entries.
     * @param {{ deviceId: string, deviceName?: string, deviceType?: string, platform?: string }} device
     */
    async remember({ deviceId, deviceName, deviceType, platform }) {
        if (!deviceId) return;
        const db = await this._ensure();
        const now = Date.now();
        await tx(db, 'readwrite', (store) => {
            const existing = store.get(deviceId);
            existing.onsuccess = () => {
                const prev = existing.result;
                store.put({
                    deviceId,
                    deviceName: deviceName || prev?.deviceName || 'Unknown device',
                    deviceType: deviceType || prev?.deviceType || 'unknown',
                    platform: platform || prev?.platform || '',
                    note: prev?.note || '',
                    // `favorite` is stored as 0/1 so it can be indexed by IndexedDB
                    // (which cannot index boolean values).
                    favorite: prev?.favorite ? 1 : 0,
                    firstRemembered: prev?.firstRemembered || now,
                    lastSeen: now,
                });
            };
        });
        await this._evictIfNeeded(db);
    }

    /** Fetch a single device record (or undefined). */
    async get(deviceId) {
        if (!deviceId) return undefined;
        const db = await this._ensure();
        return tx(db, 'readonly', (store) => promisify(store.get(deviceId)));
    }

    /**
     * List contacts (Feature 11): favorites first, then most-recently-seen. Supports
     * an optional case-insensitive search over name / platform / type.
     * @param {{ search?: string }} [opts]
     * @returns {Promise<Array<object>>}
     */
    async list(opts = {}) {
        const db = await this._ensure();
        const all = await tx(db, 'readonly', (store) => promisify(store.getAll()));
        let rows = (await all).map((r) => ({ ...r, favorite: !!r.favorite }));
        const q = (opts.search || '').trim().toLowerCase();
        if (q) {
            rows = rows.filter((d) =>
                (d.deviceName || '').toLowerCase().includes(q) ||
                (d.platform || '').toLowerCase().includes(q) ||
                (d.deviceType || '').toLowerCase().includes(q));
        }
        return rows.sort((a, b) => {
            if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
            return b.lastSeen - a.lastSeen;
        });
    }

    /** Case-insensitive search convenience (Feature 11). */
    async search(query) {
        return this.list({ search: query });
    }

    /** Rename a device (Feature 10). No-op if the device isn't remembered. */
    async rename(deviceId, deviceName) {
        await this._patch(deviceId, (rec) => {
            rec.deviceName = sanitizeName(deviceName) || rec.deviceName;
        });
    }

    /** Favorite / unfavorite a device (Features 10/11). */
    async setFavorite(deviceId, favorite) {
        await this._patch(deviceId, (rec) => { rec.favorite = favorite ? 1 : 0; });
    }

    /** Attach a short user note to a device. */
    async setNote(deviceId, note) {
        await this._patch(deviceId, (rec) => { rec.note = sanitizeName(note).slice(0, 200); });
    }

    /** Update lastSeen (e.g. on reconnect) for online/last-seen display. */
    async touch(deviceId) {
        await this._patch(deviceId, (rec) => { rec.lastSeen = Date.now(); });
    }

    /** Revoke trust in / remove a single device (Feature 10). */
    async forget(deviceId) {
        const db = await this._ensure();
        await tx(db, 'readwrite', (store) => store.delete(deviceId));
    }

    /** Revoke all remembered devices. */
    async clear() {
        const db = await this._ensure();
        await tx(db, 'readwrite', (store) => store.clear());
    }

    /** Read-modify-write a single record under one transaction. */
    async _patch(deviceId, mutate) {
        if (!deviceId) return;
        const db = await this._ensure();
        await tx(db, 'readwrite', (store) => {
            const get = store.get(deviceId);
            get.onsuccess = () => {
                const rec = get.result;
                if (!rec) return;
                mutate(rec);
                store.put(rec);
            };
        });
    }

    async _evictIfNeeded(db) {
        const all = await tx(db, 'readonly', (store) => promisify(store.getAll()));
        const list = await all;
        if (list.length <= MAX_ENTRIES) return;
        // Never evict favorites; drop the oldest-seen of the rest.
        const victims = list
            .filter((d) => !d.favorite)
            .sort((a, b) => a.lastSeen - b.lastSeen)
            .slice(0, list.length - MAX_ENTRIES)
            .map((d) => d.deviceId);
        await tx(db, 'readwrite', (store) => {
            for (const id of victims) store.delete(id);
        });
    }
}

/** Clamp a user-supplied name/note for safe storage and rendering. */
function sanitizeName(value) {
    return String(value ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 64);
}

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
