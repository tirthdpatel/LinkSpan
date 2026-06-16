/**
 * DestinationManager — download-location selection (Feature 5).
 *
 * Where supported (Chromium-family browsers exposing the File System Access API),
 * the user can choose a real directory on disk as the transfer destination. A
 * received folder tree is then written into that directory preserving the exact
 * structure, relative paths and filenames — no ZIP, no extra unpacking step. The
 * chosen directory can be saved as the default (its handle is persisted in
 * IndexedDB and re-permissioned on next use), and overridden per transfer.
 *
 * Where the API is unavailable (Firefox, Safari, older browsers), callers fall back
 * to the existing ZIP/single-file download path. This module reports support so the
 * UI can offer the right affordance, and the write logic is dependency-injected so
 * it is unit-testable against a fake directory handle.
 *
 * Security: relative paths written here are already sanitized upstream
 * (PathSanitizer in FileTree/BatchReceiver), but writeTree re-validates every path
 * segment and refuses `.`/`..`/empty/absolute segments, so a crafted entry can never
 * escape the chosen directory (no arbitrary-file-write / traversal).
 */

const PREFS_DB = 'linkspan-prefs';
const PREFS_VERSION = 1;
const STORE = 'handles';
const DEFAULT_KEY = 'download-dir';

/** Is the File System Access directory picker available in this environment? */
export function isFsAccessSupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openPrefs() {
    return new Promise((resolve, reject) => {
        let request;
        try { request = indexedDB.open(PREFS_DB, PREFS_VERSION); }
        catch (err) { reject(err); return; }
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error || new Error('prefs db open failed'));
    });
}

/**
 * Validate a single path segment. Throws on anything that could escape the target
 * directory or is not a legal filename component.
 */
function assertSafeSegment(seg) {
    if (!seg || seg === '.' || seg === '..') {
        throw new Error(`Unsafe path segment: "${seg}"`);
    }
    // No path separators or NUL should survive a split, but be explicit.
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f]/.test(seg)) throw new Error(`Illegal path segment: "${seg}"`);
}

export class DestinationManager {
    constructor() {
        this._db = null;
    }

    async _prefs() {
        if (!this._db) this._db = await openPrefs();
        return this._db;
    }

    /** Prompt the user to choose a destination directory. @returns {Promise<FileSystemDirectoryHandle>} */
    async pickDirectory() {
        if (!isFsAccessSupported()) throw new Error('Directory selection is not supported in this browser.');
        return window.showDirectoryPicker({ id: 'linkspan-dest', mode: 'readwrite' });
    }

    /** Persist a directory handle as the default destination. */
    async saveDefault(handle) {
        const db = await this._prefs();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(handle, DEFAULT_KEY);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /** Forget the saved default destination. */
    async clearDefault() {
        const db = await this._prefs();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(DEFAULT_KEY);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Load the saved default destination handle, re-checking permission. Returns
     * null if none is saved or permission can no longer be (re)granted.
     * @param {boolean} [request=false] - actively re-prompt for permission if needed
     * @returns {Promise<FileSystemDirectoryHandle|null>}
     */
    async getDefault(request = false) {
        let handle;
        try {
            const db = await this._prefs();
            handle = await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const req = tx.objectStore(STORE).get(DEFAULT_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch {
            return null;
        }
        if (!handle) return null;
        const ok = await ensurePermission(handle, request);
        return ok ? handle : null;
    }

    /**
     * Write a reconstructed tree into a directory handle, preserving structure.
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {Array<{ name: string, blob?: Blob, dir?: boolean }>} entries
     * @returns {Promise<{ files: number, directories: number }>}
     */
    async writeTree(dirHandle, entries) {
        let files = 0;
        let directories = 0;
        const dirCache = new Map([['', dirHandle]]);

        const ensureDir = async (relDir) => {
            if (dirCache.has(relDir)) return dirCache.get(relDir);
            const segs = relDir.split('/').filter(Boolean);
            let cur = dirHandle;
            let acc = '';
            for (const seg of segs) {
                assertSafeSegment(seg);
                acc = acc ? `${acc}/${seg}` : seg;
                if (dirCache.has(acc)) { cur = dirCache.get(acc); continue; }
                cur = await cur.getDirectoryHandle(seg, { create: true });
                dirCache.set(acc, cur);
            }
            return cur;
        };

        // Create explicit (incl. empty) directories first.
        for (const entry of entries) {
            if (entry.dir) {
                const clean = String(entry.name).replace(/\/+$/, '');
                await ensureDir(clean);
                directories += 1;
            }
        }
        // Then write files.
        for (const entry of entries) {
            if (entry.dir) continue;
            const parts = String(entry.name).split('/').filter(Boolean);
            const fileName = parts.pop();
            assertSafeSegment(fileName);
            const parent = await ensureDir(parts.join('/'));
            const fh = await parent.getFileHandle(fileName, { create: true });
            const writable = await fh.createWritable();
            try {
                await writable.write(entry.blob);
            } finally {
                await writable.close();
            }
            files += 1;
        }
        return { files, directories };
    }

    /**
     * Write a single file (which may itself carry a relative subpath) into a
     * directory handle.
     */
    async writeFile(dirHandle, name, blob) {
        return this.writeTree(dirHandle, [{ name, blob }]);
    }
}

/**
 * Query (and optionally request) readwrite permission on a handle.
 * @param {any} handle
 * @param {boolean} request
 * @returns {Promise<boolean>}
 */
export async function ensurePermission(handle, request = false) {
    try {
        if (typeof handle.queryPermission !== 'function') return true; // non-FS handle (tests)
        const opts = { mode: 'readwrite' };
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        if (request && typeof handle.requestPermission === 'function') {
            return (await handle.requestPermission(opts)) === 'granted';
        }
        return false;
    } catch {
        return false;
    }
}
