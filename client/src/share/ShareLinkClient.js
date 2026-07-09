import { CryptoEngine } from '../crypto/CryptoEngine.js';
import { readBlobToArrayBuffer } from '../transfer/blobReader.js';

/**
 * ShareLinkClient — browser client for the LinkSpan share-link REST API.
 *
 * This is the asynchronous transport (upload now, recipient downloads later — no live peer),
 * complementing the live P2P/relay path. Content is **encrypted client-side by default** with
 * AES-256-GCM (reusing the same CryptoEngine as P2P); the key is carried in the share URL's
 * #fragment, which browsers never send to the server — so the operator stores and forwards
 * ciphertext only. See docs/architecture/trust-model.md §8.
 *
 * The REST base URL defaults to the signaling host over http(s) (ws→http, wss→https), or set
 * VITE_API_URL explicitly. CORS on the server must allow the client origin.
 */

function defaultApiBase() {
    const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
    if (env.VITE_API_URL) return env.VITE_API_URL.replace(/\/+$/, '');
    const sig = env.VITE_SIGNALING_URL || 'ws://localhost:10000';
    // ws:// → http://, wss:// → https://
    return sig.replace(/^ws/, 'http').replace(/\/+$/, '') + '/api/v1';
}

export class ShareLinkClient {
    /**
     * @param {object} [opts]
     * @param {string} [opts.apiBase]   REST base, e.g. https://share.example/api/v1
     * @param {typeof fetch} [opts.fetchImpl]
     * @param {string} [opts.viewerOrigin]  Origin+path the share link should point at for
     *   the in-app viewer (defaults to the current page). The recipient opens
     *   `${viewerOrigin}?s=<id>#k=<key>`; the app reads it and downloads+decrypts.
     */
    constructor({ apiBase, fetchImpl, viewerOrigin } = {}) {
        this.apiBase = (apiBase || defaultApiBase()).replace(/\/+$/, '');
        this._fetch = fetchImpl || globalThis.fetch?.bind(globalThis);
        this._viewerOrigin = viewerOrigin
            || (typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '');
        if (typeof this._fetch !== 'function') throw new Error('No fetch implementation available');
    }

    /**
     * Encrypt (default) + upload a Blob/File, returning a shareable link.
     * @param {Blob} blob
     * @param {object} [opts]
     * @param {string} [opts.filename]
     * @param {string} [opts.expiresIn]  preset ('5m'|'1h'|'24h'|'7d') or ms
     * @param {string} [opts.password]
     * @param {number} [opts.maxDownloads]
     * @param {boolean} [opts.singleUse]
     * @param {boolean} [opts.public]
     * @param {boolean} [opts.encrypt=true]
     * @returns {Promise<{ id:string, key:(string|null), shareUrl:string, downloadUrl:string,
     *   expiresAt:number, ownerToken?:string, passwordProtected:boolean }>}
     */
    async createShare(blob, opts = {}) {
        const encrypt = opts.encrypt !== false;
        const filename = opts.filename || blob.name || 'file';
        const contentType = blob.type || 'application/octet-stream';

        let body;
        let key = null;
        let metadata;
        if (encrypt) {
            const cryptoKey = await CryptoEngine.generateKey();
            body = await CryptoEngine.encryptBlob(cryptoKey, blob); // ArrayBuffer [IV||ct||tag]
            key = await CryptoEngine.exportKey(cryptoKey);
            metadata = { encrypted: 'aes-256-gcm' };
        } else {
            // Sliced read (not blob.arrayBuffer()) so large mobile files don't throw
            // NotReadableError. See transfer/blobReader.js.
            body = await readBlobToArrayBuffer(blob);
        }
        const size = body.byteLength;

        const created = await this._json('POST', '/links', {
            filename, size, contentType,
            visibility: opts.public ? 'public' : 'temp',
            expiresIn: opts.expiresIn,
            password: opts.password || undefined,
            maxDownloads: opts.maxDownloads,
            singleUse: Boolean(opts.singleUse),
            metadata,
        });

        const putRes = await this._fetch(`${this.apiBase}/links/${created.id}/content`, {
            method: 'PUT',
            headers: { 'x-upload-token': created.uploadToken, 'content-type': 'application/octet-stream' },
            body,
        });
        if (!putRes.ok) throw await this._error(putRes);

        const shareUrl = key
            ? `${this._viewerOrigin}?s=${created.id}#k=${key}`
            : `${this._viewerOrigin}?s=${created.id}`;

        return {
            id: created.id,
            key,
            shareUrl,
            downloadUrl: created.downloadUrl,
            expiresAt: created.expiresAt,
            ownerToken: created.ownerToken,
            passwordProtected: Boolean(created.passwordProtected),
        };
    }

    /** Public metadata for a link (filename, size, status, passwordProtected, …). */
    async getMeta(id) {
        return this._json('GET', `/links/${encodeURIComponent(id)}`);
    }

    /**
     * Download a link's bytes and decrypt if a key is supplied.
     * @param {string} id
     * @param {{ key?:string, password?:string }} [opts]
     * @returns {Promise<{ blob: Blob, filename: string }>}
     */
    async download(id, { key, password } = {}) {
        let meta = null;
        try { meta = await this.getMeta(id); } catch { /* may be password-gated metadata-less */ }

        const headers = {};
        if (password != null) headers['x-share-password'] = password;
        const res = await this._fetch(`${this.apiBase}/links/${encodeURIComponent(id)}/download`, { headers });
        if (!res.ok) throw await this._error(res);

        const buf = await res.arrayBuffer();
        const filename = meta?.filename || `${id}.bin`;
        if (key) {
            const cryptoKey = await CryptoEngine.importKey(key);
            const plain = await CryptoEngine.decryptChunk(cryptoKey, buf); // throws on wrong key / tamper
            return { blob: new Blob([plain], { type: meta?.contentType || 'application/octet-stream' }), filename };
        }
        return { blob: new Blob([buf], { type: meta?.contentType || 'application/octet-stream' }), filename };
    }

    async revoke(id, ownerToken) {
        const headers = {};
        if (ownerToken) headers['x-owner-token'] = ownerToken;
        return this._json('DELETE', `/links/${encodeURIComponent(id)}`, undefined, headers);
    }

    // ── internals ──
    async _json(method, path, bodyObj, extraHeaders = {}) {
        const headers = { ...extraHeaders };
        let body;
        if (bodyObj !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(bodyObj); }
        const res = await this._fetch(`${this.apiBase}${path}`, { method, headers, body });
        if (!res.ok) throw await this._error(res);
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async _error(res) {
        let data = {};
        try { data = JSON.parse(await res.text()); } catch { /* noop */ }
        const e = data?.error || {};
        const err = new Error(e.message || `HTTP ${res.status}`);
        err.code = e.code || 'HTTP_ERROR';
        err.status = res.status;
        return err;
    }
}

/** Parse `?s=<id>` + `#k=<key>` from a viewer URL (or the current location). */
export function parseShareViewerUrl(href = (typeof location !== 'undefined' ? location.href : '')) {
    try {
        const u = new URL(href);
        const id = u.searchParams.get('s');
        if (!id || !/^[a-f0-9]{32}$/.test(id)) return null;
        const m = (u.hash || '').match(/[#&]k=([A-Za-z0-9_-]+)/);
        return { id, key: m ? m[1] : null };
    } catch {
        return null;
    }
}
