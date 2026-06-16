/**
 * ZipBuilder — minimal, dependency-free ZIP archive writer (STORE method).
 *
 * Used by the receiver to reconstruct a folder / multi-file batch into a single
 * downloadable archive that unpacks to the exact original directory tree on every
 * OS. We use the STORE method (no compression) deliberately:
 *   - chunks already crossed the wire encrypted/already-compressed; re-compressing
 *     wastes CPU on the receiver (often a phone) for little gain;
 *   - STORE lets us stream file bytes straight from Blobs without buffering whole
 *     files in memory.
 *
 * ZIP64 is emitted automatically when any entry, the archive, the entry count, or
 * an offset exceeds the 32-bit ZIP limits, so multi-gigabyte folders and
 * >65535-file batches produce valid archives.
 *
 * The output is a Blob assembled from header byte arrays interleaved with the
 * original file Blobs — the browser never holds the whole archive in memory.
 */

const ZIP64_THRESHOLD = 0xffffffff;
const U16_MAX = 0xffff;

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32Update(crc, bytes) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Compute the CRC32 of a Blob by streaming it in slices (bounded memory).
 * @param {Blob} blob
 * @param {number} [sliceSize]
 * @returns {Promise<number>}
 */
async function crc32OfBlob(blob, sliceSize = 4 * 1024 * 1024) {
    let crc = 0;
    for (let off = 0; off < blob.size; off += sliceSize) {
        const slice = blob.slice(off, Math.min(off + sliceSize, blob.size));
        const buf = new Uint8Array(await slice.arrayBuffer());
        crc = crc32Update(crc, buf);
    }
    return crc;
}

