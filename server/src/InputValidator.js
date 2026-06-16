import { MAX_RELAY_FRAME_SIZE } from '../../shared/constants.js';

/**
 * InputValidator — Centralized, strict validation for all WebSocket message shapes.
 *
 * All incoming messages are validated here before any processing.
 * Rejects unknown fields, enforces types, and sanitizes filenames.
 * This is the single security gate for all signaling protocol messages.
 */
export class InputValidator {

    /**
     * Validate a RELAY_CHUNK message. Previously unvalidated — this gate enforces
     * the frame shape and size so a peer cannot smuggle malformed/oversized relay
     * frames or rely on a forged `size` to evade the relay byte cap (the server
     * computes the real byte count itself).
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateRelayChunk(data) {
        if (data.channelIndex !== undefined &&
            (typeof data.channelIndex !== 'number' || !Number.isInteger(data.channelIndex) || data.channelIndex < 0)) {
            return { valid: false, reason: 'channelIndex must be a non-negative integer' };
        }
        if (typeof data.isText !== 'boolean') {
            return { valid: false, reason: 'isText must be a boolean' };
        }
        if (data.isText) {
            if (typeof data.payload !== 'string') {
                return { valid: false, reason: 'text relay frame requires a string payload' };
            }
            if (data.payload.length > MAX_RELAY_FRAME_SIZE) {
                return { valid: false, reason: 'relay payload exceeds frame limit' };
            }
        } else {
            if (typeof data.b64 !== 'string') {
                return { valid: false, reason: 'binary relay frame requires a base64 string' };
            }
            if (data.b64.length > MAX_RELAY_FRAME_SIZE) {
                return { valid: false, reason: 'relay frame exceeds frame limit' };
            }
        }
        return { valid: true };
    }

    /**
     * Validate a CREATE_SESSION message.
     * No required payload — but reject extra suspicious fields.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateCreateSession(data) {
        const allowed = new Set(['type']);
        for (const key of Object.keys(data)) {
            if (!allowed.has(key)) {
                return { valid: false, reason: `Unexpected field: ${key}` };
            }
        }
        return { valid: true };
    }

    /**
     * Validate a JOIN_SESSION message.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateJoinSession(data) {
        if (!data.pairingCode || typeof data.pairingCode !== 'string') {
            return { valid: false, reason: 'pairingCode must be a string' };
        }
        if (!/^\d{6}$/.test(data.pairingCode)) {
            return { valid: false, reason: 'pairingCode must be exactly 6 digits' };
        }
        return { valid: true };
    }

    /**
     * Validate an OFFER message.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateOffer(data) {
        if (!data.payload || typeof data.payload !== 'object') {
            return { valid: false, reason: 'payload must be an object' };
        }
        if (data.payload.type !== 'offer') {
            return { valid: false, reason: 'payload.type must be "offer"' };
        }
        if (typeof data.payload.sdp !== 'string') {
            return { valid: false, reason: 'payload.sdp must be a string' };
        }
        if (data.payload.sdp.length > 32 * 1024) {
            return { valid: false, reason: 'SDP exceeds 32KB limit' };
        }
        return { valid: true };
    }

    /**
     * Validate an ANSWER message.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateAnswer(data) {
        if (!data.payload || typeof data.payload !== 'object') {
            return { valid: false, reason: 'payload must be an object' };
        }
        if (data.payload.type !== 'answer') {
            return { valid: false, reason: 'payload.type must be "answer"' };
        }
        if (typeof data.payload.sdp !== 'string') {
            return { valid: false, reason: 'payload.sdp must be a string' };
        }
        if (data.payload.sdp.length > 32 * 1024) {
            return { valid: false, reason: 'SDP exceeds 32KB limit' };
        }
        return { valid: true };
    }

    /**
     * Validate an ICE_CANDIDATE message.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateIceCandidate(data) {
        if (!data.payload || typeof data.payload !== 'object') {
            return { valid: false, reason: 'payload must be an object' };
        }
        // null candidate is valid (end-of-candidates signal)
        if (data.payload.candidate === null) return { valid: true };
        if (typeof data.payload.candidate !== 'string') {
            return { valid: false, reason: 'payload.candidate must be a string or null' };
        }
        if (data.payload.candidate.length > 2048) {
            return { valid: false, reason: 'ICE candidate exceeds 2KB limit' };
        }
        return { valid: true };
    }

    /**
     * Validate FILE_META structure (for server-relay mode, Milestone 4).
     * @param {object} meta
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateFileMeta(meta) {
        if (!meta.fileName || typeof meta.fileName !== 'string') {
            return { valid: false, reason: 'fileName must be a non-empty string' };
        }

        // Sanitize filename — reject path traversal and null bytes
        const sanitized = InputValidator.sanitizeFilename(meta.fileName);
        if (!sanitized) {
            return { valid: false, reason: 'fileName contains invalid characters' };
        }

        if (typeof meta.fileSize !== 'number' || meta.fileSize < 0) {
            return { valid: false, reason: 'fileSize must be a non-negative number' };
        }
        if (meta.fileSize > 100 * 1024 * 1024 * 1024) { // 100 GB
            return { valid: false, reason: 'fileSize exceeds 100GB limit' };
        }
        if (typeof meta.totalChunks !== 'number' || meta.totalChunks < 1) {
            return { valid: false, reason: 'totalChunks must be a positive integer' };
        }
        if (meta.totalChunks > 500_000) { // ~128GB at 256KB chunks
            return { valid: false, reason: 'totalChunks unreasonably large' };
        }
        if (typeof meta.chunkSize !== 'number' || meta.chunkSize < 1024) {
            return { valid: false, reason: 'chunkSize must be at least 1024 bytes' };
        }
        return { valid: true };
    }

    /**
     * Sanitize a filename — remove path traversal, null bytes, and control characters.
     * Returns null if the filename cannot be safely used.
     * @param {string} name
     * @returns {string | null}
     */
    static sanitizeFilename(name) {
        if (!name || typeof name !== 'string') return null;

        // Remove null bytes and control characters
        // eslint-disable-next-line no-control-regex
        const cleaned = name.replace(/[\x00-\x1f\x7f]/g, '');

        // Reject path traversal patterns
        if (cleaned.includes('..') || cleaned.includes('/') || cleaned.includes('\\')) {
            return null;
        }

        // Reject empty after cleaning
        if (!cleaned.trim()) return null;

        // Truncate to 255 chars (filesystem limit)
        return cleaned.slice(0, 255);
    }

