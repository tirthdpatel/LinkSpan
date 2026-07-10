/**
 * Compression — per-chunk DEFLATE (zlib), applied INSIDE encryption and OUTSIDE hashing.
 * ('deflate', not 'deflate-raw': the latter isn't supported by CompressionStream on Node 18,
 * which would silently disable compression under test.)
 *
 * Wire ordering per chunk (proto 1.8.0):
 *   sender:   plaintext → hash(plaintext) → maybeCompress(plaintext) → encrypt(bytes) → wire
 *   receiver: wire → decrypt(bytes) → maybeDecompress(bytes, compressed) → verify(hash)
 *
 * The per-chunk `compressed` flag rides in the CHUNK_DATA metadata frame. Compression is
 * applied only when it actually shrinks the chunk (already-compressed media — mp4/jpg/zip —
 * gets `compressed:false` and is sent verbatim, so we never pay to expand it). Hashing stays
 * over the PLAINTEXT so integrity/manifest semantics are unchanged regardless of compression.
 *
 * Uses the standard CompressionStream/DecompressionStream (browsers + Node 18+). If the
 * runtime lacks them, maybeCompress transparently returns the input uncompressed, so the
 * transfer still works — just without the size win.
 */

/** True when the runtime can (de)compress. When false, everything is sent verbatim. */
export const compressionSupported =
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

// Formats whose bytes are already compressed (media, containers, archives).
// Re-deflating them can't shrink them and just burns CPU — for a 14 GB H.264 video
// that's ~57k chunks deflated and thrown away. We decide ONCE per file (by MIME or
// extension) and skip compression for every chunk when it can't help. Anything not
// listed keeps the safe per-chunk "compress only if it actually shrinks" behavior.
const INCOMPRESSIBLE_EXTENSIONS = new Set([
    // video
    'mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', '3gp',
    // audio
    'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'wma',
    // already-compressed raster images
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif',
    // archives / compressed streams
    'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'br', 'lz4', 'cab',
    // already-zipped document/app containers
    'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'apk', 'jar', 'epub',
]);

function extensionOf(name) {
    if (typeof name !== 'string') return '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Whether a whole file is worth attempting to compress. Already-compressed
 * media/containers return false so the sender skips deflate entirely for them.
 * Unknown types return true and fall back to the per-chunk shrink check, so we
 * never lose a real compression win (text, logs, uncompressed images, etc.).
 * @param {{ name?: string, type?: string }} [file]
 * @returns {boolean}
 */
export function isFileCompressible(file = {}) {
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('video/') || type.startsWith('audio/')) return false;
    // Compressed raster images only — bmp/tiff/svg stay compressible.
    if (/^image\/(jpeg|png|gif|webp|heic|heif|avif)$/.test(type)) return false;
    if (/(zip|gzip|x-7z|x-rar|x-xz|zstd|x-bzip|compress)/.test(type)) return false;
    if (type === 'application/pdf') return false;
    return !INCOMPRESSIBLE_EXTENSIONS.has(extensionOf(file.name));
}

async function streamThrough(input, stream) {
    const src = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    const out = new Response(new Blob([src]).stream().pipeThrough(stream));
    return out.arrayBuffer();
}

/** Raw-DEFLATE compress an ArrayBuffer. @returns {Promise<ArrayBuffer>} */
export async function deflateRaw(input) {
    return streamThrough(input, new CompressionStream('deflate'));
}

/** Raw-DEFLATE decompress an ArrayBuffer. @returns {Promise<ArrayBuffer>} */
export async function inflateRaw(input) {
    return streamThrough(input, new DecompressionStream('deflate'));
}

/**
 * Compress a plaintext chunk only if it shrinks. Callers put `compressed` in CHUNK_DATA
 * metadata and send `data` as the (pre-encryption) payload.
 * @param {ArrayBuffer} plaintext
 * @returns {Promise<{ data: ArrayBuffer, compressed: boolean }>}
 */
export async function maybeCompress(plaintext) {
    if (!compressionSupported || plaintext.byteLength === 0) {
        return { data: plaintext, compressed: false };
    }
    try {
        const deflated = await deflateRaw(plaintext);
        // Only worth it if smaller — incompressible data (media) stays verbatim.
        if (deflated.byteLength < plaintext.byteLength) {
            return { data: deflated, compressed: true };
        }
    } catch {
        /* fall through to verbatim on any codec error */
    }
    return { data: plaintext, compressed: false };
}

/**
 * Reverse maybeCompress: inflate when the sender marked the chunk compressed.
 * @param {ArrayBuffer} data - the decrypted payload bytes
 * @param {boolean} compressed - the CHUNK_DATA metadata flag
 * @returns {Promise<ArrayBuffer>} the original plaintext
 */
export async function maybeDecompress(data, compressed) {
    if (!compressed) return data;
    return inflateRaw(data);
}
