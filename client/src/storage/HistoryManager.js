/**
 * HistoryManager — persistent, searchable transfer history (Feature 6).
 *
 * Every completed/failed/declined transfer is recorded as one row in an IndexedDB
 * store. The history is local-only (never leaves the device) and fully under the
 * user's control: it can be searched, filtered, sorted, exported, individually
 * deleted, cleared wholesale, or disabled entirely (privacy toggle). When disabled,
 * `add()` is a no-op so nothing new is ever written.
 *
 * Storage layout — db `linkspan-history`, store `transfers` keyed by an
 * auto-increment id, with indexes on `timestamp`, `direction` and `state` so the
 * common list/filter queries stay O(log n) rather than scanning every row.
 *
 * Records are bounded: each carries at most a capped slice of file/folder names and
 * the store is trimmed to MAX_RECORDS so history can't grow without limit.
 */

const DB_NAME = 'linkspan-history';
const DB_VERSION = 1;
const STORE = 'transfers';
const ENABLED_KEY = 'linkspan-history-enabled';
const MAX_RECORDS = 5000;

function lsGet(key) {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); }
    catch { return null; }
}
function lsSet(key, val) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch { /* ignore */ }
}

function openDb() {
    return new Promise((resolve, reject) => {
        let request;
        try { request = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (err) { reject(err); return; }
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('direction', 'direction', { unique: false });
                store.createIndex('state', 'state', { unique: false });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error || new Error('history db open failed'));
    });
}

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class HistoryManager {
    /** @param {IDBDatabase} [db] injectable for tests */
    constructor(db = null) {
        this._db = db;
    }

    async _ensure() {
        if (!this._db) this._db = await openDb();
        return this._db;
    }

    // ── Privacy toggle ─────────────────────────────────────────────
    /** History recording is on unless explicitly disabled. */
    isEnabled() {
        return lsGet(ENABLED_KEY) !== 'false';
    }

    /** Enable/disable recording. Disabling does NOT delete existing history. */
    setEnabled(on) {
        lsSet(ENABLED_KEY, on ? 'true' : 'false');
        return this.isEnabled();
    }

    // ── Write ──────────────────────────────────────────────────────
    /**
     * Append a transfer record. No-op when history is disabled.
     * @param {object} record - normalized transfer fields (direction, peerName,
     *        transferType, fileNames[], folderNames[], totalBytes, durationMs,
     *        state, error, ...). `timestamp` is stamped here if absent.
     * @returns {Promise<number|null>} the new row id, or null if disabled.
     */
    async add(record) {
        if (!this.isEnabled()) return null;
        const db = await this._ensure();
        const row = {
            timestamp: record.timestamp ?? Date.now(),
            direction: record.direction ?? 'send',
            peerName: record.peerName ?? null,
            peerDeviceId: record.peerDeviceId ?? null,
            transferType: record.transferType ?? 'files',
            name: record.name ?? null,
            fileNames: Array.isArray(record.fileNames) ? record.fileNames.slice(0, 200) : [],
            fileCount: record.fileCount ?? (record.fileNames?.length ?? 0),
            folderNames: Array.isArray(record.folderNames) ? record.folderNames.slice(0, 200) : [],
            folderCount: record.folderCount ?? (record.folderNames?.length ?? 0),
            totalBytes: record.totalBytes ?? 0,
            durationMs: record.durationMs ?? 0,
            state: record.state ?? 'success',
            error: record.error ?? null,
        };
        const id = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).add(row);
            req.onsuccess = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
        this._trim(db).catch(() => {});
        return id;
    }

    // ── Read / query ───────────────────────────────────────────────
    /**
     * List records with optional search/filter/sort. Reads all rows then filters in
     * memory — history is small (capped at MAX_RECORDS) and this keeps the predicate
     * logic simple and correct across compound filters.
     * @param {object} [opts]
     * @param {string} [opts.search] - case-insensitive substring over name/peer/files
     * @param {string} [opts.direction] - 'send' | 'receive'
     * @param {string} [opts.state] - 'success' | 'failed' | 'cancelled' | 'rejected'
     * @param {string} [opts.transferType]
     * @param {'date'|'size'|'name'} [opts.sortBy='date']
     * @param {'asc'|'desc'} [opts.order='desc']
     * @returns {Promise<object[]>}
     */
    async list(opts = {}) {
        const db = await this._ensure();
        const all = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        let rows = all;
        if (opts.direction) rows = rows.filter((r) => r.direction === opts.direction);
        if (opts.state) rows = rows.filter((r) => r.state === opts.state);
        if (opts.transferType) rows = rows.filter((r) => r.transferType === opts.transferType);
        if (opts.search) {
            const q = String(opts.search).toLowerCase();
            rows = rows.filter((r) => {
                const hay = [
                    r.name, r.peerName, ...(r.fileNames || []), ...(r.folderNames || []),
                ].filter(Boolean).join('\n').toLowerCase();
                return hay.includes(q);
            });
        }

        const sortBy = opts.sortBy || 'date';
        const dir = opts.order === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
            let cmp;
            if (sortBy === 'size') cmp = (a.totalBytes || 0) - (b.totalBytes || 0);
            else if (sortBy === 'name') cmp = String(a.name || '').localeCompare(String(b.name || ''));
            else cmp = (a.timestamp || 0) - (b.timestamp || 0);
            return cmp * dir;
        });
        return rows;
    }

    /** @returns {Promise<number>} total record count */
    async count() {
        const db = await this._ensure();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // ── Delete / export ────────────────────────────────────────────
    async delete(id) {
        const db = await this._ensure();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async clear() {
        const db = await this._ensure();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Export the full history as a JSON string the user can download/back up.
     * @returns {Promise<string>}
     */
    async export() {
        const rows = await this.list({ sortBy: 'date', order: 'asc' });
        return JSON.stringify({
            app: 'LinkSpan',
            kind: 'transfer-history',
            exportedAt: new Date().toISOString(),
            count: rows.length,
            records: rows,
        }, null, 2);
    }

    async _trim(db) {
        const total = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (total <= MAX_RECORDS) return;
        // Delete oldest by the timestamp index until back under the cap.
        const toDelete = total - MAX_RECORDS;
        await new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const idx = tx.objectStore(STORE).index('timestamp');
            let removed = 0;
            idx.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && removed < toDelete) {
                    cursor.delete();
                    removed += 1;
                    cursor.continue();
                }
            };
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    }
}

export { promisify as _promisify };
