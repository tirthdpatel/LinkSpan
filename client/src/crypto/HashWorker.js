/**
 * HashWorker — dedicated Web Worker for SHA-256 hashing.
 *
 * Offloads crypto.subtle.digest('SHA-256', ...) from the main thread's event loop.
 * The main thread sends { id, data } (data is an ArrayBuffer via Transferable) and
 * receives { id, hash } (hex string). Using Transferables means the buffer is
 * zero-copied into the worker — no serialization cost.
 *
 * Each worker handles multiple concurrent requests, correlated by `id`.
 */
self.onmessage = async (e) => {
    const { id, data } = e.data;
    try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = new Uint8Array(hashBuffer);
        const hex = Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
        self.postMessage({ id, hash: hex });
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
