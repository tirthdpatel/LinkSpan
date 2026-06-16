/**
 * CryptoEngine — Optional AES-256-GCM end-to-end file encryption.
 *
 * Usage:
 *   Sender:   const key = await CryptoEngine.generateKey()
 *             const { ciphertext, iv } = await CryptoEngine.encryptChunk(key, plaintext)
 *             // Send iv + ciphertext as the chunk payload
 *             // Share key via QR or password derivation
 *
 *   Receiver: const key = await CryptoEngine.importKey(exportedKey)
 *             const plaintext = await CryptoEngine.decryptChunk(key, iv, ciphertext)
 *
 * The IV is 12 bytes (96 bits) — the standard for AES-GCM.
 * A unique IV is generated per chunk to prevent IV reuse attacks.
 * The tag (16 bytes) is appended by SubtleCrypto automatically.
 *
 * Key exchange strategies:
 *   1. QR code: sender encodes exportedKey in QR, receiver scans
 *   2. Password: both sides derive the same key via PBKDF2
 *   3. Session secret: server generates and distributes (weaker — server sees key)
 */
export class CryptoEngine {

    // ── Key Management ─────────────────────────────────────────

    /**
     * Generate a new AES-256-GCM key.
     * @returns {Promise<CryptoKey>}
     */
    static async generateKey() {
        return crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,  // extractable — needed for export
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Export a CryptoKey to a base64url string (for QR/transfer).
     * @param {CryptoKey} key
     * @returns {Promise<string>}
     */
    static async exportKey(key) {
        const raw = await crypto.subtle.exportKey('raw', key);
        return CryptoEngine._toBase64url(raw);
    }

    /**
     * Import a CryptoKey from a base64url string.
     * @param {string} b64
     * @returns {Promise<CryptoKey>}
     */
    static async importKey(b64) {
        const raw = CryptoEngine._fromBase64url(b64);
        return crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Derive an AES-256-GCM key from a password using PBKDF2.
     * Both sender and receiver must use the same password + salt.
     * @param {string} password
     * @param {Uint8Array} [salt] - 16-byte salt (generate on sender, share with receiver)
     * @returns {Promise<{ key: CryptoKey, salt: Uint8Array }>}
     */
    static async deriveKeyFromPassword(password, salt = null) {
        const encoder = new TextEncoder();
        const passwordKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );

        const usedSalt = salt || crypto.getRandomValues(new Uint8Array(16));

        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: usedSalt,
                iterations: 250_000,  // OWASP recommended minimum
                hash: 'SHA-256',
            },
            passwordKey,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );

