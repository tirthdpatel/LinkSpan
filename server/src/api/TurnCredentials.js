/**
 * TurnCredentialProvider — issues short-lived TURN credentials to clients.
 *
 * Why: static TURN username/credential pairs baked into the client bundle are public —
 * anyone can lift them from the JS and burn the relay quota. Ephemeral credentials are
 * minted server-side on demand and expire, so the browser bundle carries no TURN secret.
 *
 * Two providers, selected by environment:
 *
 *   cloudflare     CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN set.
 *                  Calls Cloudflare's TURN key API (free tier: 1 TB/month relayed) to
 *                  generate ICE servers with a TTL. Responses are cached until ~75% of
 *                  the TTL has elapsed so one popular page doesn't hammer the CF API.
 *
 *   static-secret  TURN_STATIC_SECRET + TURN_URLS set (self-hosted coturn with
 *                  `use-auth-secret`/`static-auth-secret`, e.g. the coturn/ compose
 *                  service). Credentials are computed locally per the TURN REST API
 *                  convention: username = "<unixExpiry>:linkspan", credential =
 *                  base64(HMAC-SHA1(secret, username)). No network call, no cache needed.
 *
 *   disabled       Neither configured. getIceServers() resolves { iceServers: [], ttl: 0 }
 *                  and the client falls back to STUN-only (+ its own WS relay fallback).
 *
 * The route handler never exposes provider errors to clients — a Cloudflare outage
 * degrades to the disabled response rather than a 5xx, because TURN is an optimization,
 * not a requirement (the app still connects via STUN or the server relay).
 */

import crypto from 'node:crypto';

const CLOUDFLARE_TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const DEFAULT_TTL_SECONDS = 7200; // 2h — outlives any realistic pairing + transfer
const CACHE_FRACTION = 0.75;      // reuse a minted credential until 75% of its TTL is spent

export class TurnCredentialProvider {
    /**
     * @param {object} [opts]
     * @param {object} [opts.env]        env source (defaults to process.env)
     * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
     * @param {number} [opts.ttlSeconds]
     */
    constructor({ env = process.env, fetchImpl, ttlSeconds } = {}) {
        this._fetch = fetchImpl || globalThis.fetch?.bind(globalThis);
        this.ttlSeconds = ttlSeconds
            || Number.parseInt(env.TURN_CRED_TTL_SECONDS || '', 10)
            || DEFAULT_TTL_SECONDS;

        this._cfKeyId = env.CLOUDFLARE_TURN_KEY_ID || '';
        this._cfToken = env.CLOUDFLARE_TURN_API_TOKEN || '';
        this._staticSecret = env.TURN_STATIC_SECRET || '';
        this._staticUrls = (env.TURN_URLS || '')
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean);

        if (this._cfKeyId && this._cfToken) this.mode = 'cloudflare';
        else if (this._staticSecret && this._staticUrls.length) this.mode = 'static-secret';
        else this.mode = 'disabled';

        /** @type {{ iceServers: object[], ttl: number, expiresAt: number } | null} */
        this._cache = null;
        /** @type {Promise<object> | null} in-flight fetch, deduped across concurrent requests */
        this._pending = null;
    }

    get enabled() {
        return this.mode !== 'disabled';
    }

    /**
     * Mint (or reuse) TURN credentials.
     * Never rejects — provider failures degrade to the disabled shape.
     * @returns {Promise<{ iceServers: object[], ttl: number }>}
     */
    async getIceServers() {
        if (this.mode === 'disabled') return { iceServers: [], ttl: 0 };
        if (this.mode === 'static-secret') return this._staticSecretServers();

        // cloudflare — serve from cache while the minted credential is still fresh
        if (this._cache && Date.now() < this._cache.expiresAt) {
            return { iceServers: this._cache.iceServers, ttl: this._cache.ttl };
        }
        if (!this._pending) {
            this._pending = this._fetchCloudflare()
                .catch((err) => {
                    console.error('[TurnCredentials] Cloudflare credential fetch failed:', err.message);
                    return { iceServers: [], ttl: 0 };
                })
                .finally(() => { this._pending = null; });
        }
        return this._pending;
    }

    async _fetchCloudflare() {
        const url = `${CLOUDFLARE_TURN_API_BASE}/${this._cfKeyId}/credentials/generate-ice-servers`;
        const res = await this._fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this._cfToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ttl: this.ttlSeconds }),
        });
        if (!res.ok) throw new Error(`Cloudflare TURN API responded ${res.status}`);
        const body = await res.json();

        // Normalize: generate-ice-servers returns an array; the older generate
        // endpoint returns a single object. Accept both.
        let servers = body.iceServers ?? [];
        if (!Array.isArray(servers)) servers = [servers];
        servers = servers.filter((s) => s && s.urls);
        if (!servers.length) throw new Error('Cloudflare TURN API returned no iceServers');

        this._cache = {
            iceServers: servers,
            ttl: this.ttlSeconds,
            expiresAt: Date.now() + this.ttlSeconds * 1000 * CACHE_FRACTION,
        };
        return { iceServers: servers, ttl: this.ttlSeconds };
    }

    _staticSecretServers() {
        // TURN REST API convention (as implemented by coturn's use-auth-secret):
        // the username embeds the expiry; the credential is an HMAC over it, so
        // coturn can verify without a user database.
        const expiry = Math.floor(Date.now() / 1000) + this.ttlSeconds;
        const username = `${expiry}:linkspan`;
        const credential = crypto
            .createHmac('sha1', this._staticSecret)
            .update(username)
            .digest('base64');
        return {
            iceServers: [{ urls: this._staticUrls, username, credential }],
            ttl: this.ttlSeconds,
        };
    }
}
