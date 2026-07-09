/**
 * IntegrityVerifier — SHA-256 per-chunk and full-file integrity verification.
 */
export class IntegrityVerifier {
    /**
     * Compute SHA-256 hash of an ArrayBuffer.
     * @param {ArrayBuffer} data
     * @returns {Promise<string>} hex-encoded hash
     */
    static async hash(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = new Uint8Array(hashBuffer);
        return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Verify a chunk's integrity.
     * @param {ArrayBuffer} data
     * @param {string} expectedHash
     * @returns {Promise<boolean>}
     */
    static async verifyChunk(data, expectedHash) {
        const actualHash = await IntegrityVerifier.hash(data);
        return actualHash === expectedHash;
    }

    /**
     * Compute incremental hash for streaming verification.
     * Since SubtleCrypto doesn't support incremental hashing,
     * we compute per-chunk hashes and verify them individually.
     * For full-file verification, we recompute from all chunks.
     */
    constructor() {
        /** @type {Map<number, string>} chunk index → hash */
        this.chunkHashes = new Map();
    }

    /**
     * Record a chunk's hash.
     * @param {number} index
     * @param {ArrayBuffer} data
     * @returns {Promise<string>}
     */
    async recordChunk(index, data) {
        const hash = await IntegrityVerifier.hash(data);
        this.chunkHashes.set(index, hash);
        return hash;
    }

    /**
     * Record a chunk's ALREADY-COMPUTED hash without re-hashing the data. The receiver
     * verifies each chunk against the sender's committed hash; on success that hash is,
     * by definition, the hash of the plaintext — so recording it directly avoids a second
     * SHA-256 pass over every chunk (the manifest root still covers the full set).
     * @param {number} index
     * @param {string} hash - hex-encoded SHA-256, already verified against the plaintext
     */
    recordChunkHash(index, hash) {
        this.chunkHashes.set(index, hash);
    }

    /**
     * Get a chunk's recorded hash.
     * @param {number} index
     * @returns {string | undefined}
     */
    getChunkHash(index) {
        return this.chunkHashes.get(index);
    }

    /**
     * Get the total number of verified chunks.
     */
    getVerifiedCount() {
        return this.chunkHashes.size;
    }

    /**
     * Get all recorded chunk hashes ordered by index (0..totalChunks-1).
     * Used to compute the whole-file manifest root. Missing entries become ''.
     * @param {number} totalChunks
     * @returns {string[]}
     */
    getOrderedHashes(totalChunks) {
        const ordered = new Array(totalChunks);
        for (let i = 0; i < totalChunks; i++) {
            ordered[i] = this.chunkHashes.get(i) || '';
        }
        return ordered;
    }

    /**
     * Verify a full file blob against an expected hash.
     * @param {Blob} blob
     * @param {string} expectedHash
     * @returns {Promise<boolean>}
     */
    static async verifyFile(blob, expectedHash) {
        const buffer = await blob.arrayBuffer();
        return IntegrityVerifier.verifyChunk(buffer, expectedHash);
    }

    /**
     * Clear all recorded hashes.
     */
    clear() {
        this.chunkHashes.clear();
    }
}