// ── Little-endian byte writers ───────────────────────────────────────────────
function u16(v) {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
function u32(v) {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
/** 64-bit little-endian from a JS number (safe up to 2^53). */
function u64(v) {
    const out = new Uint8Array(8);
    let n = BigInt(v);
    for (let i = 0; i < 8; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}

function concat(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrays) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

/** Convert a JS Date to DOS time/date fields. */
function dosDateTime(date) {
    const t =
        (Math.floor(date.getSeconds() / 2)) |
        (date.getMinutes() << 5) |
        (date.getHours() << 11);
    const d =
        date.getDate() |
        ((date.getMonth() + 1) << 5) |
        ((Math.max(1980, date.getFullYear()) - 1980) << 9);
    return { time: t & 0xffff, date: d & 0xffff };
}

/**
 * Build a ZIP archive (STORE) from a list of entries.
 *
 * @param {Array<{ name: string, blob?: Blob, dir?: boolean }>} entries
 *   Each entry is either a file (with a Blob) or a directory (dir:true). Directory
 *   names are stored with a trailing '/'. Names must already be sanitized POSIX
 *   relative paths (see PathSanitizer).
 * @param {Date} [now]
 * @returns {Promise<Blob>}
 */
export async function buildZip(entries, now = new Date()) {
    const { time, date } = dosDateTime(now);
    const parts = []; // Blob | Uint8Array, in archive order
    const central = []; // central directory records
    let offset = 0; // running offset into the archive (number; promoted to BigInt math via u64)

    const textEncoder = new TextEncoder();

    for (const entry of entries) {
        const isDir = !!entry.dir;
        let name = entry.name;
        if (isDir && !name.endsWith('/')) name += '/';
        const nameBytes = textEncoder.encode(name);

        const blob = isDir ? null : entry.blob;
        const size = isDir ? 0 : blob.size;
        const crc = isDir ? 0 : await crc32OfBlob(blob);

        const needsZip64 = size >= ZIP64_THRESHOLD || offset >= ZIP64_THRESHOLD;

        // General purpose bit 11 = filename is UTF-8.
        const gpFlag = 0x0800;

        // ── Local file header ──────────────────────────────────────────────
        const localZip64Extra = needsZip64
            ? concat([u16(0x0001), u16(16), u64(size), u64(size)])
            : new Uint8Array(0);

        const localHeader = concat([
            u32(0x04034b50),                       // local file header signature
            u16(needsZip64 ? 45 : 20),             // version needed (4.5 for zip64, else 2.0)
            u16(gpFlag),                           // general purpose bit flag
            u16(0),                                // compression method = store
            u16(time),                             // last mod time
            u16(date),                             // last mod date
            u32(crc),                              // CRC-32
            u32(needsZip64 ? ZIP64_THRESHOLD : size), // compressed size
            u32(needsZip64 ? ZIP64_THRESHOLD : size), // uncompressed size
            u16(nameBytes.length),                 // file name length
            u16(localZip64Extra.length),           // extra field length
            nameBytes,
            localZip64Extra,
        ]);

        const localHeaderOffset = offset;
        parts.push(localHeader);
        offset += localHeader.length;
        if (blob && size > 0) {
            parts.push(blob);
            offset += size;
        }

        // ── Central directory record ───────────────────────────────────────
        const needsOffsetZip64 = localHeaderOffset >= ZIP64_THRESHOLD;
        const cdZip64Fields = [];
        if (size >= ZIP64_THRESHOLD) {
            cdZip64Fields.push(u64(size), u64(size));
        }
        if (needsOffsetZip64) {
            cdZip64Fields.push(u64(localHeaderOffset));
        }
        const cdZip64Extra = cdZip64Fields.length
            ? concat([u16(0x0001), u16(cdZip64Fields.reduce((n, f) => n + f.length, 0)), ...cdZip64Fields])
            : new Uint8Array(0);

        const useZip64Here = cdZip64Extra.length > 0;
        const externalAttrs = isDir ? 0x41ed0010 : 0x81a40000; // dir 0755 | file 0644

        central.push(concat([
            u32(0x02014b50),                                          // central dir signature
            u16(needsZip64 || useZip64Here ? 45 : 20),                // version made by
            u16(useZip64Here ? 45 : 20),                              // version needed
            u16(gpFlag),
            u16(0),                                                   // store
            u16(time),
            u16(date),
            u32(crc),
            u32(size >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : size),    // compressed size
            u32(size >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : size),    // uncompressed size
            u16(nameBytes.length),
            u16(cdZip64Extra.length),                                 // extra length
            u16(0),                                                   // comment length
            u16(0),                                                   // disk number start
            u16(0),                                                   // internal attrs
            u32(externalAttrs),                                       // external attrs
            u32(needsOffsetZip64 ? ZIP64_THRESHOLD : localHeaderOffset), // local header offset
            nameBytes,
            cdZip64Extra,
        ]));
    }

    // ── Central directory + end records ────────────────────────────────────
    const centralStart = offset;
    const centralBytes = concat(central);
    const centralSize = centralBytes.length;
    parts.push(centralBytes);
    offset += centralSize;

    const count = entries.length;
    const needsEocdZip64 =
        count > U16_MAX ||
        centralStart >= ZIP64_THRESHOLD ||
        centralSize >= ZIP64_THRESHOLD;

    if (needsEocdZip64) {
        // ZIP64 end of central directory record
        const zip64Eocd = concat([
            u32(0x06064b50),
            u64(44),                 // size of remaining zip64 EOCD record
            u16(45),                 // version made by
            u16(45),                 // version needed
            u32(0),                  // this disk
            u32(0),                  // disk with central dir start
            u64(count),              // entries on this disk
            u64(count),              // total entries
            u64(centralSize),
            u64(centralStart),
        ]);
        parts.push(zip64Eocd);

        // ZIP64 end of central directory locator
        const zip64Locator = concat([
            u32(0x07064b50),
            u32(0),                  // disk with zip64 EOCD
            u64(offset),             // offset of zip64 EOCD
            u32(1),                  // total disks
        ]);
        parts.push(zip64Locator);
    }

    // Standard end of central directory record (always present).
    const eocd = concat([
        u32(0x06054b50),
        u16(0),                                                       // disk number
        u16(0),                                                       // disk w/ central dir
        u16(count > U16_MAX ? U16_MAX : count),                       // entries this disk
        u16(count > U16_MAX ? U16_MAX : count),                       // total entries
        u32(centralSize >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : centralSize),
        u32(centralStart >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : centralStart),
        u16(0),                                                       // comment length
    ]);
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
}

// Exposed for unit testing.
export const _internal = { crc32Update, crc32OfBlob, dosDateTime };