        return { key, salt: usedSalt };
    }

    // ── ECDH Session Key Agreement ─────────────────────────────

    /**
     * Generate an ephemeral ECDH (P-256) key pair for session key agreement.
     * Each peer generates one per connection; private keys never leave the browser.
     * @returns {Promise<CryptoKeyPair>}
     */
    static async generateECDHKeyPair() {
        return crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            false, // private key is non-extractable — cannot be exfiltrated
            ['deriveKey']
        );
    }

    /**
     * Export an ECDH public key to a base64url string for transmission to the peer.
     * @param {CryptoKeyPair} keyPair
     * @returns {Promise<string>}
     */
    static async exportPublicKey(keyPair) {
        const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        return CryptoEngine._toBase64url(raw);
    }

    /**
     * Derive the shared AES-256-GCM session key from our private key and the peer's
     * public key. Both peers independently arrive at the same key (ECDH), so the
     * key is never transmitted and the signaling/relay server never sees it.
     *
     * NOTE: ECDH alone protects against a *passive* server and network observers.
     * An active man-in-the-middle that controls the channel could substitute keys.
     * That is mitigated by the Short Authentication String (see computeSAS): the
     * users compare a code derived from both public keys, which differs on each
     * side under a MITM. See docs/architecture/trust-model.md.
     *
     * @param {CryptoKeyPair} keyPair - our ECDH key pair
     * @param {string} peerPublicKeyB64 - peer's exported public key
     * @returns {Promise<CryptoKey>} AES-256-GCM key
     */
    static async deriveSharedKey(keyPair, peerPublicKeyB64) {
        const peerRaw = CryptoEngine._fromBase64url(peerPublicKeyB64);
        const peerPublicKey = await crypto.subtle.importKey(
            'raw',
            peerRaw,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );

        return crypto.subtle.deriveKey(
            { name: 'ECDH', public: peerPublicKey },
            keyPair.privateKey,
            { name: 'AES-GCM', length: 256 },
            false, // session key is non-extractable
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Compute a Short Authentication String (SAS) from both peers' ECDH public
     * keys. Both peers feed in the same two keys (sorted to a canonical order, so
     * the result is identical regardless of which side is "ours"), so an honest
     * exchange yields the same 6-digit code on both screens.
     *
     * An active man-in-the-middle must substitute a different public key toward
     * each peer, so the two peers would compute *different* SAS values — the users
     * catch this by comparing the code out-of-band (read it aloud / look at both
     * screens). ~20 bits ⇒ a MITM has only a ~1-in-10^6 chance of a matching code.
     *
     * @param {string} pubA - one peer's exported public key (base64url)
     * @param {string} pubB - the other peer's exported public key (base64url)
     * @returns {Promise<string>} 6-digit code formatted "123 456"
     */
    static async computeSAS(pubA, pubB) {
        // Canonical order so both sides hash the same input.
        const [first, second] = [pubA, pubB].sort();
        const data = new TextEncoder().encode(`LinkSpan-SAS-v1:${first}:${second}`);
        const digest = await crypto.subtle.digest('SHA-256', data);
        const bytes = new Uint8Array(digest);
        const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        const code = (num % 1_000_000).toString().padStart(6, '0');
        return `${code.slice(0, 3)} ${code.slice(3)}`;
    }

    // ── Chunk Encryption ───────────────────────────────────────

    /**
     * Encrypt a chunk with AES-256-GCM.
     * Returns a buffer with format: [12-byte IV][ciphertext+tag]
     * The tag (16 bytes) is appended automatically by SubtleCrypto.
     *
     * @param {CryptoKey} key
     * @param {ArrayBuffer} plaintext
     * @returns {Promise<ArrayBuffer>} IV-prepended ciphertext
     */
    static async encryptChunk(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plaintext
        );

        // Prepend IV: [12 bytes IV][ciphertext+16 byte tag]
        const result = new Uint8Array(12 + ciphertext.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(ciphertext), 12);
        return result.buffer;
    }

    /**
     * Decrypt a chunk. Expects the IV-prepended format from encryptChunk().
     * @param {CryptoKey} key
     * @param {ArrayBuffer} ivPlusCiphertext
     * @returns {Promise<ArrayBuffer>} plaintext
     */
    static async decryptChunk(key, ivPlusCiphertext) {
        const bytes = new Uint8Array(ivPlusCiphertext);
        const iv = bytes.slice(0, 12);
        const ciphertext = bytes.slice(12);

        return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
    }

    // ── File-Level ─────────────────────────────────────────────

    /**
     * Encrypt an entire Blob. Suitable for files < ~1GB (loads into memory).
     * For larger files, use encryptChunk() in streaming fashion.
     * @param {CryptoKey} key
     * @param {Blob} blob
     * @returns {Promise<ArrayBuffer>}
     */
    static async encryptBlob(key, blob) {
        const buffer = await blob.arrayBuffer();
        return CryptoEngine.encryptChunk(key, buffer);
    }

    /**
     * Decrypt an ArrayBuffer to a Blob.
     * @param {CryptoKey} key
     * @param {ArrayBuffer} encrypted
     * @param {string} [mimeType]
     * @returns {Promise<Blob>}
     */
    static async decryptToBlob(key, encrypted, mimeType = 'application/octet-stream') {
        const plaintext = await CryptoEngine.decryptChunk(key, encrypted);
        return new Blob([plaintext], { type: mimeType });
    }

    // ── Helpers ────────────────────────────────────────────────

    /**
     * Generate a random salt for password derivation.
     * Share this with the receiver alongside the password.
     * @returns {Uint8Array}
     */
    static generateSalt() {
        return crypto.getRandomValues(new Uint8Array(16));
    }

    /**
     * Convert an ArrayBuffer to base64url string.
     * @param {ArrayBuffer} buffer
     * @returns {string}
     */
    static _toBase64url(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    /**
     * Convert a base64url string to Uint8Array.
     * @param {string} b64
     * @returns {Uint8Array}
     */
    static _fromBase64url(b64) {
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}
