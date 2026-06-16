/**
 * Share-link content encryption (AES-256-GCM) for @linkspan/sdk.
 *
 * Portable across Node.js >= 18 and modern browsers — uses the standard WebCrypto API
 * (`globalThis.crypto.subtle`), so there are still zero runtime dependencies.
 *
 * Threat model this addresses: a share link uploads bytes to the server's blob store so a
 * recipient can download them later. Without this, the server (and anyone with disk
 * access) can read the content. With it, content is encrypted *before* upload and the key
 * never leaves the client — the server stores and forwards ciphertext only. The key is
 * conveyed to the recipient out-of-band (the CLI puts it in the URL *fragment*, which
 * browsers never send to the server; SDK callers choose their own channel).
 *
 * Wire format of an encrypted blob: [12-byte random IV][ciphertext || 16-byte GCM tag].
 * The tag is appended by SubtleCrypto. A fresh IV is generated per encryption.
 */

// Resolve a WebCrypto implementation. Browsers and Node >= 19 expose `globalThis.crypto`;
// Node 18 has it only behind a flag, so fall back to `node:crypto`'s webcrypto via a guarded
// dynamic import (a browser build always satisfies the global branch first and never bundles
// node:crypto). Keeps the SDK dependency-free and working from Node 18 through browsers.
let _cryptoPromise = null;
function getCrypto() {
    if (globalThis.crypto && globalThis.crypto.subtle) return Promise.resolve(globalThis.crypto);
    if (!_cryptoPromise) {
        _cryptoPromise = import('node:crypto')
            .then((m) => {
                if (!m.webcrypto || !m.webcrypto.subtle) throw new Error('no webcrypto');
                return m.webcrypto;
            })
            .catch(() => {
                throw new Error(
                    'WebCrypto is unavailable. A modern browser or Node >= 18 is required for ' +
                    'share-link encryption.'
                );
            });
    }
    return _cryptoPromise;
}
const subtle = async () => (await getCrypto()).subtle;

const IV_BYTES = 12;

/** Generate a fresh, extractable AES-256-GCM key. @returns {Promise<CryptoKey>} */
export async function generateKey() {
    return (await subtle()).generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Export a key to a compact base64url string (safe in URLs/fragments). */
export async function exportKey(key) {
    const raw = await (await subtle()).exportKey('raw', key);
    return toBase64url(new Uint8Array(raw));
}

/** Import a key from the base64url string produced by exportKey(). */
export async function importKey(b64) {
    const raw = fromBase64url(b64);
    return (await subtle()).importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Encrypt bytes with the given key. Returns [IV][ciphertext+tag] as a Uint8Array.
 * @param {CryptoKey} key
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function encryptBytes(key, bytes) {
    const plaintext = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const c = await getCrypto();
    const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return out;
}

/**
 * Decrypt bytes produced by encryptBytes(). Throws if the key is wrong or data is tampered.
 * @param {CryptoKey} key
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function decryptBytes(key, bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.byteLength < IV_BYTES + 16) {
        throw new Error('Ciphertext too short to be a valid AES-GCM blob');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const ct = buf.subarray(IV_BYTES);
    const pt = await (await subtle()).decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(pt);
}

/** Marker stored in a link's `metadata.encrypted` so a downloader knows to decrypt. */
export const ENCRYPTION_SCHEME = 'aes-256-gcm';

// ── Webhook signature verification ─────────────────────────────
/**
 * Verify an inbound LinkSpan webhook signature.
 *
 * The server signs each delivery with the header
 *   X-LinkSpan-Signature: t=<unixSeconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
 * Pass the endpoint's shared `secret`, the raw `signatureHeader` value, and the exact raw
 * request body string (do NOT re-serialize parsed JSON — sign over the bytes you received).
 *
 * Returns true only if the HMAC matches (constant-time) and, when `toleranceSec` is given,
 * the timestamp is within that many seconds of now (replay protection).
 *
 * @param {string} secret
 * @param {string} signatureHeader
 * @param {string} rawBody
 * @param {{ toleranceSec?: number, now?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(secret, signatureHeader, rawBody, opts = {}) {
    if (!secret || typeof signatureHeader !== 'string') return false;
    const m = /(?:^|,)\s*t=(\d+)/.exec(signatureHeader);
    const v = /(?:^|,)\s*v1=([a-f0-9]{64})/.exec(signatureHeader);
    if (!m || !v) return false;
    const t = Number(m[1]);

    if (Number.isFinite(opts.toleranceSec)) {
        const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
        if (Math.abs(nowSec - t) > opts.toleranceSec) return false;
    }

    const c = await getCrypto();
    const enc = new TextEncoder();
    const key = await c.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const macBuf = await c.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
    const expected = [...new Uint8Array(macBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return timingSafeHexEqual(expected, v[1]);
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeHexEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ── base64url helpers (no padding) ─────────────────────────────
export function toBase64url(u8) {
    let bin = '';
    for (const b of u8) bin += String.fromCharCode(b);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(u8).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s) {
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    if (typeof atob === 'function') {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
}
