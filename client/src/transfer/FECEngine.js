/**
 * FECEngine — Forward Error Correction for lossy intercontinental links.
 *
 * On paths with 2–5% loss, each lost chunk costs 1+ RTT (~200ms) for the retransmission
 * round-trip. FEC lets the receiver reconstruct a single lost chunk from XOR parity data
 * without needing a round-trip, eliminating the most expensive retransmissions.
 *
 * **Sender side (FECEncoder):**
 *   - Buffers every N ciphertext chunks (a "FEC group")
 *   - After N chunks, XORs all N together → emits a parity buffer
 *   - Group size N is adaptive: scales with observed loss rate
 *
 * **Receiver side (FECDecoder):**
 *   - Tracks which chunks in each group have arrived
 *   - If exactly 1 chunk is missing after parity arrives, reconstructs via XOR
 *   - If ≥2 missing: falls back to standard retransmission (CHUNK_REQUEST)
 *
 * The XOR approach is deliberately simple — it adds negligible CPU overhead,
 * requires no complex algebra (like Reed-Solomon), and handles the 90th-percentile
 * case (single-loss in a group) that dominates real intercontinental transfers.
 */

export const FEC_MIN_GROUP = 4;
export const FEC_MAX_GROUP = 16;
export const FEC_DEFAULT_GROUP = 8;

// Parity frames reuse the chunk binary framing (ChunkManager.pack/unpackChunk), which
// carries the index as an *unsigned* 32-bit big-endian value. Real chunk indices are
// tiny (a 512 TB file at 256 KB chunks is still < 2^31), so parity frames are namespaced
// into the top of the u32 range: index = FEC_PARITY_INDEX_MAX - groupId. Any unpacked
// index with the high bit set is therefore a parity frame, not a data chunk.
export const FEC_PARITY_INDEX_MAX = 0xFFFFFFFF;
export const FEC_PARITY_INDEX_THRESHOLD = 0x80000000;
/** Synthetic frame index the sender packs a group's parity under. */
export function fecParityIndex(groupId) { return FEC_PARITY_INDEX_MAX - groupId; }
/** Recover the groupId from a parity frame's unpacked index. */
export function fecGroupFromIndex(index) { return FEC_PARITY_INDEX_MAX - index; }
/** True if an unpacked frame index denotes FEC parity rather than a data chunk. */
export function isFecParityIndex(index) { return index >= FEC_PARITY_INDEX_THRESHOLD; }

/**
 * Compute adaptive FEC group size from measured loss rate.
 * At 0% loss: max group (less parity overhead). At 5%+: small groups (more protection).
 * @param {number} lossRate - fraction (0.0 to 1.0)
 * @returns {number} group size
 */
export function adaptiveGroupSize(lossRate) {
    if (!Number.isFinite(lossRate) || lossRate <= 0) return FEC_MAX_GROUP;
    return Math.max(FEC_MIN_GROUP, Math.min(FEC_MAX_GROUP, Math.floor(1 / lossRate)));
}

/**
 * XOR two ArrayBuffers of equal length.
 * @param {ArrayBuffer} a
 * @param {ArrayBuffer} b
 * @returns {ArrayBuffer}
 */
function xorBuffers(a, b) {
    const len = Math.max(a.byteLength, b.byteLength);
    const result = new Uint8Array(len);
    const viewA = new Uint8Array(a);
    const viewB = new Uint8Array(b);
    for (let i = 0; i < len; i++) {
        result[i] = (viewA[i] || 0) ^ (viewB[i] || 0);
    }
    return result.buffer;
}

// ── Sender ──────────────────────────────────────────────────

export class FECEncoder {
    /**
     * @param {number} [groupSize=FEC_DEFAULT_GROUP] - chunks per FEC group
     */
    constructor(groupSize = FEC_DEFAULT_GROUP) {
        this.groupSize = Math.max(FEC_MIN_GROUP, Math.min(FEC_MAX_GROUP, groupSize));
        /** @type {Map<number, ArrayBuffer>} index within group → ciphertext */
        this._groupBuffers = new Map();
        /** current group ID (0-indexed) */
        this._currentGroupId = 0;
        /** chunks seen in the current group */
        this._groupCount = 0;
        /** starting chunk index of the current group */
        this._groupStart = 0;
    }

    /**
     * Feed a chunk's ciphertext into the FEC encoder.
     * Returns a parity message when the group is complete, else null.
     * @param {number} chunkIndex - global chunk index
     * @param {ArrayBuffer} ciphertext - the encrypted (or plaintext) chunk data
     * @returns {{ groupId: number, groupStart: number, groupSize: number, parityData: ArrayBuffer } | null}
     */
    addChunk(chunkIndex, ciphertext) {
        this._groupBuffers.set(this._groupCount, ciphertext);
        this._groupCount++;

        if (this._groupCount >= this.groupSize) {
            // Group complete — compute XOR parity
            const parity = this._computeParity();
            const result = {
                groupId: this._currentGroupId,
                groupStart: this._groupStart,
                groupSize: this._groupCount,
                parityData: parity,
                // Per-chunk ciphertext lengths, in group order. The receiver needs
                // these to trim a reconstructed (zero-padded) chunk back to its exact
                // ciphertext length — GCM decryption rejects a wrong-length input, so
                // this is what makes FEC work when per-chunk compression varies sizes.
                chunkLengths: this._groupChunkLengths(),
            };

            // Reset for next group
            this._currentGroupId++;
            this._groupStart = chunkIndex + 1;
            this._groupCount = 0;
            this._groupBuffers.clear();

            return result;
        }

        return null;
    }

