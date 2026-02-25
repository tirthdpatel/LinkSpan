import { DEFAULT_CHUNK_SIZE } from '@shared/constants.js';

/**
 * ChunkManager — Handles file slicing and chunk metadata.
 */
export class ChunkManager {
    /**
     * @param {File} file
     * @param {number} [chunkSize]
     */
    constructor(file, chunkSize = DEFAULT_CHUNK_SIZE) {
        this.file = file;
        this.chunkSize = chunkSize;
        this.totalChunks = Math.ceil(file.size / chunkSize);
        this.fileId = this._generateFileId();
    }

    /**
     * Get file metadata for the receiver.
     */
    getFileMeta() {
        return {
            fileId: this.fileId,
            fileName: this.file.name,
            fileSize: this.file.size,
            fileType: this.file.type,
            chunkSize: this.chunkSize,
            totalChunks: this.totalChunks,
        };
    }

    /**
     * Read a specific chunk from the file.
     * @param {number} index - chunk index (0-based)
     * @returns {Promise<ArrayBuffer>}
     */
    async getChunk(index) {
        if (index < 0 || index >= this.totalChunks) {
            throw new Error(`Chunk index ${index} out of range (0-${this.totalChunks - 1})`);
        }

        const start = index * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.file.size);
        const blob = this.file.slice(start, end);
        return blob.arrayBuffer();
    }

    /**
     * Create a serialized chunk message (header + data).
     * Header: 4 bytes chunk index (Uint32, big-endian)
     * @param {number} index
     * @param {ArrayBuffer} data
     * @returns {ArrayBuffer}
     */
    static packChunk(index, data) {
        const header = new ArrayBuffer(4);
        new DataView(header).setUint32(0, index, false); // big-endian
        const packed = new Uint8Array(4 + data.byteLength);
        packed.set(new Uint8Array(header), 0);
        packed.set(new Uint8Array(data), 4);
        return packed.buffer;
    }

    /**
     * Deserialize a chunk message.
     * @param {ArrayBuffer} packed
     * @returns {{ index: number, data: ArrayBuffer }}
     */
    static unpackChunk(packed) {
        const view = new DataView(packed);
        const index = view.getUint32(0, false);
        const data = packed.slice(4);
        return { index, data };
    }

    /**
     * Generate a unique file ID.
     */
    _generateFileId() {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    }
}