    /**
     * Validate any signaling message by type.
     * @param {object} data
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validate(data) {
        if (!data || typeof data.type !== 'string') {
            return { valid: false, reason: 'Missing or invalid type field' };
        }

        switch (data.type) {
            case 'create-session': return InputValidator.validateCreateSession(data);
            case 'join-session': return InputValidator.validateJoinSession(data);
            case 'offer': return InputValidator.validateOffer(data);
            case 'answer': return InputValidator.validateAnswer(data);
            case 'ice-candidate': return InputValidator.validateIceCandidate(data);
            case 'file-meta': return data.payload
                ? InputValidator.validateFileMeta(data.payload)
                : { valid: false, reason: 'payload required for file-meta' };
            case 'disconnect': return { valid: true };
            case 'cancel': return { valid: true };
            case 'relay-request': return { valid: true };
            case 'relay-chunk': return InputValidator.validateRelayChunk(data);
            case 'relay-complete': return { valid: true };
            // ── Group rooms / swarm ──
            case 'create-room': return InputValidator.validateOptionalName(data);
            case 'join-room': return InputValidator.validateJoinRoom(data);
            case 'leave-room': return { valid: true };
            case 'swarm-announce': return InputValidator.validateSwarmAnnounce(data);
            case 'swarm-have': return InputValidator.validateSwarmHave(data);
            case 'swarm-need': return InputValidator.validateSwarmNeed(data);
            default:
                return { valid: false, reason: `Unknown message type: ${data.type}` };
        }
    }

    // ── Room / swarm validators ────────────────────────────────
    static validateOptionalName(data) {
        if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 64)) {
            return { valid: false, reason: 'name must be a string ≤ 64 chars' };
        }
        return { valid: true };
    }

    static validateJoinRoom(data) {
        if (!data.joinCode || typeof data.joinCode !== 'string' || !/^\d{6}$/.test(data.joinCode)) {
            return { valid: false, reason: 'joinCode must be exactly 6 digits' };
        }
        return InputValidator.validateOptionalName(data);
    }

    static _fileIdOk(fileId) {
        return typeof fileId === 'string' && fileId.length > 0 && fileId.length <= 256;
    }

    static validateSwarmAnnounce(data) {
        if (!InputValidator._fileIdOk(data.fileId)) return { valid: false, reason: 'fileId must be a string' };
        if (typeof data.totalChunks !== 'number' || !Number.isInteger(data.totalChunks) || data.totalChunks < 1 || data.totalChunks > 500_000) {
            return { valid: false, reason: 'totalChunks must be a positive integer ≤ 500000' };
        }
        return { valid: true };
    }

    static validateSwarmHave(data) {
        if (!InputValidator._fileIdOk(data.fileId)) return { valid: false, reason: 'fileId must be a string' };
        if (!Array.isArray(data.indices) || data.indices.length === 0 || data.indices.length > 100_000) {
            return { valid: false, reason: 'indices must be a non-empty array (≤ 100000)' };
        }
        for (const i of data.indices) {
            if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 500_000) {
                return { valid: false, reason: 'indices must be non-negative integers' };
            }
        }
        return { valid: true };
    }

    static validateSwarmNeed(data) {
        if (!InputValidator._fileIdOk(data.fileId)) return { valid: false, reason: 'fileId must be a string' };
        if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0 || data.index > 500_000) {
            return { valid: false, reason: 'index must be a non-negative integer' };
        }
        return { valid: true };
    }
}
