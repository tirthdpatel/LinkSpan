/**
 * blobReader — read a Blob/File into one ArrayBuffer via sequential slices.
 *
 * Why not just `blob.arrayBuffer()`? On mobile browsers a single whole-file read of a
 * large file (a screen recording, say) throws `NotReadableError` — the OS content
 * provider streams the file and can't satisfy one giant read, and the peak allocation
 * hits memory limits. The P2P transfer path never sees this because ChunkManager reads
 * 256 KB slices on demand; the share-link path did a whole-file read and failed.
 *
 * Reading in slices mirrors the proven P2P path: each `slice().arrayBuffer()` is a small,
 * satisfiable read, and a transient failure is retried before giving up.
 */

const DEFAULT_SLICE_BYTES = 4 * 1024 * 1024; // 4 MB — big enough to be few reads, small enough to always satisfy
const DEFAULT_RETRIES = 2;

/** A NotReadableError is often transient on mobile (provider hiccup) — worth one retry. */
async function readSliceWithRetry(slice, retries) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await slice.arrayBuffer();
        } catch (err) {
            lastErr = err;
            // Small backoff so a momentarily-busy provider can recover.
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
    }
    throw lastErr;
}

/**
 * Read the whole blob into a single ArrayBuffer using sliced reads.
 * @param {Blob} blob
 * @param {{ sliceBytes?: number, retries?: number }} [opts]
 * @returns {Promise<ArrayBuffer>}
 */
export async function readBlobToArrayBuffer(blob, opts = {}) {
    const sliceBytes = opts.sliceBytes ?? DEFAULT_SLICE_BYTES;
    const retries = opts.retries ?? DEFAULT_RETRIES;

    // Small files: one read is fine and avoids an extra copy.
    if (blob.size <= sliceBytes) {
        return readSliceWithRetry(blob, retries);
    }

    const out = new Uint8Array(blob.size);
    let offset = 0;
    while (offset < blob.size) {
        const end = Math.min(offset + sliceBytes, blob.size);
        const part = await readSliceWithRetry(blob.slice(offset, end), retries);
        out.set(new Uint8Array(part), offset);
        offset = end;
    }
    return out.buffer;
}
