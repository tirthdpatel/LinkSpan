import { IntegrityVerifier } from './IntegrityVerifier.js';

/**
 * FileManifest — Merkle-style transfer manifest for tamper-evident chunk verification.
 *
 * The sender builds a manifest of all chunk hashes before transfer begins.
 * The manifest root hash is sent with FILE_META, allowing the receiver to:
 *   1. Verify any individual chunk against the pre-committed manifest
 *   2. Detect if the sender substitutes a different hash for a chunk mid-transfer
 *   3. Verify the complete file without trusting per-chunk CHUNK_DATA messages
 *
 * Structure:
 *   leaves:  [sha256(chunk_0), sha256(chunk_1), ..., sha256(chunk_n)]
 *   level1:  [sha256(leaf_0 + leaf_1), sha256(leaf_2 + leaf_3), ...]
 *   root:    sha256(level1_0 + level1_1 + ...)
 *
 * For large files (50GB = ~200K chunks), building the full Merkle tree
 * would require 200K SHA-256 operations. We use a flat manifest
 * (array of leaf hashes + single root) to keep it practical.
 * The root still proves the full set of expected chunk hashes.
 */
export class FileManifest {

    /**
     * Build a manifest from a File object.
     * Reads and hashes all chunks — expensive for large files, run in a Worker.
     * @param {File} file
     * @param {number} chunkSize
     * @returns {Promise<{ chunkHashes: string[], rootHash: string, totalChunks: number }>}
     */
    static async buildFromFile(file, chunkSize) {
        const totalChunks = Math.ceil(file.size / chunkSize);
        const chunkHashes = [];

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const blob = file.slice(start, end);
            const buffer = await blob.arrayBuffer();
            const hash = await IntegrityVerifier.hash(buffer);
            chunkHashes.push(hash);
        }

        const rootHash = await FileManifest._computeRoot(chunkHashes);
        return { chunkHashes, rootHash, totalChunks };
    }

    /**
     * Build a manifest from pre-computed chunk hashes (faster — hashes computed during send).
     * @param {string[]} chunkHashes - ordered array of hex-encoded chunk hashes
     * @returns {Promise<{ chunkHashes: string[], rootHash: string }>}
     */
    static async buildFromHashes(chunkHashes) {
        const rootHash = await FileManifest._computeRoot(chunkHashes);
        return { chunkHashes, rootHash };
    }

    /**
     * Verify that a chunk's hash matches the committed manifest.
     * @param {string[]} chunkHashes - the manifest's chunk hashes
     * @param {number} index
     * @param {ArrayBuffer} data
     * @returns {Promise<boolean>}
     */
    static async verifyChunk(chunkHashes, index, data) {
        if (index < 0 || index >= chunkHashes.length) return false;
        const actualHash = await IntegrityVerifier.hash(data);
        return actualHash === chunkHashes[index];
    }

    /**
     * Verify the manifest root hash.
     * Used by receiver to confirm the sender hasn't tampered with chunk hashes.
     * @param {string[]} chunkHashes
     * @param {string} expectedRoot
     * @returns {Promise<boolean>}
     */
    static async verifyRoot(chunkHashes, expectedRoot) {
        const actualRoot = await FileManifest._computeRoot(chunkHashes);
        return actualRoot === expectedRoot;
    }

    /**
     * Serialize manifest for network transmission (FILE_META message).
     * @param {{ chunkHashes: string[], rootHash: string, totalChunks: number }} manifest
     * @returns {object}
     */
    static serialize(manifest) {
        return {
            rootHash: manifest.rootHash,
            chunkHashes: manifest.chunkHashes,
            totalChunks: manifest.totalChunks,
        };
    }

    /**
     * Compute the Merkle root of an array of hex-encoded leaf hashes.
     * For simplicity, we hash the concatenated sorted hashes rather than
     * building a full binary tree. The root is still a strong commitment.
     * @param {string[]} hashes
     * @returns {Promise<string>}
     */
    static async _computeRoot(hashes) {
        if (hashes.length === 0) return '';
        if (hashes.length === 1) return hashes[0];

        // Concatenate all hashes as bytes, then hash the result
        const encoder = new TextEncoder();
        const concatenated = hashes.join('');
        const buffer = encoder.encode(concatenated).buffer;
        return IntegrityVerifier.hash(buffer);
    }
}
