/**
 * @linkspan/sdk — official client for the LinkSpan share-link REST API (Feature 18).
 *
 * Works in Node.js >= 18 and modern browsers (uses the global `fetch`). Zero runtime
 * dependencies. The API surface is stable and semver'd; breaking changes bump the major.
 *
 * Quick start:
 *   import { LinkSpanClient } from '@linkspan/sdk';
 *   const client = new LinkSpanClient({ baseUrl: 'https://share.example', apiKey: 'lk1...' });
 *   const link = await client.createShare(bytes, { filename: 'photo.jpg', expiresIn: '24h' });
 *   console.log(link.url);            // shareable URL
 *   const data = await client.download(link.id);   // → Uint8Array
 *
 * Security note: by default the SDK uploads whatever bytes you give it AS-IS — the server
 * then stores readable content. For confidentiality against the server/operator, encrypt
 * client-side: pass `{ encrypt: true }` to createShare() (the SDK generates a key, encrypts
 * before upload, and returns it as `encryptionKey`), then decrypt on the other side with
 * `download(id, { decryptionKey })`. The key never reaches the server; convey it to the
 * recipient out-of-band (the `linkspan` CLI carries it in the URL fragment). Low-level
 * helpers are also exported: generateKey, exportKey, importKey, encryptBytes, decryptBytes.
 */

import * as ShareCrypto from './crypto.js';
export * from './crypto.js';

export class LinkSpanError extends Error {
    /** @param {string} code @param {string} message @param {number} [status] @param {any} [body] */
    constructor(code, message, status, body) {
        super(message);
        this.name = 'LinkSpanError';
        this.code = code;
        this.status = status;
        this.body = body;
    }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class LinkSpanClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl   Server origin, e.g. 'https://share.example'.
     * @param {string} [opts.apiKey]  Bearer API key for management calls (create/list/revoke/sessions).
     * @param {typeof fetch} [opts.fetch]  Custom fetch (defaults to global fetch).
     * @param {number} [opts.timeoutMs]
     */
    constructor({ baseUrl, apiKey, fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (!baseUrl) throw new LinkSpanError('CONFIG', 'baseUrl is required');
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiBase = `${this.baseUrl}/api/v1`;
        this.apiKey = apiKey || null;
        this.accessToken = null; // set by login()/register()/setAccessToken()
        this._fetch = fetchImpl || globalThis.fetch;
        this._timeoutMs = timeoutMs;
        if (typeof this._fetch !== 'function') {
            throw new LinkSpanError('CONFIG', 'No fetch implementation available; pass opts.fetch');
        }
    }

    // ── Low-level request helper ───────────────────────────────
    async _request(method, path, { body, headers = {}, raw = false, auth = false, query } = {}) {
        const url = new URL(`${this.apiBase}${path}`);
        if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

        const h = { ...headers };
        // Prefer an explicit API key; fall back to a logged-in account access token.
        if (auth && (this.apiKey || this.accessToken)) {
            h['authorization'] = `Bearer ${this.apiKey || this.accessToken}`;
        }

        let payload = body;
        if (body != null && !raw && !(body instanceof Uint8Array) && typeof body !== 'string'
            && !isBinaryBody(body)) {
            h['content-type'] = 'application/json';
            payload = JSON.stringify(body);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        let res;
        try {
            res = await this._fetch(url.toString(), { method, headers: h, body: payload, signal: controller.signal });
        } catch (err) {
            throw new LinkSpanError('NETWORK', err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || err));
        } finally {
            clearTimeout(timer);
        }
        return res;
    }

    async _json(method, path, opts) {
        const res = await this._request(method, path, opts);
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!res.ok) {
            const e = data?.error || {};
            throw new LinkSpanError(e.code || 'HTTP_ERROR', e.message || `HTTP ${res.status}`, res.status, data);
        }
        return data;
    }

    // ── Discovery ──────────────────────────────────────────────
    /** Fetch API info & capabilities. @returns {Promise<object>} */
    info() { return this._json('GET', '/'); }

    /** Server + share-store health. @returns {Promise<object>} */
    health() { return this._json('GET', '/health'); }

    // ── Share links ────────────────────────────────────────────
    /**
     * Reserve a share link (no bytes yet). Returns the link plus an `uploadToken`.
     * @param {import('../index.js').CreateLinkOptions} options
     * @returns {Promise<import('../index.js').CreatedLink>}
     */
    createLink(options) {
        return this._json('POST', '/links', { body: options, auth: true });
    }

    /**
     * Upload bytes to a reserved link.
     * @param {string} id
     * @param {string} uploadToken
     * @param {Uint8Array|ArrayBuffer|Blob|ReadableStream|string} data
     * @returns {Promise<import('../index.js').ShareLink>}
     */
    uploadContent(id, uploadToken, data) {
        return this._json('PUT', `/links/${id}/content`, {
            body: toBinary(data),
            raw: true,
            headers: { 'x-upload-token': uploadToken, 'content-type': 'application/octet-stream' },
        });
    }

