/**
 * LinkSpan — Chunk range codec (shared by both peers and the future swarm).
 *
 * A "range" is `{ start, count }` describing `count` consecutive chunk indices
 * beginning at `start` (i.e. indices start, start+1, …, start+count-1). Range-lists
 * are the primary wire format for CHUNK_REQUEST_RANGE: the receiver coalesces the
 * chunks it wants into as few ranges as possible, so a contiguous window of N chunks
 * costs one control frame instead of N.
 *
 * Design notes:
 * - Pure and dependency-free — usable from the client, the server, and a future
 *   swarm scheduler (which can hand each peer a DISJOINT subset of ranges). The codec
 *   is deliberately NOT coupled to a single channel or transfer.
 * - Bitmap-ready, not bitmap-yet: ranges are the format on the wire today, but
 *   capability negotiation is modelled as a set (see TRANSFER_CAPABILITY), so a
 *   future `supportsBitfield` can coexist with `supportsRangeRequest` without another
 *   protocol redesign. No bitmap is implemented here.
 */

/**
 * Merge a list of chunk indices into the minimal list of consecutive ranges.
 * Input may be unsorted and contain duplicates; output is sorted, de-duplicated,
 * and has no adjacent or overlapping ranges.
 *
 * @param {number[]} indices - chunk indices (any order, dupes allowed)
 * @returns {{start: number, count: number}[]} minimal range-list
 */
export function chunksToRanges(indices) {
    if (!Array.isArray(indices) || indices.length === 0) return [];

    // Sort ascending + de-dupe. Ignore non-integers / negatives defensively.
    const sorted = [...new Set(indices)]
        .filter((n) => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        const n = sorted[i];
        if (n === prev + 1) {
            prev = n; // extend the current run
        } else {
            ranges.push({ start, count: prev - start + 1 });
            start = n;
            prev = n;
        }
    }
    ranges.push({ start, count: prev - start + 1 });
    return ranges;
}

/**
 * Expand a range-list back into a flat, ascending list of chunk indices.
 * Assumes the ranges are already valid (call validateRanges first for untrusted input).
 *
 * @param {{start: number, count: number}[]} ranges
 * @returns {number[]} chunk indices
 */
export function rangesToChunks(ranges) {
    if (!Array.isArray(ranges)) return [];
    const out = [];
    for (const r of ranges) {
        for (let i = 0; i < r.count; i++) out.push(r.start + i);
    }
    return out;
}

/**
 * Validate an UNTRUSTED range-list received from a peer, against the known total
 * chunk count. Rejects malformed, negative, zero-count, out-of-bounds, and
 * overlapping ranges. On success returns a normalized copy (sorted by start with
 * adjacent ranges merged); on failure throws an Error describing the first problem.
 *
 * Overlap/adjacency are checked on the sorted input BEFORE merging so a hostile or
 * buggy peer can't smuggle duplicate work or an inflated expansion past the cap.
 *
 * @param {unknown} ranges
 * @param {number} totalChunks - the file's chunk count (exclusive upper bound)
 * @returns {{start: number, count: number}[]} normalized ranges
 * @throws {Error} on any invalid range
 */
export function validateRanges(ranges, totalChunks) {
    if (!Array.isArray(ranges)) throw new Error('ranges must be an array');
    if (ranges.length === 0) throw new Error('ranges must not be empty');
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
        throw new Error('totalChunks must be a positive integer');
    }

    const clean = ranges.map((r, i) => {
        if (!r || typeof r !== 'object') throw new Error(`range[${i}] is not an object`);
        const { start, count } = r;
        if (!Number.isInteger(start) || start < 0) {
            throw new Error(`range[${i}].start must be a non-negative integer`);
        }
        if (!Number.isInteger(count) || count <= 0) {
            throw new Error(`range[${i}].count must be a positive integer`);
        }
        if (start + count > totalChunks) {
            throw new Error(
                `range[${i}] [${start}..${start + count - 1}] exceeds totalChunks=${totalChunks}`
            );
        }
        return { start, count };
    });

    // Sort by start, then detect overlap and merge adjacent runs.
    clean.sort((a, b) => a.start - b.start);
    const normalized = [];
    for (const r of clean) {
        const last = normalized[normalized.length - 1];
        if (last) {
            const lastEnd = last.start + last.count; // exclusive
            if (r.start < lastEnd) {
                throw new Error(
                    `overlapping ranges: [${last.start}..${lastEnd - 1}] and ` +
                    `[${r.start}..${r.start + r.count - 1}]`
                );
            }
            if (r.start === lastEnd) {
                last.count += r.count; // adjacent — normalize into one range
                continue;
            }
        }
        normalized.push({ ...r });
    }
    return normalized;
}

/**
 * Capability flags advertised in FILE_META / the handshake. Modelled as a set so
 * additional chunk-request formats (e.g. a future bitfield) negotiate independently.
 */
export const TRANSFER_CAPABILITY = Object.freeze({
    RANGE_REQUEST: 'supportsRangeRequest',
    // BITFIELD: 'supportsBitfield',  // reserved — not implemented
});