    /**
     * Flush any partial group at end-of-file.
     * @returns {{ groupId: number, groupStart: number, groupSize: number, parityData: ArrayBuffer } | null}
     */
    flush() {
        if (this._groupCount < 2) return null; // need at least 2 chunks to make parity useful
        const parity = this._computeParity();
        return {
            groupId: this._currentGroupId,
            groupStart: this._groupStart,
            groupSize: this._groupCount,
            parityData: parity,
            chunkLengths: this._groupChunkLengths(),
        };
    }

    /**
     * Update group size (e.g. after measuring loss rate).
     * Takes effect on the NEXT group (current group is unaffected).
     * @param {number} newSize
     */
    setGroupSize(newSize) {
        this.groupSize = Math.max(FEC_MIN_GROUP, Math.min(FEC_MAX_GROUP, newSize));
    }

    _computeParity() {
        let parity = null;
        for (const [, buf] of this._groupBuffers) {
            parity = parity === null ? buf.slice(0) : xorBuffers(parity, buf);
        }
        return parity;
    }

    /** Ciphertext byte lengths for the current group, in local (0..n-1) order. */
    _groupChunkLengths() {
        const lengths = [];
        for (let i = 0; i < this._groupCount; i++) {
            lengths.push(this._groupBuffers.get(i)?.byteLength ?? 0);
        }
        return lengths;
    }
}

// ── Receiver ────────────────────────────────────────────────

export class FECDecoder {
    constructor() {
        /**
         * @type {Map<number, {
         *   groupStart: number,
         *   groupSize: number,
         *   parityData: ArrayBuffer,
         *   receivedChunks: Map<number, ArrayBuffer>,
         * }>}
         * groupId → group state
         */
        this._groups = new Map();
    }

    /**
     * Register a received chunk with its FEC group.
     * @param {number} chunkIndex - global chunk index
     * @param {ArrayBuffer} data - the chunk's ciphertext/plaintext
     * @param {number} groupId - which FEC group this chunk belongs to
     */
    addChunk(chunkIndex, data, groupId) {
        const group = this._groups.get(groupId);
        if (!group) return; // parity hasn't arrived yet; chunk is stored elsewhere
        group.receivedChunks.set(chunkIndex, data);
    }

    /**
     * Register parity data for a group.
     * @param {number} groupId
     * @param {number} groupStart - first chunk index in the group
     * @param {number} groupSize - number of chunks in the group
     * @param {ArrayBuffer} parityData
     * @param {number[]} [chunkLengths] - exact ciphertext length of each chunk in the
     *        group (local order). When provided, a reconstructed chunk is trimmed to
     *        its true length so GCM decryption accepts it. Omit for equal-length groups.
     */
    addParity(groupId, groupStart, groupSize, parityData, chunkLengths = null) {
        if (!this._groups.has(groupId)) {
            this._groups.set(groupId, {
                groupStart,
                groupSize,
                parityData,
                chunkLengths,
                receivedChunks: new Map(),
            });
        } else {
            const g = this._groups.get(groupId);
            g.parityData = parityData;
            g.groupStart = groupStart;
            g.groupSize = groupSize;
            g.chunkLengths = chunkLengths;
        }
    }

    /**
     * Find the id of a known (parity-registered) group that contains a chunk index,
     * or null. Used by the receiver to route received ciphertext into the right group
     * without needing the sender to tag every chunk with its group id.
     * @param {number} chunkIndex
     * @returns {number|null}
     */
    groupIdForIndex(chunkIndex) {
        for (const [groupId, g] of this._groups) {
            if (chunkIndex >= g.groupStart && chunkIndex < g.groupStart + g.groupSize) {
                return groupId;
            }
        }
        return null;
    }

    /**
     * Try to reconstruct a missing chunk using FEC parity.
     * @param {number} groupId
     * @returns {{ chunkIndex: number, data: ArrayBuffer } | null}
     *   Null if recovery is impossible (0 or 2+ chunks missing).
     */
    tryReconstruct(groupId) {
        const group = this._groups.get(groupId);
        if (!group || !group.parityData) return null;

        // Find missing chunk indices
        const missing = [];
        for (let i = 0; i < group.groupSize; i++) {
            const globalIndex = group.groupStart + i;
            if (!group.receivedChunks.has(globalIndex)) {
                missing.push(globalIndex);
            }
        }

        // Can only reconstruct if exactly 1 chunk is missing
        if (missing.length !== 1) return null;

        const missingIndex = missing[0];

        // Reconstruct: missing = parity XOR all_received_in_group
        let recovered = group.parityData.slice(0);
        for (const [, buf] of group.receivedChunks) {
            recovered = xorBuffers(recovered, buf);
        }

        // Trim to the missing chunk's exact ciphertext length. XOR pads every buffer
        // to the group's max length, so without this the recovered buffer carries
        // trailing zero bytes and GCM decryption of it fails. chunkLengths is indexed
        // by LOCAL position within the group.
        if (group.chunkLengths) {
            const localIndex = missingIndex - group.groupStart;
            const trueLen = group.chunkLengths[localIndex];
            if (Number.isInteger(trueLen) && trueLen >= 0 && trueLen < recovered.byteLength) {
                recovered = recovered.slice(0, trueLen);
            }
        }

        return { chunkIndex: missingIndex, data: recovered };
    }

    /**
     * Check if a group has all chunks (no reconstruction needed).
     * @param {number} groupId
     * @returns {boolean}
     */
    isGroupComplete(groupId) {
        const group = this._groups.get(groupId);
        if (!group) return false;
        return group.receivedChunks.size >= group.groupSize;
    }

    /**
     * Clean up a completed group to free memory.
     * @param {number} groupId
     */
    removeGroup(groupId) {
        this._groups.delete(groupId);
    }

    /** Clear all groups. */
    clear() {
        this._groups.clear();
    }
}