    /**
     * Convenience: create a link and upload its content in one call.
     *
     * Encryption: pass `{ encrypt: true }` to encrypt the content client-side with a fresh
     * AES-256-GCM key before upload (the server then stores ciphertext only). The key is
     * returned on the result as `encryptionKey` (base64url) — convey it to the recipient
     * out-of-band and decrypt with `download(id, { decryptionKey })`. You may also pass a
     * specific key via `{ encrypt: '<base64url-key>' }` to reuse one you already hold.
     *
     * @param {Uint8Array|ArrayBuffer|Blob|string} data
     * @param {import('../index.js').CreateLinkOptions & { encrypt?: boolean|string }} [options]
     * @returns {Promise<import('../index.js').CreatedLink & { encryptionKey?: string }>}
     */
    async createShare(data, options = {}) {
        const { encrypt, ...linkOptions } = options;
        let bin = toBinary(data);
        let encryptionKey;
        if (encrypt) {
            // Reads streams/Blobs into memory to encrypt; matches the existing in-memory
            // upload model. (Streaming encryption is a future enhancement.)
            const plain = await toBytes(bin);
            const key = typeof encrypt === 'string'
                ? await ShareCrypto.importKey(encrypt)
                : await ShareCrypto.generateKey();
            bin = await ShareCrypto.encryptBytes(key, plain);
            encryptionKey = await ShareCrypto.exportKey(key);
            linkOptions.metadata = { ...(linkOptions.metadata || {}), encrypted: ShareCrypto.ENCRYPTION_SCHEME };
        }
        const size = options.size ?? byteLength(bin);
        const created = await this.createLink({ ...linkOptions, size });
        const ready = await this.uploadContent(created.id, created.uploadToken, bin);
        // Preserve the one-time secrets from create (and the encryption key) on the result.
        return { ...ready, uploadToken: created.uploadToken, ownerToken: created.ownerToken, encryptionKey };
    }

    /**
     * Fetch public metadata for a link.
     * @param {string} id @returns {Promise<import('../index.js').ShareLink>}
     */
    getLink(id) { return this._json('GET', `/links/${id}`); }

    /**
     * Download a link's bytes.
     *
     * If the content was uploaded with `createShare(..., { encrypt: true })`, pass the
     * returned key as `{ decryptionKey }` to get back the original plaintext; without it
     * you receive the raw (still-encrypted) bytes.
     *
     * @param {string} id
     * @param {{ password?: string, decryptionKey?: string }} [opts]
     * @returns {Promise<Uint8Array>}
     */
    async download(id, { password, decryptionKey } = {}) {
        const headers = {};
        if (password != null) headers['x-share-password'] = password;
        const res = await this._request('GET', `/links/${id}/download`, { headers });
        if (!res.ok) {
            const text = await res.text();
            let data; try { data = JSON.parse(text); } catch { data = {}; }
            const e = data?.error || {};
            throw new LinkSpanError(e.code || 'HTTP_ERROR', e.message || `HTTP ${res.status}`, res.status, data);
        }
        const ab = await res.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (decryptionKey) {
            const key = await ShareCrypto.importKey(decryptionKey);
            return ShareCrypto.decryptBytes(key, bytes);
        }
        return bytes;
    }

