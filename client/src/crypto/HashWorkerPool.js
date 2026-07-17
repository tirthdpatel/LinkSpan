/**
 * HashWorkerPool — manages a small pool of Web Workers for off-main-thread SHA-256.
 *
 * On the sender side, each chunk is read → hashed → encrypted → sent. The hash step
 * previously ran via crypto.subtle.digest on the main thread — while the digest itself
 * is async and happens off-thread in the browser's crypto implementation, the
 * orchestration (hex encoding, Map bookkeeping, promise management) still occupies the
 * main-thread event loop for every chunk. At SENDER_CONCURRENCY=8+ and 256 KB chunks,
 * the cumulative overhead is measurable by BottleneckMonitor as a CPU bottleneck.
 *
 * This pool spawns 1–2 workers (more shows diminishing returns) and round-robins hash
 * requests across them. Each request transfers the ArrayBuffer (zero-copy via
 * Transferable) and gets back a hex hash. Falls back to main-thread hashing if Worker
 * creation fails (CSP restrictions, Safari quirks, non-secure context).
 *
 * Usage:
 *   const pool = new HashWorkerPool(2);
 *   const hex = await pool.hash(data);  // data is ArrayBuffer
 *   pool.terminate();                   // cleanup on transfer complete
 */
export class HashWorkerPool {
    /**
     * @param {number} [size=2] - number of workers in the pool
     */
    constructor(size = 2) {
        /** @type {Worker[]} */
        this._workers = [];
        /** @type {Map<number, { resolve: Function, reject: Function }>} */
        this._pending = new Map();
        this._nextId = 0;
        this._nextWorker = 0;
        this._alive = true;

        try {
            for (let i = 0; i < size; i++) {
                const worker = new Worker(
                    new URL('./HashWorker.js', import.meta.url),
                    { type: 'module' }
                );
                worker.onmessage = (e) => this._onMessage(e);
                worker.onerror = (e) => this._onError(e);
                this._workers.push(worker);
            }
        } catch {
            // Worker creation failed — pool.hash() will fall back to main-thread.
            this._alive = false;
        }
    }

    /** Whether the pool is functional (workers spawned successfully). */
    get available() {
        return this._alive && this._workers.length > 0;
    }

    /**
     * Hash an ArrayBuffer using the worker pool.
     * The buffer is transferred (zero-copy), so it becomes unusable in the caller
     * after this call. If the caller needs the data afterward, slice it first.
     *
     * Falls back to main-thread hashing if the pool is unavailable.
     *
     * @param {ArrayBuffer} data
     * @returns {Promise<string>} hex-encoded SHA-256
     */
    async hash(data) {
        if (!this.available) {
            return HashWorkerPool._mainThreadHash(data);
        }

        const id = this._nextId++;
        const workerIdx = this._nextWorker;
        this._nextWorker = (this._nextWorker + 1) % this._workers.length;

        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                this._workers[workerIdx].postMessage({ id, data }, [data]);
            } catch (err) {
                this._pending.delete(id);
                // Transferable failed — fall back to main-thread
                HashWorkerPool._mainThreadHash(data).then(resolve, reject);
            }
        });
    }

    /** Terminate all workers. Idempotent. */
    terminate() {
        this._alive = false;
        for (const w of this._workers) {
            try { w.terminate(); } catch { /* noop */ }
        }
        this._workers = [];
        // Reject any pending requests
        for (const [, { reject }] of this._pending) {
            reject(new Error('HashWorkerPool terminated'));
        }
        this._pending.clear();
    }

    // ── Private ────────────────────────────────────────────────

    _onMessage(e) {
        const { id, hash, error } = e.data;
        const entry = this._pending.get(id);
        if (!entry) return;
        this._pending.delete(id);
        if (error) {
            entry.reject(new Error(error));
        } else {
            entry.resolve(hash);
        }
    }

    _onError(e) {
        // Worker crashed — terminate pool and let future calls fall back
        console.warn('[HashWorkerPool] Worker error, falling back to main thread:', e.message);
        this.terminate();
    }

    /**
     * Main-thread fallback: identical to IntegrityVerifier.hash() but without
     * creating a circular dependency.
     * @param {ArrayBuffer} data
     * @returns {Promise<string>}
     */
    static async _mainThreadHash(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = new Uint8Array(hashBuffer);
        return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
    }
}