    /**
     * Download a link's bytes as a Response so the caller can stream (browser/Node).
     * @param {string} id @param {{ password?: string }} [opts] @returns {Promise<Response>}
     */
    async downloadStream(id, { password } = {}) {
        const headers = {};
        if (password != null) headers['x-share-password'] = password;
        const res = await this._request('GET', `/links/${id}/download`, { headers });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const e = data?.error || {};
            throw new LinkSpanError(e.code || 'HTTP_ERROR', e.message || `HTTP ${res.status}`, res.status, data);
        }
        return res;
    }

    /**
     * Revoke a link. Provide `ownerToken` for anonymously created links, or rely on the
     * configured API key when the link is owned by that key.
     * @param {string} id @param {{ ownerToken?: string }} [opts] @returns {Promise<{revoked:boolean,id:string}>}
     */
    revoke(id, { ownerToken } = {}) {
        const headers = {};
        if (ownerToken) headers['x-owner-token'] = ownerToken;
        return this._json('DELETE', `/links/${id}`, { headers, auth: true });
    }

    /**
     * List links owned by the configured API key. Requires an API key.
     * @returns {Promise<{ links: import('../index.js').ShareLink[], count: number }>}
     */
    listLinks() {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'listLinks requires an API key or login');
        return this._json('GET', '/links', { auth: true });
    }

    // ── Accounts / auth ────────────────────────────────────────
    /** Set (or clear) the account access token used for authenticated calls. */
    setAccessToken(token) { this.accessToken = token || null; }

    /**
     * Register a new account. On success the returned access token is stored on the client
     * (so subsequent authenticated calls use it) and returned alongside the refresh token.
     * @param {{ email: string, password: string }} creds
     */
    async register(creds) {
        const s = await this._json('POST', '/auth/register', { body: creds });
        this.accessToken = s.accessToken;
        return s;
    }

    /** Log in. Stores the access token on the client. @param {{ email, password }} creds */
    async login(creds) {
        const s = await this._json('POST', '/auth/login', { body: creds });
        this.accessToken = s.accessToken;
        return s;
    }

    /** Exchange a refresh token for a new (rotated) session. Stores the new access token. */
    async refresh(refreshToken) {
        const s = await this._json('POST', '/auth/refresh', { body: { refreshToken } });
        this.accessToken = s.accessToken;
        return s;
    }

    /** Invalidate a refresh token server-side and clear the local access token. */
    async logout(refreshToken) {
        const r = await this._json('POST', '/auth/logout', { body: { refreshToken } });
        this.accessToken = null;
        return r;
    }

    /** Fetch the current account (requires a logged-in access token). */
    me() { return this._json('GET', '/auth/me', { auth: true }); }

    /** Mint an account-scoped API key (requires login). Returns the key once. */
    createApiKey(opts = {}) { return this._json('POST', '/auth/api-keys', { body: opts, auth: true }); }
    /** List the account's API keys (no secrets). */
    listApiKeys() { return this._json('GET', '/auth/api-keys', { auth: true }); }
    /** Revoke one account API key by id. */
    revokeApiKey(id) { return this._json('DELETE', `/auth/api-keys/${id}`, { auth: true }); }

    // ── Webhooks ───────────────────────────────────────────────
    /**
     * Register a webhook endpoint. Requires an API key. The response includes the signing
     * `secret` (shown once) — store it and verify deliveries with `verifyWebhookSignature`.
     * @param {{ url: string, events: string[], secret?: string }} opts
     * @returns {Promise<object>}
     */
    createWebhook(opts) {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'createWebhook requires an API key or login');
        return this._json('POST', '/webhooks', { body: opts, auth: true });
    }

    /** List the caller's webhook endpoints. @returns {Promise<{webhooks:object[],count:number}>} */
    listWebhooks() {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'listWebhooks requires an API key or login');
        return this._json('GET', '/webhooks', { auth: true });
    }

    /** Delete a webhook endpoint. @param {string} id */
    deleteWebhook(id) {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'deleteWebhook requires an API key or login');
        return this._json('DELETE', `/webhooks/${id}`, { auth: true });
    }

    /** Send a synthetic `ping` to a webhook endpoint to test connectivity. @param {string} id */
    testWebhook(id) {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'testWebhook requires an API key or login');
        return this._json('POST', `/webhooks/${id}/test`, { auth: true });
    }

    /** Recent delivery attempts for a webhook endpoint. @param {string} id */
    webhookDeliveries(id) {
        if (!this.apiKey && !this.accessToken) throw new LinkSpanError('CONFIG', 'webhookDeliveries requires an API key or login');
        return this._json('GET', `/webhooks/${id}/deliveries`, { auth: true });
    }

    // ── Sessions (signaling bridge) ────────────────────────────
    /**
     * Create a live signaling session (returns a pairing code another device can join).
     * @returns {Promise<{ sessionId: string, pairingCode: string, peerId: string, token: string }>}
     */
    createSession() { return this._json('POST', '/sessions', { auth: true }); }

    /** @param {string} id @returns {Promise<object>} */
    getSession(id) { return this._json('GET', `/sessions/${id}`); }
}

// ── Binary helpers ─────────────────────────────────────────────

function isBinaryBody(b) {
    return b instanceof ArrayBuffer
        || (typeof Blob !== 'undefined' && b instanceof Blob)
        || (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream)
        || (typeof Buffer !== 'undefined' && Buffer.isBuffer(b));
}

/** Normalize accepted body types into something fetch can send as raw bytes. */
function toBinary(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (isBinaryBody(data)) return data; // Blob / ReadableStream / Buffer pass through
    throw new LinkSpanError('CONFIG', 'Unsupported data type for upload');
}

/** Fully read any accepted body type into a Uint8Array (needed before encryption). */
async function toBytes(data) {
    if (data instanceof Uint8Array) return data; // also covers Node Buffer
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) {
        const reader = data.getReader();
        const parts = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            parts.push(chunk);
            total += chunk.byteLength;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.byteLength; }
        return out;
    }
    throw new LinkSpanError('CONFIG', 'Cannot encrypt this data type; provide bytes/Blob/string');
}

function byteLength(bin) {
    if (bin instanceof Uint8Array) return bin.byteLength;
    if (bin instanceof ArrayBuffer) return bin.byteLength;
    if (typeof Blob !== 'undefined' && bin instanceof Blob) return bin.size;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bin)) return bin.length;
    return 0; // streams: size unknown; server validates against its ceiling
}

export default LinkSpanClient;
